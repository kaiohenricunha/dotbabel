/** Claude Mods boundary. This module uses no Node API, native settings write, or model call. */
import { prepareClaudeRoute } from "./claude-mod-prepare.mjs";
const opaque = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !value.startsWith("-") && !/[\p{Cc}\p{Cf}]/u.test(value);
const preserved = code => ({ status: "preserved", diagnostics: [{ code }] });
async function report($, value) {
  try { await $.ui.log(JSON.stringify({ envelope: "ClaudeRouting", version: 1, ...value })); }
  catch { /* Display never causes a replay. */ }
}

/**
 * Register MAIN-only native middleware with an injected shared-resolver preparation boundary.
 * The engine owns input, attachments, history, tools, permission checks and every provider request.
 * Native results and stream chunks pass through once. A binding conflict answers locally without
 * executing a below-floor provider request; a failed preparation preserves native configuration.
 * @param {Function} on Native Mods event registration.
 * @param {{prepare?:Function,manual?:object,socketPath?:string,freshSession?:boolean}} options Trusted preparation and initial axis provenance.
 * @returns {void}
 */
export function registerClaudeRouting(on, options) {
  const preparation = { ...options, state: {} };
  let active;
  let uncertainMedia = false;
  let priorFailures = 0;
  let current = { axes: {}, ...(options.freshSession === true ? { turnExecuted: false } : {}) };
  const manual = { model: { source: "unknown" }, reasoning: { source: "unknown" }, ...options.manual };
  const revision = { model: 0, reasoning: 0 };
  const chooseManual = (axis, value, source = "manual") => { manual[axis] = { source, ...(opaque(value) ? { value } : {}) }; revision[axis]++; };

  on("prompt.submit", async ($, e, next) => {
    // Only inspect opaque attachment kinds. The engine retains every byte and original field.
    if (e.attachments?.some(attachment => !["image"].includes(attachment.type))) uncertainMedia = true;
    return next(e);
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    active = { id: e.turnId, prompt: e.text, root: undefined, prepared: false, changes: {}, revision: { ...revision } };
    try { active.root = await $.session.root(); } catch { /* Unknown root preserves native state. */ }
    return next(e);
  });

  on("classic.SessionStart", async ($, e, next) => {
    if (e.agent_id === undefined && e.source !== "startup") current = { axes: {}, ...(e.source === "clear" ? { turnExecuted: false } : {}) };
    return next(e);
  });

  on("classic.PostModelSwitch", async ($, e, next) => {
    const result = await next(e);
    if (e.agent_id === undefined && ["command", "picker", "sdk"].includes(e.source)) chooseManual("model", e.to_model);
    if (e.agent_id === undefined && e.source === "auto" && active?.prepared) {
      active.changes = {};
      active.decision = preserved("native_model_rerouted");
    }
    return result;
  });
  on("config.set", async ($, e, next) => {
    const result = await next(e);
    if (!result.deny && e.origin?.kind !== "plugin") {
      if (e.key === "model") chooseManual("model", undefined, "unknown");
      if (["effort", "effortLevel", "thinking"].includes(e.key)) chooseManual("reasoning", result.value, opaque(result.value) ? "manual" : "unknown");
    }
    return result;
  });
  on("command.run", async ($, e, next) => {
    if (["resume", "fork", "compact"].includes(e.command)) current = { axes: {} };
    // A picker can select the same value. Record intent even when no value-change event fires.
    if (["model", "effort"].includes(e.command) && !(e.command === "effort" && e.args.trim() === "status") && e.origin?.kind !== "plugin") {
      chooseManual(e.command === "model" ? "model" : "reasoning", undefined, "unknown");
      if (e.command === "model" && !e.args.trim()) chooseManual("reasoning", undefined, "unknown");
    }
    return next(e);
  });
  on("classic.ConfigChange", async ($, e, next) => {
    if (e.agent_id === undefined) for (const axis of ["model", "reasoning"]) chooseManual(axis, undefined, "unknown");
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined || active?.id !== e.turnId) return yield* next(e);
    const turn = active;
    let root;
    try { root = await $.session.root(); } catch { /* A missing root cannot authorize a route. */ }
    if (!root || root !== turn.root || turn.projectChanged) {
      turn.projectChanged = true;
      await report($, { status: "preserved", diagnostics: [{ code: "active_project_changed" }], effective: { state: "unknown" } });
      return yield* next(e);
    }
    if (!turn.prepared) {
      turn.prepared = true;
      const axes = { model: e.model, ...(typeof e.effort === "string" ? { reasoning: e.effort } : {}) };
      try {
        const before = { ...revision };
        turn.decision = uncertainMedia ? preserved("input_modality_unverified") : e.index !== 0 ? preserved("turn_boundary_unverified") : await prepareClaudeRoute($, { repoRoot: root, prompt: turn.prompt, context: { priorFailures }, nativeAxes: axes, current: { ...current, axes: current.turnExecuted === true ? { ...current.axes } : axes }, manual: structuredClone(manual) }, preparation);
        if (turn.decision.manual) for (const axis of ["model", "reasoning"]) if (before[axis] === revision[axis]) manual[axis] = turn.decision.manual[axis];
      } catch { turn.decision = preserved("routing_preparation_failed"); }
      // Do not retain prompt text after the one bounded preparation call.
      turn.prompt = undefined;
      turn.revision = { ...revision };
      if (["proposed", "preserved"].includes(turn.decision?.status)) for (const axis of ["model", "reasoning"]) {
        const value = turn.decision.configuration?.axes?.[axis] ?? turn.decision.changes?.[axis];
        if (manual[axis].source === "inherited" && opaque(value)) turn.changes[axis] = value;
      }
    }
    try { root = await $.session.root(); } catch { root = undefined; }
    if (!root || root !== turn.root) {
      turn.projectChanged = true;
      return yield* next(e);
    }
    const decision = turn.decision ?? preserved("routing_preparation_failed");
    if (decision.status === "blocked") {
      const code = decision.diagnostics?.find(item => /^[a-z][a-z0-9_]{0,100}$/.test(item.code))?.code ?? "resolution_unavailable";
      const answer = `Routing blocked: ${code}. No model request was sent.`;
      await report($, { status: "blocked", diagnostics: [{ code }], effective: { state: "unknown" } });
      yield { kind: "text", index: 0, text: answer };
      return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: "end_turn", usage: null };
    }
    const request = { ...e };
    for (const [axis, key] of [["model", "model"], ["reasoning", "effort"]]) if (turn.revision[axis] === revision[axis] && turn.changes[axis] !== undefined) request[key] = turn.changes[axis];
    // classic.Stop reports the session effort setting (#572), which no longer describes a rewritten request.
    if (request.effort !== e.effort) turn.effortRewritten = true;
    const intended = { model: request.model, ...(typeof request.effort === "string" ? { reasoning: request.effort } : {}) };
    await report($, { status: decision.status, confidence: decision.confidence, diagnostics: decision.diagnostics ?? [], intended, accepted: { state: "unknown" }, effective: { state: "unknown" } });
    const result = yield* next(request);
    const model = result.usage?.model;
    const effective = opaque(model) ? { state: "observed", axes: { model }, source: "turn.step:usage.model" } : { state: "unknown" };
    // A native fallback is an observed substitution, never a reason to force the old model again.
    if (opaque(model) && model !== request.model) { turn.changes = {}; turn.decision = preserved("native_model_rerouted"); await report($, { status: "preserved", diagnostics: [{ code: "native_model_rerouted" }], effective }); }
    turn.effective = effective;
    current = { axes: effective.axes ?? {}, ...(opaque(model) ? { turnExecuted: true } : {}) };
    await report($, { status: turn.decision.status, intended, accepted: { state: "unknown" }, effective });
    return result;
  }).catch(async function* ($, e) {
    const answer = "Routing interrupted. No automatic retry was made. Inspect the native session before continuing.";
    await report($, { status: "interrupted", diagnostics: [{ code: "native_routing_interrupted" }], effective: { state: "unknown" } });
    yield { kind: "text", index: 0, text: answer };
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: "end_turn", usage: null };
  });

  on("classic.Stop", async ($, e, next) => {
    if (e.agent_id === undefined && active?.effective?.state === "observed" && !active.effortRewritten && opaque(e.effort?.level)) {
      active.effective = { ...active.effective, axes: { ...active.effective.axes, reasoning: e.effort.level }, reasoningSource: "classic.Stop:effort.level" };
      current.axes.reasoning = e.effort.level;
      await report($, { status: "observed", effective: active.effective });
    }
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && active?.id === e.turnId) { priorFailures = e.reason === "error" ? Math.min(20, priorFailures + 1) : e.reason === "answer" ? 0 : priorFailures; active = undefined; }
    return result;
  });
}
