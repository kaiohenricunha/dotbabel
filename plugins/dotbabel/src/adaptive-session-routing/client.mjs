/** Managed MAIN client. The native process retains authentication, tools, approvals and sandbox policy. */
import { readProjectActivation } from "../model-intelligence/activation/index.mjs";
import { createCodexSessionInputLoader } from "../model-intelligence/cli/codex-session-input.mjs";
import { checkOpaqueValue } from "../model-intelligence/domain/index.mjs";
import { makeObservedConfiguration, toProviderId } from "../model-intelligence/sources/evidence.mjs";
import { createCodexRpcTransport } from "./codex-rpc.mjs";
import { createCodexTurnRouter } from "./codex.mjs";

const fail = code => Object.assign(new Error(code), { code });
const axisValue = (axis, value) => typeof value === "string" && checkOpaqueValue(axis, value);

function manualAxes(config, options) {
  return Object.fromEntries([["model", "model", "model"], ["reasoning", "model_reasoning_effort", "effort"]].map(([axis, key, option]) => {
    const chosen = options[option];
    if (chosen === "auto") return [axis, { source: "inherited" }];
    if (chosen !== undefined) {
      if (!axisValue(axis, chosen)) throw fail("session_axis_invalid");
      return [axis, { source: "manual", value: chosen }];
    }
    const value = config.config?.[key];
    if (value === undefined || value === null) return [axis, { source: "inherited" }];
    const origin = config.origins?.[key]?.name?.type;
    return [axis, { source: ["user", "project", "sessionFlags"].includes(origin) ? "manual" : "unknown", ...(axisValue(axis, value) ? { value } : {}) }];
  }));
}

/**
 * Open one explicitly enabled project's managed Codex App Server session.
 * Model/effort options select an explicit native value or `auto` per axis. Absent options preserve
 * native user/project selections; unknown provenance stays conservative. No global setting changes.
 * The caller displays native events and answers native approval requests. No missing handler approves.
 * @param {object} options repoRoot, optional model/effort, onEvent, onServerRequest and completionTimeoutMs.
 * @param {object} [dependencies] Testable transport, activation, preparation and resolver-input loaders.
 * @returns {Promise<object>} Native session metadata, exactly-once submit, and close.
 */
