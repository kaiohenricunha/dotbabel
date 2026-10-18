/** Offline plugin baseline consumer; canonical sources and reviewed release facts stay separate. */
import { materializeClaude } from "./claude.mjs";
import { snapshotCatalog, validateSnapshot } from "../../snapshot/core.mjs";
import { mergePolicy, SHIPPED_POLICY } from "../../policy/index.mjs";
import { parseProjectionSource } from "../render.mjs";

/**
 * Project release baselines through the shared resolver and native emitter without discovery.
 * Legacy selectors remain exact compatibility pins until their separate approved migration.
 * @param {{toolVersion:string,snapshot:object,artifacts:object[]}} inputs Accepted release evidence and original authored bytes.
 * @returns {{files:object[],manifest:object}} Native projections with immutable snapshot provenance.
 */
export function buildClaudeBaseline({ toolVersion, snapshot, artifacts }) {
  validateSnapshot(snapshot);
  const context = { catalog: snapshotCatalog(snapshot), policy: mergePolicy({ shipped: SHIPPED_POLICY }), runtimeContract: snapshot.runtimes.claude.runtimeContract };
  return materializeClaude({ toolVersion, context, artifacts: artifacts.map(artifact => {
    const source = parseProjectionSource(artifact);
    const legacy = source.frontmatter;
    const kind = artifact.target.artifactKind;
    const legacyAxes = source.requirement === null && kind !== "skill" && legacy.model !== undefined && legacy.model !== "inherit" ? { model: legacy.model, ...(kind === "agent" && legacy.effort !== undefined ? { reasoning: legacy.effort } : {}) } : undefined;
    return { ...artifact, snapshotId: snapshot.snapshotId, releaseBaseline: true, ...(legacyAxes ? { legacyAxes } : {}) };
  }) });
}
