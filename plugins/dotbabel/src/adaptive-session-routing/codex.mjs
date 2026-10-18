/** Codex App Server turn boundary. This module neither owns authentication nor starts a process. */
import { prepareRoute } from "./prepare.mjs";
import { checkOpaqueValue } from "../model-intelligence/domain/index.mjs";

const validId = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const result = (status, code, extra = {}) => ({ status, effective: { state: "unknown" }, diagnostics: [{ code }], ...extra });

/**
 * Create a bounded, exactly-once submission boundary for one managed native thread.
 * The caller owns transport, native approvals, observation and session UI. No retry occurs after
 * an uncertain write; uncorrelated completion events cannot release that barrier.
 * The caller must inspect native state before creating another boundary, without replaying it.
 * The deduplication ledger lasts for this router instance; it is never evicted.
 * Up to 32 distinct pre-acknowledgement completions are retained; overflow is diagnosed.
 * Current axes and manual provenance come from that caller, never from an acknowledgement.
 * @param {object} options Thread id, project root, runtime capability, current/manual state,
 * native request function, optional preparation strategy/dependencies and bounded ledger limit.
 * @returns {{submit: Function, updateState: Function, notify: Function}} Submission, native-state updates and completion events.
 */
export function createCodexTurnRouter(options) {
  if (!validId(options?.threadId) || typeof options.request !== "function") throw new TypeError("invalid Codex routing session");
  const maxSubmissions = options.maxSubmissions ?? 1024;
  if (!Number.isSafeInteger(maxSubmissions) || maxSubmissions < 1 || maxSubmissions > 4096) throw new TypeError("invalid submission ledger limit");
  const ledger = new Map();
  let current = structuredClone(options.current);
  let manual = structuredClone(options.manual ?? {});
  let busy = false;
  let revision = 0;
  let activeTurn;
  const earlyCompletions = new Set();
  let earlyCompletionOverflow = false;
  const uncertainTurn = Symbol("uncertain native turn");

  const execute = async (original, context) => {
    earlyCompletionOverflow = false;
    try {
      for (const [axis, native] of [["model", "model"], ["reasoning", "effort"]]) {
        if (typeof original[native] === "string") manual[axis] = { source: "manual", value: original[native] };
      }
      const preparedRevision = revision;
      const request = {
        repoRoot: options.repoRoot, context, current: structuredClone(current), manual: structuredClone(manual), runtimeCapability: options.runtimeCapability,
        // Preparation reads this only after project activation and mechanism support are verified.
        get prompt() { return original.input.filter(item => item.type === "text").map(item => item.text).join("\n"); },
      };
      let decision;
      const dependencies = {
        ...options.dependencies,
        loadResolverInput: async repoRoot => {
          const modalities = original.input.map(item => {
            if (["text", "skill", "mention"].includes(item.type)) return "text";
            if (["image", "localImage"].includes(item.type)) return "image";
            throw new Error("input modality unverified");
          });
          const input = await options.dependencies.loadResolverInput(repoRoot);
          return { ...input, invocation: { ...input.invocation, requiredModalities: [...new Set([...(input.invocation?.requiredModalities ?? []), ...modalities])] } };
        },
      };
      try { decision = await (options.prepare ?? prepareRoute)(request, dependencies); }
      catch { decision = { status: "preserved", diagnostics: [{ code: "routing_preparation_failed" }] }; }
      if (revision !== preparedRevision) return result("blocked", "session_state_changed");
      if (decision?.status === "blocked") return result("blocked", "routing_blocked", { decision });
      const params = { ...original };
      const requested = Object.fromEntries([["model", original.model], ["reasoning", original.effort]].filter(([axis, value]) => value !== undefined && checkOpaqueValue(axis, value)));
      if (decision?.status === "proposed") {
        const changes = decision.changes;
        const valid = changes !== null && typeof changes === "object" && !Array.isArray(changes) && Object.entries(changes).every(([axis, value]) => ["model", "reasoning"].includes(axis) && options.runtimeCapability?.support === "supported" && options.runtimeCapability.axes?.[axis] === "supported" && checkOpaqueValue(axis, value));
        if (valid) {
          for (const [axis, native] of [["model", "model"], ["reasoning", "effort"]]) {
            const value = manual[axis]?.source === "manual" ? manual[axis].value ?? current?.axes?.[axis] : changes[axis];
            if (value !== undefined) { params[native] = value; requested[axis] = value; }
          }
        } else decision = { status: "preserved", diagnostics: [{ code: "invalid_routing_decision" }] };
      }
      let response;
      try { response = await options.request("turn/start", params); }
      catch { activeTurn = uncertainTurn; return result("uncertain", "native_submission_unknown", { decision, requested }); }
      if (!validId(response?.turn?.id)) { activeTurn = uncertainTurn; return result("uncertain", "native_submission_unknown", { decision, requested }); }
      if (!["completed", "interrupted", "failed"].includes(response.turn.status) && !earlyCompletions.has(response.turn.id)) activeTurn = response.turn.id;
      const accepted = result("accepted", "native_submission_accepted", { decision, requested, accepted: { turnId: response.turn.id, status: response.turn.status } });
      if (earlyCompletionOverflow) accepted.diagnostics.push({ code: "native_completion_buffer_full" });
      return accepted;
    } finally { busy = false; earlyCompletions.clear(); }
  };

  return {
    submit(id, params, { context } = {}) {
      if (!validId(id)) return Promise.resolve(result("blocked", "invalid_submission_id"));
      if (ledger.has(id)) return ledger.get(id);
      if (!params || params.threadId !== options.threadId || !Array.isArray(params.input)) return Promise.resolve(result("blocked", "invalid_submission"));
      if (ledger.size >= maxSubmissions) return Promise.resolve(result("blocked", "submission_ledger_full"));
      if (busy || activeTurn !== undefined) return Promise.resolve(result("blocked", "submission_in_progress"));
      let original;
      try { original = structuredClone(params); }
      catch { return Promise.resolve(result("blocked", "invalid_submission")); }
      busy = true;
      const pending = Promise.resolve().then(() => execute(original, context));
      ledger.set(id, pending);
      return pending;
    },
    updateState(state) {
      if (state.current !== undefined) current = structuredClone(state.current);
      if (state.manual !== undefined) manual = structuredClone(state.manual);
      revision += 1;
      return true;
    },
    notify(notification) {
      const params = notification?.params;
      if (notification?.method !== "turn/completed" || params?.threadId !== options.threadId || !validId(params.turn?.id) || !["completed", "interrupted", "failed"].includes(params.turn.status)) return false;
      if (busy && !earlyCompletions.has(params.turn.id)) {
        if (earlyCompletions.size < 32) earlyCompletions.add(params.turn.id);
        else earlyCompletionOverflow = true;
      }
      if (activeTurn === params.turn.id) activeTurn = undefined;
      return true;
    },
  };
}
