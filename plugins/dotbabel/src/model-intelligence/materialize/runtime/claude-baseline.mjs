/** Explicit installation of immutable Claude release projections; no project policy or resolver use. */
import fs from "node:fs";
import path from "node:path";
import { openProjectionTree } from "../projection-fs.mjs";
import { syncProjectionBatch, validateProjectionBatch } from "../transaction.mjs";
import { acquireLock } from "../../../lib/process-lock.mjs";
import { syncClaudeCompanions } from "./claude-companions.mjs";

const MANIFEST = ".dotbabel-projection.json";
const PENDING = ".dotbabel-projection.pending.json";
const LOCK = ".dotbabel-projection.lock";
const fail = code => Object.assign(new Error(code), { code });
const kindOf = file => /^agents\/[^/]+\.md$/.test(file) ? "agent" : /^commands\/[^/]+\.md$/.test(file) ? "command" : /^skills\/[^/]+\/SKILL\.md$/.test(file) ? "skill" : undefined;
const present = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

function readBatch(tree) {
  let manifest;
  try { manifest = JSON.parse(tree.read(MANIFEST)); } catch { throw fail("claude_baseline_manifest_invalid"); }
  if (!manifest?.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries)) throw fail("claude_baseline_manifest_invalid");
  const paths = Object.keys(manifest.entries);
  if (paths.length > 1024 || paths.some(file => kindOf(file) === undefined || manifest.entries[file]?.runtimeId !== "claude" || manifest.entries[file]?.artifactKind !== kindOf(file))) throw fail("claude_baseline_manifest_invalid");
  return validateProjectionBatch({ manifest, files: paths.map(file => ({ path: file, content: tree.read(file) })) });
}

/**
 * Protect a previously installed baseline during ordinary bootstrap without resolving or updating it.
 * @param {string} target Existing runtime installation root.
 * @returns {string[]} Verified installed relative destinations, or an empty list.
 */
export function installedClaudeBaselinePaths(target) {
  if (present(path.join(target, PENDING))) throw fail("claude_baseline_incomplete");
  if (!present(path.join(target, MANIFEST))) return [];
  const tree = openProjectionTree(target);
  try { return Object.keys(readBatch(tree).manifest.entries).sort(); }
  finally { tree.close(); }
}

/**
 * Hold the existing projection-tree lock across ordinary bootstrap's legacy writers.
 * Owned trees use descriptor-relative locking and reads; legacy-only roots retain platform support.
 * @param {string} target Existing runtime root.
 * @returns {{paths:string[], release:Function}} Protected destinations and an owned lock release.
 */
export function protectClaudeBaseline(target) {
  const tree = [MANIFEST, PENDING].some(name => present(path.join(target, name))) ? openProjectionTree(target) : null;
  let lock;
  const release = () => { try { if (lock?.acquired) lock.release(); } finally { tree?.close(); } };
  try {
    lock = acquireLock(tree?.lockPath ?? path.join(target, LOCK), { resource: "projection-tree" });
    if (!lock.acquired) throw fail("claude_baseline_busy");
    if (tree !== null && tree.read(PENDING) !== null) throw fail("claude_baseline_incomplete");
    const paths = tree === null ? installedClaudeBaselinePaths(target) : Object.keys(readBatch(tree).manifest.entries).sort();
    return { paths, release };
  } catch (error) { release(); throw error; }
}

/**
 * Install package baselines only when the caller explicitly requests this operation.
 * Missing source manifests retain the legacy bootstrap path. Unowned files and symlinks are refused.
 * @param {{source:string, target:string, onStep?:Function}} options Package root and explicit installation root.
 * @returns {Promise<{status:string, paths:string[]}>} Installed destinations, for protection from legacy symlink writers.
 */
export async function installClaudeBaseline({ source, target, onStep }) {
  const baseline = path.resolve(source, "plugins/dotbabel/templates/claude");
  if (!present(path.join(baseline, MANIFEST))) return { status: "absent", paths: [] };
  const sourceTree = openProjectionTree(baseline);
  try {
    fs.mkdirSync(target, { recursive: true });
    const result = await syncProjectionBatch({ root: target, loadBatch: () => readBatch(sourceTree), onStep,
      beforeCommit: ({ tree, manifest }) => syncClaudeCompanions({ tree, manifest, source, onStep }),
    });
    if (result.status !== "synced") throw fail("claude_baseline_busy");
    return { status: "synced", paths: Object.keys(result.manifest.entries).sort() };
  } finally { sourceTree.close(); }
}
