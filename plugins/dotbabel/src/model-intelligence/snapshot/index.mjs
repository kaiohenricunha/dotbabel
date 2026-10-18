/** Serialized snapshot I/O and explicit native source collection, separate from pure release facts. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observe as observeClaude } from "../sources/runtime/claude.mjs";
import { resolveTimeoutMs } from "../sources/contract.mjs";
import { openProjectionTree } from "../materialize/projection-fs.mjs";
import { acquireLock } from "../../lib/process-lock.mjs";
import { createSnapshot, validateSnapshot, releaseSnapshotStatus, releaseSourceFor, checkReleaseRequirements, serializeSnapshot } from "./core.mjs";
export { createSnapshot, validateSnapshot, snapshotCatalog, releaseSnapshotStatus, checkReleaseRequirements, serializeSnapshot } from "./core.mjs";

/** One published, source-controlled release input. */
export const DEFAULT_SNAPSHOT_PATH = fileURLToPath(new URL("./release-capabilities.json", import.meta.url));
const fail = code => Object.assign(new Error(code), { code });
const RESERVED_DESTINATIONS = new Set([".dotbabel-projection.lock", ".dotbabel-projection.json", ".dotbabel-projection.pending.json", ".dotbabel-claude-companions.json"]);
function snapshotLocation(file) {
  const target = path.resolve(file); const name = path.basename(target);
  if (RESERVED_DESTINATIONS.has(name)) throw fail("snapshot_destination_reserved");
  return { root: path.dirname(target), name };
}

/** @param {string} [file] Snapshot location. @returns {object} Validated offline release data. */
export function readSnapshot(file = DEFAULT_SNAPSHOT_PATH) {
  const { root, name } = snapshotLocation(file); const tree = openProjectionTree(root);
  try { const text = tree.read(name); if (text === null) throw fail("snapshot_unavailable"); let data; try { data = JSON.parse(text); } catch { throw fail("snapshot_invalid"); } return validateSnapshot(data); }
  finally { tree.close(); }
}

/**
 * Collect and validate a complete candidate under the shared descriptor-anchored tree lock.
 * Failure never replaces the committed file; the default reports a diff without writing.
 * @param {{file?:string,collect:Function,write?:boolean,now?:string,requirements?:object[],policy?:object}} options Explicit source collector and destination.
 * @returns {Promise<object>} Candidate and previous identities, changed/written state and serialized diff.
 */
export async function updateSnapshot({ file = DEFAULT_SNAPSHOT_PATH, collect, write = false, now, requirements = [], policy } = {}) {
  const { root, name } = snapshotLocation(file); const tree = openProjectionTree(root); let lock;
  try {
    lock = acquireLock(tree.lockPath, { resource: "release-snapshot" }); if (!lock.acquired) throw fail("snapshot_locked");
    const previous = tree.read(name);
    const snapshot = createSnapshot(await collect());
    if (!checkReleaseRequirements(snapshot, requirements, policy).valid) throw fail("release_requirement_unsatisfied");
    const status = releaseSnapshotStatus(snapshot, { now: now ?? new Date().toISOString() }); if (!status.valid) throw fail(status.reason);
    const content = serializeSnapshot(snapshot);
    const changed = previous !== content;
    if (write && changed) tree.write(name, content, { expected: previous, exclusive: previous === null });
    return { snapshot, changed, written: write && changed, before: previous, after: content };
  } finally { if (lock?.acquired) lock.release(); tree.close(); }
}


/**
 * Revalidate committed Claude selectors through its isolated zero-inference source adapter.
 * Other accepted source dates remain unchanged; this cannot renew old documentation evidence.
 * A changed runtime version or alias mapping needs newly reviewed release evidence.
 * @param {object} seed Validated committed snapshot supplying exact accepted selectors and contract.
 * @param {{observe?:Function,timeoutMs?:number,monotonic?:Function}} [options] Trusted source handle, injectable for contract tests.
 * @returns {Promise<object>} Candidate facts, with only genuinely reobserved source dates updated.
 */
export async function collectReleaseEvidence(seed, { observe = observeClaude, timeoutMs, monotonic = () => performance.now() } = {}) {
  validateSnapshot(seed); const next = structuredClone(seed);
  // Additional runtimes need their own verified collector before they can become release consumers.
  if (Object.keys(next.runtimes).some(id => id !== "claude")) throw fail("release_source_unsupported");
  const budget = resolveTimeoutMs({ channel: "subprocess", timeoutMs }); const started = monotonic();
  const runtime = next.runtimes.claude; const observations = [];
  for (const model of runtime.models) {
    const remaining = Math.floor(budget - (monotonic() - started));
    if (remaining <= 0) throw fail("release_source_timeout");
    const observed = await observe({ model: model.model, timeoutMs: remaining });
    const canonical = model.fields.canonicalModel?.[0]?.value ?? model.model;
    if (observed?.status !== "ok" || observed.evidence?.turnExecuted !== false || observed.evidence.axes?.model !== canonical || observed.evidence.runtimeVersion !== runtime.provenance.sourceVersion || ["sourceId", "sourceKind", "sourceVersion", "adapterVersion"].some(key => observed.provenance?.[key] !== runtime.provenance[key]) || !Number.isFinite(Date.parse(observed.observedAt))) throw fail("release_source_unavailable");
    observations.push(observed.observedAt);
  }
  // The oldest observation bounds a batch that does not occur at one instant.
  const source = releaseSourceFor(next, runtime.provenance); source.observedAt = observations.sort()[0];
  return next;
}
