/** Native resolver-input loading for an explicitly enabled managed Codex session. No selection occurs here. */
import { loadPolicyLayers, mergePolicy } from "../policy/index.mjs";
import { buildCatalog, deriveFreshness, freshnessPolicyFor } from "../catalog/index.mjs";
import * as codex from "../sources/runtime/codex.mjs";
import { makeAdapterResult } from "../sources/contract.mjs";
import { makeDiscoveryEvidence, makeModelFact } from "../sources/evidence.mjs";

/**
 * Create a session-local input loader. Discovery remains local and uses the shared freshness policy.
 * Native model-list eligibility is checked on every call; no provider/model registry is copied.
 * @param {object} options Native rpc and optional discover/now dependencies.
 * @returns {Function} Async repoRoot-to-resolver-input loader, never a resolver result.
 */
export function createCodexSessionInputLoader(options) {
  let discovered;
  const now = options.now ?? (() => new Date().toISOString());
  const policy = freshnessPolicyFor(codex);
  return async repoRoot => {
    if (!discovered || deriveFreshness({ observedAt: discovered.observedAt, policy, now: now() }) !== "fresh") {
      const next = await (options.discover ?? codex.discover)({ cwd: repoRoot });
      if (next.status !== "ok") throw Object.assign(new Error("capability_evidence_unavailable"), { code: "capability_evidence_unavailable" });
      discovered = next;
    }
    const listing = await options.rpc.request("model/list", { includeHidden: true });
    const visibility = new Map(listing.data.map(model => [model.model, model.hidden === false ? "listed" : model.hidden === true ? "hidden" : "unknown"]));
    const freshness = deriveFreshness({ observedAt: discovered.observedAt, policy, now: now() });
    const loaded = buildCatalog([{ result: discovered, freshness, refresh: "idle" }]);
    const selection = makeAdapterResult({ status: "ok", provenance: discovered.provenance, observedAt: now(), evidence: makeDiscoveryEvidence({ models: discovered.evidence.models.map(model => makeModelFact({ id: model.id, supportedReasoningLevels: [], selectionVisibility: visibility.get(model.id) ?? "unknown" })) }) });
    const current = buildCatalog([{ result: selection, freshness: "fresh", refresh: "idle" }]);
    const selectionFields = new Map(current.runtimes.flatMap(runtime => runtime.models.map(model => [model.model, model.fields.selectionVisibility])));
    const catalog = { ...loaded, runtimes: loaded.runtimes.map(runtime => ({ ...runtime, models: runtime.models.map(model => ({ ...model, fields: { ...model.fields, selectionVisibility: selectionFields.get(model.model) } })) })) };
    const { shipped, user, project } = loadPolicyLayers({ repoRoot });
    return { policy: mergePolicy({ shipped, user, project }), catalog, target: { runtimeId: "codex", artifactKind: "workflow" }, runtimeContract: codex.descriptor };
  };
}
