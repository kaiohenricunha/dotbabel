/** Explicit, batch-scoped canonical migration with preserved native compatibility controls. */
import yaml from "js-yaml";
import { legacySatisfiesDeclaration } from "./compatibility.mjs";
import { loadCompatibilityContext } from "./release.mjs";
import { parseComputeDeclaration } from "../requirement/index.mjs";
import { interpretLegacy, detectDualDeclarationConflict, canCarryComputeDeclaration } from "./index.mjs";
import { isProjectionPath, openProjectionTree } from "../materialize/projection-fs.mjs";
import { canonicalJson } from "../materialize/manifest.mjs";
import { acquireLock, readLockOwner } from "../../lib/process-lock.mjs";

const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const kindOf = source => /^agents\/[^/]+\.md$/.test(source) ? "agent" : /^commands\/[^/]+\.md$/.test(source) ? "command" : /^skills\/[^/]+\/SKILL\.md$/.test(source) ? "skill" : undefined;
const bindingOf = kind => kind === "agent" ? "self" : kind === "command" ? "session" : "consumer";
function source(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) throw fail("migration_source_invalid");
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw fail("migration_source_invalid");
  let header; try { header = yaml.load(match[1]); } catch { throw fail("migration_source_invalid"); }
  if (!object(header)) throw fail("migration_source_invalid");
  return { header, body: content.slice(match[0].length) };
}
function decisionsByPath(decisions, paths) {
  if (!Array.isArray(decisions) || decisions.length > 1024) throw fail("migration_decision_invalid");
  const result = new Map();
  for (const entry of decisions) {
    if (!object(entry) || Object.keys(entry).some(key => !["sourcePath", "artifactKind", "category", "compute"].includes(key)) || !paths.includes(entry.sourcePath) || result.has(entry.sourcePath) || kindOf(entry.sourcePath) !== entry.artifactKind || !["A", "B", "C", "D", "E", "F"].includes(entry.category)) throw fail("migration_decision_invalid");
    if (entry.category !== "F") {
      const parsed = parseComputeDeclaration({ dotbabel: { compute: entry.compute } }, { sourcePath: entry.sourcePath });
      if (!parsed.declared || parsed.errors.length || entry.compute?.binding !== bindingOf(entry.artifactKind)) throw fail("migration_decision_invalid");
    }
    result.set(entry.sourcePath, entry);
  }
  return result;
}

/**
 * Plan a bounded canonical batch without inferring semantic intent from a model alias.
 * Explicit decisions use the existing compute parser; class-F entries remain untouched.
 * Existing native model/effort and artifact bodies remain intact during the bridge.
 * @param {{artifacts:object[],decisions?:object[],batch?:string,compatibility?:object}} options Original canonical bytes and reviewed per-artifact decisions.
 * @returns {object} Changes and a report containing no artifact contents or native secrets.
 */
