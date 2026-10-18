/** Operational ownership for Claude companion links; never resolver or projection identity input. */
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "../manifest.mjs";
import { isProjectionPath } from "../projection-fs.mjs";

const LEDGER = ".dotbabel-claude-companions.json";
const fail = () => Object.assign(new Error("claude_companion_ownership_invalid"), { code: "claude_companion_ownership_invalid" });
const validTarget = value => typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value);

function parseLedger(text) {
  if (text === null) return {};
  let value; try { value = JSON.parse(text); } catch { throw fail(); }
  if (value?.schemaVersion !== 1 || !value.links || typeof value.links !== "object" || Array.isArray(value.links) || Object.keys(value.links).length > 4096) throw fail();
  for (const [file, record] of Object.entries(value.links)) {
    if (!isProjectionPath(file) || !/^skills\/[^/]+\/[^/]+$/.test(file) || file.endsWith("/SKILL.md") || !record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some(key => !["current", "pending"].includes(key)) || !validTarget(record.current) || record.pending !== undefined && !validTarget(record.pending)) throw fail();
  }
  return value.links;
}

/**
 * Update only verified owned companions while the caller holds the projection tree lock.
 * A saved transition recognizes either old or new link after interruption; user replacements stay untouched.
 * New links whose ownership save is interrupted remain unowned and are never adopted by resemblance.
 * @param {{tree:object, manifest:object, source:string, onStep?:Function}} options Locked tree and trusted release paths.
 * @returns {Promise<void>} Completes companion reconciliation before the projection manifest commits.
 */
export async function syncClaudeCompanions({ tree, manifest, source, onStep }) {
  let ledgerText = tree.read(LEDGER);
  const links = parseLedger(ledgerText); const desired = new Map();
  for (const [file, entry] of Object.entries(manifest.entries)) {
    if (entry.artifactKind !== "skill") continue;
    const sourceDirectory = path.resolve(source, path.dirname(entry.sourcePath));
    for (const companion of fs.readdirSync(sourceDirectory)) {
      if (companion === "SKILL.md") continue;
      const destination = path.posix.join(path.posix.dirname(file), companion);
      const target = path.join(sourceDirectory, companion);
      if (!isProjectionPath(destination) || !validTarget(target) || desired.size >= 4096) throw fail();
      desired.set(destination, target);
    }
  }
  const save = () => {
    const content = canonicalJson({ schemaVersion: 1, links }) + "\n";
    if (content !== ledgerText) { tree.write(LEDGER, content, { expected: ledgerText, exclusive: ledgerText === null }); ledgerText = content; }
  };
  for (const [file, target] of desired) {
    const observed = tree.readLink(file); const record = links[file];
    if (observed !== null && (!record || ![record.current, record.pending].includes(observed) || typeof observed !== "string")) {
      if (record) { delete links[file]; save(); }
      continue;
    }
    if (observed !== null) { links[file] = { current: observed, pending: target }; save(); }
    if (!tree.linkCompanion(file, target, observed === null ? {} : { expected: observed })) {
      delete links[file]; save(); continue;
    }
    await onStep?.({ kind: "companion", path: file });
    links[file] = { current: target }; save();
  }
  // Retire ownership only; an unused companion can contain user changes.
  for (const file of Object.keys(links)) if (!desired.has(file)) delete links[file];
  if (ledgerText !== null || Object.keys(links).length > 0) save();
}
