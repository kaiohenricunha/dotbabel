/** Projection-tree ownership and manifest-last transactions over pure canonical materialization. */
import { acquireLock, readLockOwner } from "../../lib/process-lock.mjs";
import { materialize } from "./index.mjs";
import { hashContent, canonicalJson } from "./manifest.mjs";
import { classifyDrift } from "./drift.mjs";
import { openProjectionTree, isProjectionPath } from "./projection-fs.mjs";

const MANIFEST = ".dotbabel-projection.json";
const PENDING = ".dotbabel-projection.pending.json";
const digest = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const fail = code => Object.assign(new Error(code), { code });

function parseManifest(text) {
  if (text === null) return null;
  let value; try { value = JSON.parse(text); } catch { throw fail("projection_manifest_invalid"); }
  if (value?.schemaVersion !== 1 || typeof value.toolVersion !== "string" || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries) || Object.keys(value.entries).length > 1024) throw fail("projection_manifest_invalid");
  for (const records of [value.entries, ...(value.retainedEntries === undefined ? [] : [value.retainedEntries])]) {
    if (!records || typeof records !== "object" || Array.isArray(records) || Object.keys(records).length > 1024) throw fail("projection_manifest_invalid");
    for (const [path, entry] of Object.entries(records)) {
      if (!isProjectionPath(path) || [MANIFEST, PENDING, ".dotbabel-projection.lock"].includes(path) || !isProjectionPath(entry?.sourcePath) || !["projectionId", "sourceHash", "inputsHash", "outputHash", "resolverResultHash", "runtimeContractHash"].every(key => digest(entry[key]))) throw fail("projection_manifest_invalid");
    }
  }
  return value;
}
function owned(content, entry) {
  return content !== null && entry !== undefined && content.split("\n", 3)[1] === `# dotbabel:generated projection=${entry.projectionId} source=${entry.sourcePath} — do not edit directly`;
}
function state(tree, expected, previous, pending) {
  const paths = [...new Set([...Object.keys(previous?.entries ?? {}), ...Object.keys(pending?.entries ?? {}), ...Object.keys(pending?.retainedEntries ?? {}), ...Object.keys(expected.entries)])].sort();
  return paths.map(path => {
    const content = tree.read(path); const before = previous?.entries[path]; const next = expected.entries[path];
    return { path, state: classifyDrift({ previous: before, expected: next, ...(content === null ? {} : { outputHash: hashContent(content) }) }), content, before, next };
  });
}
function assertOwned(entry, pending) {
  if (entry.content === null) return;
  const candidates = [entry.before, pending?.entries[entry.path], pending?.retainedEntries?.[entry.path]].filter(record => owned(entry.content, record));
  if (!candidates.length) throw fail("projection_not_owned");
  const recorded = candidates.find(record => hashContent(entry.content) === record.outputHash);
  if (!recorded) throw fail("projection_output_drift");
  return recorded;
}

/**
 * Read canonical inputs only after acquiring the tree lock; generate every file, then commit its manifest.
 * Refuse user/output drift. Recover interrupted owned writes from a bounded pending-generation manifest.
 * @param {{root: string, loadInputs: Function, onStep?: Function}} options Trusted canonical loader and optional fault/observation hook.
 * @returns {Promise<object>} synced or busy, with deterministic manifest and pre-write drift entries.
 */
export async function syncProjectionTree({ root, loadInputs, onStep }) {
  return syncProjectionBatch({ root, loadBatch: async () => materialize(await loadInputs()), onStep });
}

/**
 * Validate an already-derived release batch without treating its metadata as canonical policy.
 * @param {object} batch Files and deterministic provenance produced by the pure materializer.
 * @returns {object} The validated batch, unchanged.
 */
export function validateProjectionBatch(batch) {
  if (!batch || !Array.isArray(batch.files) || batch.files.length > 1024) throw fail("projection_batch_invalid");
  const manifest = parseManifest(JSON.stringify(batch.manifest));
  if (!manifest || manifest.retainedEntries !== undefined || Object.keys(manifest.entries).length !== batch.files.length) throw fail("projection_batch_invalid");
  const paths = new Set();
  for (const file of batch.files) {
    if (!isProjectionPath(file?.path) || paths.has(file.path) || !Object.hasOwn(manifest.entries, file.path) || typeof file.content !== "string" || Buffer.byteLength(file.content) > 4 * 1024 * 1024 || !owned(file.content, manifest.entries[file.path]) || hashContent(file.content) !== manifest.entries[file.path].outputHash) throw fail("projection_batch_invalid");
    paths.add(file.path);
  }
  return batch;
}

