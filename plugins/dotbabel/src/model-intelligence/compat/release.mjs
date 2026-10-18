/** Offline evidence loading for explicit legacy-compatibility diagnostics and migrations. */
import { readSnapshot, snapshotCatalog } from "../snapshot/index.mjs";
import { loadPolicyLayers, mergePolicy } from "../policy/index.mjs";

/**
 * Load accepted release capability facts and current policy without discovery or inference.
 * Accepted release eligibility is used only to assess retained-selector structural compatibility;
 * ordinary runtime selection still requires its independent live/cached availability evidence.
 * @param {string} repoRoot Explicit project root.
 * @returns {object|undefined} Resolver context, or no proof when accepted inputs are unavailable.
 */
export function loadCompatibilityContext(repoRoot) {
  try {
    const snapshot = readSnapshot(); const { shipped, user, project } = loadPolicyLayers({ repoRoot });
    return { snapshotId: snapshot.snapshotId, catalog: snapshotCatalog(snapshot), policy: mergePolicy({ shipped, user, project }), runtimeContract: snapshot.runtimes.claude.runtimeContract };
  } catch { return undefined; }
}