export function planMigration({ artifacts, decisions = [], batch, compatibility } = {}) {
  if (!Array.isArray(artifacts) || artifacts.length > 1024 || batch !== undefined && !["A", "B", "C", "D", "E", "F"].includes(batch)) throw fail("migration_input_invalid");
  const paths = artifacts.map(entry => entry.sourcePath);
  if (new Set(paths).size !== paths.length || artifacts.some(entry => !isProjectionPath(entry.sourcePath) || kindOf(entry.sourcePath) !== entry.artifactKind || !canCarryComputeDeclaration(entry.artifactKind))) throw fail("migration_input_invalid");
  const approved = decisionsByPath(decisions, paths); const changes = []; const unresolved = []; const entries = []; const verifiedPaths = [];
  for (const artifact of artifacts) {
    const parsed = source(artifact.content); const current = parseComputeDeclaration(parsed.header, { sourcePath: artifact.sourcePath });
    if (current.errors.length) throw fail("migration_source_invalid");
    const decision = approved.get(artifact.sourcePath);
    if (batch !== undefined && (decision?.category ?? "E") !== batch) continue;
    const reading = interpretLegacy(parsed.header, artifact);
    if (current.declared && detectDualDeclarationConflict(current.requirement, reading) && !legacySatisfiesDeclaration(current.requirement, reading, compatibility && { ...compatibility, sourcePath: artifact.sourcePath, artifactKind: artifact.artifactKind })) throw fail("migration_decision_conflict");
    let compute = decision?.compute;
    if (decision?.category === "F") { unresolved.push(artifact.sourcePath); entries.push({ sourcePath: artifact.sourcePath, state: "owner-decision" }); continue; }
    if (!compute && reading.disposition === "inherit") compute = { mode: "inherit", binding: bindingOf(artifact.artifactKind) };
    if (!compute) { if (!current.declared && reading.disposition !== "absent") unresolved.push(artifact.sourcePath); entries.push({ sourcePath: artifact.sourcePath, state: current.declared ? "canonical" : reading.disposition === "absent" ? "neutral" : "owner-decision" }); continue; }
    const desired = parseComputeDeclaration({ dotbabel: { compute } }, { sourcePath: artifact.sourcePath });
    if (detectDualDeclarationConflict(desired.requirement, reading)) {
      if (!legacySatisfiesDeclaration(desired.requirement, reading, compatibility && { ...compatibility, sourcePath: artifact.sourcePath, artifactKind: artifact.artifactKind })) throw fail("migration_decision_conflict");
      verifiedPaths.push(artifact.sourcePath);
    }
    if (current.declared) {
      if (canonicalJson(parsed.header.dotbabel.compute) !== canonicalJson(compute)) throw fail("migration_decision_conflict");
      entries.push({ sourcePath: artifact.sourcePath, state: "canonical" }); continue;
    }
    parsed.header.dotbabel = { ...parsed.header.dotbabel, compute };
    const content = "---\n" + yaml.dump(parsed.header, { lineWidth: -1 }) + "---\n" + parsed.body;
    changes.push({ sourcePath: artifact.sourcePath, before: artifact.content, content }); entries.push({ sourcePath: artifact.sourcePath, state: "pending" });
  }
  return { changes, report: { envelope: "MigrationReport", version: 1, artifacts: entries, pending: changes.map(entry => entry.sourcePath), unresolved, ...(verifiedPaths.length ? { compatibility: { basis: compatibility.snapshotId ? "accepted-release-capability-evidence" : "caller-supplied-resolver-evidence", snapshotId: compatibility.snapshotId ?? null, paths: verifiedPaths } } : {}) } };
}

/**
 * Read and migrate exact canonical paths under the shared descriptor-anchored filesystem boundary.
 * Prevalidate the complete batch; compare each original before atomic replacement. Interrupted
 * batches retain usable legacy controls and can resume without replacing changed user files.
 * @param {{root:string,paths:string[],decisions?:object[],batch?:string,mode?:string,beforeWrite?:Function}} options Explicit project root, canonical paths, mode and optional test observation hook.
 * @returns {Promise<object>} Compliant state, pending/unresolved paths and completed writes.
 */
export async function migrateArtifacts({ root, paths, decisions, batch, mode = "analysis", beforeWrite } = {}) {
  if (!["analysis", "check", "write"].includes(mode) || !Array.isArray(paths) || paths.length > 1024) throw fail("migration_input_invalid");
  const tree = openProjectionTree(root); let lock;
  try {
    if (mode === "write") { lock = acquireLock(tree.lockPath, { resource: "canonical-migration" }); if (!lock.acquired) throw fail("migration_locked"); }
    else if (readLockOwner(tree.lockPath) !== undefined) throw fail("migration_locked");
    const artifacts = paths.map(sourcePath => ({ sourcePath, artifactKind: kindOf(sourcePath), content: tree.read(sourcePath) }));
    const { changes, report } = planMigration({ artifacts, decisions, batch, compatibility: loadCompatibilityContext(root) }); const written = [];
    if (mode === "write") {
      for (const change of changes) { await beforeWrite?.(change.sourcePath); tree.write(change.sourcePath, change.content, { expected: change.before }); written.push(change.sourcePath); }
    } else {
      if (readLockOwner(tree.lockPath) !== undefined || artifacts.some(artifact => tree.read(artifact.sourcePath) !== artifact.content)) throw fail("migration_source_changed");
    }
    return { ...report, ...(mode === "write" ? { planned: report.pending, pending: [], artifacts: report.artifacts.map(entry => entry.state === "pending" ? { ...entry, state: "canonical" } : entry) } : {}), mode, compliant: mode === "write" || changes.length === 0, written };
  } finally { if (lock?.acquired) lock.release(); tree.close(); }
}
