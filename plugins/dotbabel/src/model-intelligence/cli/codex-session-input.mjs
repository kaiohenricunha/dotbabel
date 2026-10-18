/** Native resolver-input loading for an explicitly enabled managed Codex session. No selection occurs here. */
import { loadPolicyLayers, mergePolicy } from "../policy/index.mjs";
import { buildCatalog, deriveFreshness, freshnessPolicyFor } from "../catalog/index.mjs";
import * as codex from "../sources/runtime/codex.mjs";

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
    const visible = new Set(listing.data.filter(model => model.hidden === false).map(model => model.model));
    const freshness = deriveFreshness({ observedAt: discovered.observedAt, policy, now: now() });
    const loaded = buildCatalog([{ result: discovered, freshness, refresh: "idle" }]);
    const catalog = { ...loaded, runtimes: loaded.runtimes.map(runtime => ({ ...runtime, models: runtime.models.filter(model => visible.has(model.model)) })) };
    const { shipped, user, project } = loadPolicyLayers({ repoRoot });
    return { policy: mergePolicy({ shipped, user, project }), catalog, target: { runtimeId: "codex", artifactKind: "workflow" }, runtimeContract: codex.descriptor };
  };
}
