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
  for (const [path, entry] of Object.entries(value.entries)) {
    if (!isProjectionPath(path) || [MANIFEST, PENDING, ".dotbabel-projection.lock"].includes(path) || !isProjectionPath(entry?.sourcePath) || !["projectionId", "sourceHash", "inputsHash", "outputHash", "resolverResultHash", "runtimeContractHash"].every(key => digest(entry[key]))) throw fail("projection_manifest_invalid");
  }
  return value;
}
function owned(content, entry) {
  return content !== null && entry !== undefined && content.split("\n", 3)[1] === `# dotbabel:generated projection=${entry.projectionId} source=${entry.sourcePath} — do not edit directly`;
}
function state(tree, expected, previous, pending) {
  const paths = [...new Set([...Object.keys(previous?.entries ?? {}), ...Object.keys(pending?.entries ?? {}), ...Object.keys(expected.entries)])].sort();
  return paths.map(path => {
    const content = tree.read(path); const before = previous?.entries[path]; const next = expected.entries[path];
    return { path, state: classifyDrift({ previous: before, expected: next, ...(content === null ? {} : { outputHash: hashContent(content) }) }), content, before, next };
  });
}
function assertOwned(entry, pending) {
  if (entry.content === null) return;
  const recorded = owned(entry.content, entry.before) ? entry.before : pending?.entries[entry.path];
  if (!owned(entry.content, recorded)) throw fail("projection_not_owned");
  if (hashContent(entry.content) !== recorded.outputHash) throw fail("projection_output_drift");
}

/**
 * Read canonical inputs only after acquiring the tree lock; generate every file, then commit its manifest.
 * Refuse user/output drift. Recover interrupted owned writes from a bounded pending-generation manifest.
 * @param {{root: string, loadInputs: Function, onStep?: Function}} options Trusted canonical loader and optional fault/observation hook.
 * @returns {Promise<object>} synced or busy, with deterministic manifest and pre-write drift entries.
 */
export async function syncProjectionTree({ root, loadInputs, onStep }) {
  const tree = openProjectionTree(root); let lock;
  try {
    lock = acquireLock(tree.lockPath, { resource: "projection-tree" });
    if (!lock.acquired) return { status: "busy", reason: lock.reason };
    const previous = parseManifest(tree.read(MANIFEST)); const pending = parseManifest(tree.read(PENDING));
    const batch = materialize(await loadInputs()); parseManifest(JSON.stringify(batch.manifest));
    const entries = state(tree, batch.manifest, previous, pending);
    entries.forEach(entry => assertOwned(entry, pending));
    tree.write(PENDING, canonicalJson(batch.manifest) + "\n");
    for (const entry of entries) {
      const current = tree.read(entry.path);
      if (current !== entry.content) throw fail("projection_output_drift");
      if (entry.next === undefined) tree.remove(entry.path);
      else {
        const file = batch.files.find(file => file.path === entry.path);
        if (current !== file.content) tree.write(entry.path, file.content, { exclusive: current === null });
      }
      await onStep?.({ kind: "file", path: entry.path });
    }
    for (const file of batch.files) if (hashContent(tree.read(file.path) ?? "") !== batch.manifest.entries[file.path].outputHash) throw fail("projection_output_drift");
    tree.write(MANIFEST, canonicalJson(batch.manifest) + "\n");
    await onStep?.({ kind: "manifest" });
    tree.remove(PENDING);
    return { status: "synced", manifest: batch.manifest, entries: entries.map(({ path, state }) => ({ path, state })) };
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
    const pending = parseManifest(tree.read(PENDING));
    const entries = state(tree, batch.manifest, previous, pending).map(({ path, state }) => ({ path, state }));
    if (readLockOwner(tree.lockPath) !== undefined || original !== tree.read(MANIFEST)) return { status: "busy", entries: [] };
    return { status: pending !== null ? "incomplete" : entries.every(entry => entry.state === "clean") ? "clean" : "drift", manifest: batch.manifest, entries };
  } finally { tree.close(); }
}