/**
 * Install an already-materialized release batch through the same ownership transaction.
 * Copying verified derived bytes performs no model resolution or policy adoption.
 * @param {{root:string, loadBatch:Function, onStep?:Function}} options Trusted immutable-release loader, called inside the lock.
 * @returns {Promise<object>} Synced or busy with the installed provenance manifest.
 */
export async function syncProjectionBatch({ root, loadBatch, onStep }) {
  const tree = openProjectionTree(root); let lock;
  try {
    lock = acquireLock(tree.lockPath, { resource: "projection-tree" });
    if (!lock.acquired) return { status: "busy", reason: lock.reason };
    const previousText = tree.read(MANIFEST); const pendingText = tree.read(PENDING);
    const previous = parseManifest(previousText); const pending = parseManifest(pendingText);
    const batch = validateProjectionBatch(await loadBatch());
    const entries = state(tree, batch.manifest, previous, pending);
    const retainedEntries = Object.fromEntries(entries.filter(entry => entry.content !== null).map(entry => [entry.path, assertOwned(entry, pending)]));
    if (Object.keys(retainedEntries).length > 1024) throw fail("projection_manifest_invalid");
    const result = { status: "synced", manifest: batch.manifest, entries: entries.map(({ path, state }) => ({ path, state })) };
    if (pending === null && canonicalJson(previous) === canonicalJson(batch.manifest) && entries.every(entry => entry.state === "clean")) return result;
    const journal = canonicalJson({ ...batch.manifest, retainedEntries }) + "\n";
    tree.write(PENDING, journal, { expected: pendingText, exclusive: pendingText === null });
    // Retire old targets before adding new ones, bounding live recovery ownership.
    for (const entry of [...entries.filter(entry => entry.next === undefined), ...entries.filter(entry => entry.next !== undefined)]) {
      const current = tree.read(entry.path);
      if (current !== entry.content) throw fail("projection_output_drift");
      if (entry.next === undefined) tree.remove(entry.path, { expected: current });
      else {
        const file = batch.files.find(file => file.path === entry.path);
        if (current !== file.content) tree.write(entry.path, file.content, { expected: current, exclusive: current === null });
      }
      await onStep?.({ kind: "file", path: entry.path });
    }
    for (const file of batch.files) if (hashContent(tree.read(file.path) ?? "") !== batch.manifest.entries[file.path].outputHash) throw fail("projection_output_drift");
    for (const entry of entries) if (entry.next === undefined && tree.read(entry.path) !== null) throw fail("projection_output_drift");
    tree.write(MANIFEST, canonicalJson(batch.manifest) + "\n", { expected: previousText, exclusive: previousText === null });
    await onStep?.({ kind: "manifest" });
    tree.remove(PENDING, { expected: journal });
    return result;
  } finally { if (lock?.acquired) lock.release(); tree.close(); }
}

/**
 * Inspect against canonical inputs without writing or adopting generated metadata as policy.
 * A busy tree or a generation changed during reading never reports a falsely clean status.
 * @param {{root: string, loadInputs: Function}} options Owning root and trusted canonical input loader.
 * @returns {Promise<object>} clean, drift, incomplete or busy with per-target drift states.
 */
export async function inspectProjectionTree({ root, loadInputs }) {
  const tree = openProjectionTree(root);
  try {
    if (readLockOwner(tree.lockPath) !== undefined) return { status: "busy", entries: [] };
    const original = tree.read(MANIFEST); const previous = parseManifest(original);
    const batch = materialize(await loadInputs()); parseManifest(JSON.stringify(batch.manifest));
    const pendingText = tree.read(PENDING); const pending = parseManifest(pendingText);
    const entries = state(tree, batch.manifest, previous, pending).map(({ path, state }) => ({ path, state }));
    if (readLockOwner(tree.lockPath) !== undefined || original !== tree.read(MANIFEST) || pendingText !== tree.read(PENDING)) return { status: "busy", entries: [] };
    return { status: pending !== null ? "incomplete" : entries.every(entry => entry.state === "clean") ? "clean" : "drift", manifest: batch.manifest, entries };
  } finally { tree.close(); }
}
