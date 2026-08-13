/**
 * symlink.mjs — shared filesystem helpers used by bootstrap-global and
 * project-sync. Both flows symlink artifacts into target trees with a
 * timestamped backup discipline; this module is the single source of truth
 * for that behavior.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * @typedef {'ok'|'updated'|'linked'|'backed_up'} LinkAction
 *
 * @typedef {object} LinkResult
 * @property {LinkAction} action
 * @property {string} [bakPath]   Backup path (only set when action === 'backed_up')
 *
 * @typedef {'created'|'ok'|'backed_up'} EnsureDirAction
 *
 * @typedef {object} EnsureDirResult
 * @property {EnsureDirAction} action
 * @property {string} [bakPath]   Backup path (only set when action === 'backed_up')
 */

/**
 * Build a backup-suffix timestamp matching `bootstrap.sh`'s `date +%Y%m%d-%H%M%S`.
 *
 * After `replace(/[-:T]/g, "")` the ISO string becomes "YYYYMMDDHHmmss.mmmZ",
 * so the date part is `slice(0, 8)` and the time part is `slice(8, 14)` —
 * no `T` separator remains.
 *
 * @returns {string}
 */
export function buildTimestamp() {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\..+$/, "");
  return `${ts.slice(0, 8)}-${ts.slice(8, 14)}`;
}

/**
 * Create or update a symlink at `dst` pointing to `src`. Backs up a real
 * file/dir at `dst` before replacing it.
 *
 * @param {string} src
 * @param {string} dst
 * @param {import('./output.mjs').Output} out
 * @param {string} ts  Timestamp string for backup suffix (see {@link buildTimestamp}).
 * @returns {LinkResult}
 */
export function linkOne(src, dst, out, ts) {
  let lstat;
  try {
    lstat = fs.lstatSync(dst);
  } catch {
    fs.symlinkSync(src, dst);
    out.pass(`linked: ${dst} -> ${src}`);
    return { action: "linked" };
  }

  if (lstat.isSymbolicLink()) {
    const current = fs.readlinkSync(dst);
    if (current === src) {
      out.pass(`ok: ${dst}`);
      return { action: "ok" };
    }
    fs.unlinkSync(dst);
    fs.symlinkSync(src, dst);
    out.pass(`updated: ${dst} -> ${src}`);
    return { action: "updated" };
  }

  const bakPath = `${dst}.bak-${ts}`;
  fs.renameSync(dst, bakPath);
  fs.symlinkSync(src, dst);
  out.warn(`backed up + linked: ${dst} (old at ${bakPath})`);
  return { action: "backed_up", bakPath };
}

/**
 * Ensure `dst` is a real directory. If `dst` is missing, create it. If `dst`
 * is a symlink or a regular file, back it up and create a real directory in
 * its place.
 *
 * @param {string} dst
 * @param {import('./output.mjs').Output} out
 * @param {string} ts  Timestamp string for backup suffix.
 * @returns {EnsureDirResult}
 */
export function ensureRealDir(dst, out, ts) {
  let lstat;
  try {
    lstat = fs.lstatSync(dst);
  } catch {
    fs.mkdirSync(dst, { recursive: true });
    return { action: "created" };
  }

  if (lstat.isDirectory() && !lstat.isSymbolicLink()) {
    return { action: "ok" };
  }

  const bakPath = `${dst}.bak-${ts}`;
  fs.renameSync(dst, bakPath);
  out.warn(`backed up: ${dst} (old at ${bakPath})`);
  fs.mkdirSync(dst, { recursive: true });
  return { action: "backed_up", bakPath };
}

/**
 * Check whether `command` is on PATH. Mirrors `command -v` in POSIX shell.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function commandExists(command) {
  const result = spawnSync(
    "sh",
    ["-c", `command -v ${quoteShellWord(command)} >/dev/null 2>&1`],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

/**
 * Single-quote a word for safe inclusion in `sh -c '...'` invocations.
 *
 * @param {string} word
 * @returns {string}
 */
export function quoteShellWord(word) {
  return `'${word.replace(/'/g, "'\\''")}'`;
}