export async function openCodexSession(options, dependencies = {}) {
  const activation = await (dependencies.readActivation ?? readProjectActivation)(options.repoRoot);
  if (activation.enabled !== true || activation.routingEnabled !== true) throw fail("routing_disabled");
  const timeoutMs = options.completionTimeoutMs ?? 600000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 43200000) throw fail("session_timeout_invalid");
  const rpc = (dependencies.createTransport ?? createCodexRpcTransport)({ cwd: options.repoRoot, onServerRequest: options.onServerRequest });
  let router, threadId, waiting, latestObservation, closed = false, busy = false, sequence = 0;
  const completions = new Map();
  const reroutes = new Set();
  rpc.onNotification(message => {
    router?.notify(message);
    if (message.params?.threadId === threadId) {
      if (message.method === "model/rerouted" && typeof message.params.turnId === "string" && reroutes.size < 32) reroutes.add(message.params.turnId);
      if (message.method === "turn/completed" && typeof message.params.turn?.id === "string") {
        const turn = message.params.turn;
        if (waiting?.id === turn.id) waiting.resolve(turn);
        else if (busy && completions.size < 32) completions.set(turn.id, turn);
      }
    }
    try { options.onEvent?.(message); } catch { /* Display failures do not replay a native request. */ }
  });
  const close = () => { if (!closed) { closed = true; waiting?.reject(fail("session_closed")); rpc.close(); completions.clear(); reroutes.clear(); } };
  try {
    const initialized = await rpc.request("initialize", { clientInfo: { name: "dotbabel-managed-session", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    const runtimeVersion = typeof initialized.userAgent === "string" ? /^dotbabel-managed-session\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(initialized.userAgent)?.[1] : undefined;
    // The checked-in native proof measures 0.163.0. Other versions remain unverified until measured.
    const support = runtimeVersion === "0.163.0" ? "supported" : "unverified";
    rpc.sendNotification("initialized", {});
    const config = await rpc.request("config/read", { cwd: options.repoRoot, includeLayers: false });
    const manual = manualAxes(config, options);
    const started = await rpc.request("thread/start", { cwd: options.repoRoot });
    threadId = started.thread?.id;
    if (typeof threadId !== "string" || !Array.isArray(started.thread.turns) || started.thread.turns.length !== 0) throw fail("session_thread_invalid");
    const axes = { model: started.model, ...(started.reasoningEffort == null ? {} : { reasoning: started.reasoningEffort }) };
    for (const [axis, selection] of Object.entries(manual)) if (selection.value !== undefined) axes[axis] = selection.value;
    const loadResolverInput = dependencies.loadResolverInput ?? createCodexSessionInputLoader({ rpc, discover: dependencies.discover, now: dependencies.now });
    router = createCodexTurnRouter({ threadId, repoRoot: options.repoRoot, current: { axes, turnExecuted: false }, manual,
      runtimeCapability: { support, axes: { model: support, reasoning: support } }, request: rpc.request,
      ...(dependencies.prepare ? { prepare: dependencies.prepare } : {}), dependencies: { readActivation: dependencies.readActivation,
        loadResolverInput: async repoRoot => ({ ...await loadResolverInput(repoRoot), observed: latestObservation }) } });
    return {
      threadId, routing: { support, mechanism: "managed-app-server", ...(runtimeVersion === undefined ? {} : { runtimeVersion }) }, native: { approvalPolicy: structuredClone(started.approvalPolicy), sandbox: structuredClone(started.sandbox) }, close,
      async submit(input) {
        if (closed) throw fail("session_closed");
        if (busy) throw fail("session_busy");
        try { if (!Array.isArray(input) || input.length === 0 || Buffer.byteLength(JSON.stringify(input)) > 1048576) throw Error(); }
        catch { throw fail("session_input_invalid"); }
        busy = true;
        try {
          const params = { threadId, input };
          for (const [axis, key] of [["model", "model"], ["reasoning", "effort"]]) if (manual[axis].source === "manual") params[key] = manual[axis].value;
          const accepted = await router.submit(`submission-${++sequence}`, params);
          if (accepted.status !== "accepted") return accepted;
          latestObservation = undefined;
          router.updateState({ current: { axes: {}, turnExecuted: true } });
          const id = accepted.accepted.turnId;
          const turn = completions.get(id) ?? await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(fail("native_completion_unknown")), timeoutMs);
            waiting = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
          });
          let effective = { state: "unknown" };
          try {
            const read = await rpc.request("thread/read", { threadId, includeTurns: false });
            const native = read.thread;
            if (turn.status === "completed" && !reroutes.has(id) && axisValue("model", native?.model)) {
              const observed = { model: native.model, ...(axisValue("reasoning", native.reasoningEffort) ? { reasoning: native.reasoningEffort } : {}) };
              const provider = toProviderId("codex", native.modelProvider);
              latestObservation = makeObservedConfiguration({ runtimeId: "codex", turnExecuted: true, configurationBasis: "as-run", axes: observed, usage: [], ...(provider === undefined ? {} : { provider }), fieldSources: { "axes.model": "thread/read:model", ...(observed.reasoning === undefined ? {} : { "axes.reasoning": "thread/read:reasoningEffort" }), ...(provider === undefined ? {} : { provider: "thread/read:modelProvider" }) } });
              effective = { state: "observed", axes: observed, source: "thread/read after turn/completed", ...(provider === undefined ? {} : { provider }) };
              router.updateState({ current: { axes: observed, turnExecuted: true } });
            }
          } catch { /* An acknowledgement never substitutes for unavailable observation. */ }
          return { ...accepted, status: turn.status, effective, ...(reroutes.has(id) ? { diagnostics: [...accepted.diagnostics, { code: "native_model_rerouted" }] } : {}) };
        } finally { busy = false; waiting = undefined; completions.clear(); reroutes.clear(); }
      },
    };
  } catch { close(); throw fail("session_initialization_failed"); }
}
