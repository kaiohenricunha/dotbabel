/**
 * The on-disk claims ledger of `dotbabel fleet`.
 *
 * Layout, one directory per repo under the state root:
 *
 *   <root>/<repo-slug>/claims/<owner-key>.json    one owner record per session
 *   <root>/<repo-slug>/denials/<owner-key>.json   that session's open blocks
 *
 * Each session writes only its own files, and every write is a rename of a
 * complete temp file, so a reader never sees half a record and two sessions
 * never write the same file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoSlug } from "./policy.mjs";

/** Version of the owner-record format. A reader skips records of another version. */
export const RECORD_SCHEMA = 1;

const SAFE_KEY = /^[\w.-]+$/;

/**
 * The machine-level directory that holds every repo's ledger.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function stateRoot(env = process.env, home = os.homedir()) {
  if (env.DOTBABEL_FLEET_STATE_DIR) return env.DOTBABEL_FLEET_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "dotbabel", "fleet");
}

/**
 * The ledger directory of one repo.
 *
 * @param {string} root
 * @param {string} repoKey
 * @returns {string}
 */
export function repoDir(root, repoKey) {
  return path.join(root, repoSlug(repoKey));
}

function ownerFile(dir, sub, key) {
  if (!SAFE_KEY.test(key)) throw new Error(`unsafe owner key: ${key}`);
  return path.join(dir, sub, `${key}.json`);
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function isRecord(r) {
  return Boolean(
    r && r.schema === RECORD_SCHEMA && r.owner && typeof r.owner.key === "string" && Array.isArray(r.claims),
  );
}

/**
 * Every valid owner record in a repo's ledger, in file-name order.
 *
 * @param {string} dir repo ledger directory
 * @returns {Array<object>}
 */
export function readOwnerRecords(dir) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, "claims"));
  } catch {
    return [];
  }
  const records = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, "claims", name), "utf8"));
      if (isRecord(record)) records.push(record);
    } catch {
      // Unreadable or foreign file: not a claim.
    }
  }
  return records;
}

/**
 * Write (or replace) one owner's record.
 *
 * @param {string} dir
 * @param {object} record
 * @returns {void}
 */
export function writeOwnerRecord(dir, record) {
  writeAtomic(ownerFile(dir, "claims", record.owner.key), record);
}

/**
 * Remove one owner's record and its denial log. Missing files are fine.
 *
 * @param {string} dir
 * @param {string} key
 * @returns {void}
 */
export function removeOwnerRecord(dir, key) {
  fs.rmSync(ownerFile(dir, "claims", key), { force: true });
  fs.rmSync(ownerFile(dir, "denials", key), { force: true });
}

/**
 * One session's open blocks: `{ [rel]: { owner, firstDeniedAt } }`.
 *
 * @param {string} dir
 * @param {string} key
 * @returns {Record<string, {owner: string, firstDeniedAt: string}>}
 */
export function readDenials(dir, key) {
  try {
    const value = JSON.parse(fs.readFileSync(ownerFile(dir, "denials", key), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Save one session's open blocks; an empty log removes the file.
 *
 * @param {string} dir
 * @param {string} key
 * @param {Record<string, {owner: string, firstDeniedAt: string}>} denials
 * @returns {void}
 */
export function writeDenials(dir, key, denials) {
  const file = ownerFile(dir, "denials", key);
  if (Object.keys(denials).length === 0) fs.rmSync(file, { force: true });
  else writeAtomic(file, denials);
}

/**
 * Every repo ledger directory under the state root.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listRepoDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

/**
 * One session's claims in every repo, keyed by repo key. `active` is false for
 * a claim whose worktree no longer exists.
 *
 * @param {string} root state root
 * @param {string} ownerKey
 * @returns {Record<string, Array<object>>}
 */
export function ownClaimsByRepo(root, ownerKey) {
  const out = {};
  for (const dir of listRepoDirs(root)) {
    const mine = readOwnerRecords(dir).find((r) => r.owner.key === ownerKey);
    if (!mine || mine.claims.length === 0) continue;
    out[mine.repo] = mine.claims.map((c) => ({ ...c, active: !c.worktree || fs.existsSync(c.worktree) }));
  }
  return out;
}
