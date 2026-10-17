/**
 * Shared process-incarnation locks for local coordination
 * (docs/specs/model-intelligence, §4 `Shared State`, ARCH-60, ARCH-61, ARCH-65; §7 REL-3).
 *
 * A lock is transient coordination state, never Model Intelligence data. Separate Dotbabel processes
 * share no memory, so the lock is a file, and nothing here depends on an in-memory mutex (ARCH-65).
 *
 * Acquisition is atomic and complete: the owner metadata is written to a temporary file first, which is
 * then hard-linked to the lock path. `link` fails when the path exists, so two processes cannot both
 * succeed, and a reader never sees a lock without its owner. Where the filesystem has no hard links,
 * an exclusive create (`wx`) is the fallback; a reader that catches that lock before its metadata lands
 * judges it `manual_recovery`, which never deletes it.
 *
 * Stale-lock recovery follows REL-3 and is conservative. Age alone is never proof: a lock younger than
 * 10 minutes is never removed, an older one only when its owner is on this host and is proven dead or
 * replaced by another process with the same pid. A lock from another host, or with metadata that is not
 * enough, needs manual recovery.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

/** REL-3: no lock is eligible for automatic stale recovery before it is this old. */
export const STALE_LOCK_MIN_AGE_MS = 10 * 60 * 1000;

/** Errors that mean the filesystem cannot hard-link, so the exclusive-create fallback applies. */
const NO_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * @typedef {object} LockOwner
 * @property {string} token Random; only the holder knows it, so only the holder releases the lock.
 * @property {number} pid
 * @property {string} host
 * @property {string} acquiredAt ISO 8601.
 * @property {string} resource The cache key the lock covers.
 * @property {string} [processStart] The owner's process-start identity, when the platform gives one.
 */

/**
 * @typedef {object} LockVerdict
 * @property {"held" | "recoverable" | "manual_recovery"} state
 * @property {string} reason
 */

/**
 * Whether a process with `pid` exists: `true`, `false`, or `undefined` when that cannot be established.
 * A process of another user answers `EPERM`, which still proves it exists.
 * @param {number} pid
 * @returns {boolean | undefined}
 */
export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

/**
 * The start identity of process `pid`: on Linux, its start time in clock ticks since boot, field 22 of
 * `/proc/<pid>/stat`. A reused pid has another start time. `undefined` where the platform gives none.
 * @param {number} pid
 * @returns {string | undefined}
 */
export function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) is in parentheses and may hold spaces, so fields are counted after the
    // last `)`: field 3 is the first one there, which puts field 22 at index 19.
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return /^\d+$/.test(start ?? "") ? start : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `value` has every field REL-3 needs to judge a lock.
 * @param {unknown} value
 * @returns {value is LockOwner}
 */
function isOwner(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof v.token === "string" &&
    v.token !== "" &&
    Number.isSafeInteger(v.pid) &&
    /** @type {number} */ (v.pid) > 0 &&
    typeof v.host === "string" &&
    v.host !== "" &&
    typeof v.acquiredAt === "string" &&
    Number.isFinite(Date.parse(v.acquiredAt))
  );
}

/**
 * Judge an existing lock under REL-3.
 * @param {unknown} owner The parsed lock file, or `null` when it could not be read.
 * @param {object} context
 * @param {number} context.now Milliseconds since the epoch.
 * @param {string} context.host This host's name.
 * @param {(pid: number) => boolean | undefined} context.isAlive
 * @param {(pid: number) => string | undefined} context.processStartOf
 * @returns {LockVerdict}
 */
export function judgeLock(owner, { now, host, isAlive, processStartOf }) {
  if (!isOwner(owner)) return { state: "manual_recovery", reason: "insufficient_metadata" };
  // A lock stamped in the future has a negative age, which is young, never old.
  const age = now - Date.parse(owner.acquiredAt);
  if (!(age >= STALE_LOCK_MIN_AGE_MS)) return { state: "held", reason: "too_young" };
  // A pid means nothing on another host, so nothing here can prove that owner dead.
  if (owner.host !== host) return { state: "manual_recovery", reason: "other_host" };
  const alive = isAlive(owner.pid);
  if (alive === false) return { state: "recoverable", reason: "owner_dead" };
  if (alive === true) {
    const current = typeof owner.processStart === "string" ? processStartOf(owner.pid) : undefined;
    if (current !== undefined && current !== owner.processStart) return { state: "recoverable", reason: "pid_reused" };
    return { state: "held", reason: "owner_alive" };
  }
  return { state: "held", reason: "liveness_unknown" };
}

/**
 * Read a lock file: its parsed owner, `null` when it exists but holds no JSON object, or `undefined`
 * when there is no lock.
 * @param {string} path
 * @returns {Record<string, unknown> | null | undefined}
 */
export function readLockOwner(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return undefined;
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A unique sibling path of `path`, in the `<target>.<pid>.<nonce>.<suffix>` form of ARCH-59.
 * @param {string} path
 * @param {string} suffix
 * @returns {string}
 */
function siblingPath(path, suffix) {
  return `${path}.${process.pid}.${randomBytes(8).toString("hex")}.${suffix}`;
}

/**
 * Write `text` to a new file and flush it to disk.
 * @param {string} path
 * @param {string} text
 * @param {string} flags
 * @returns {void}
 */
function writeFlushed(path, text, flags) {
  const fd = openSync(path, flags);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create the lock with its full metadata, or report that it exists.
 * @param {string} path
 * @param {string} text
 * @returns {boolean}
 */
function tryCreate(path, text) {
  const tmp = siblingPath(path, "tmp");
  writeFlushed(tmp, text, "wx");
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === "EEXIST") return false;
    if (!NO_LINK_CODES.has(code)) throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone; nothing to clean.
    }
  }
  try {
    writeFlushed(path, text, "wx");
    return true;
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Remove a lock judged recoverable, unless another process replaced it after the judgement.
 *
 * The lock is first renamed aside, which is atomic, and only the renamed file is inspected. If its token
 * is the one judged stale, it is deleted. If not, a new owner took the lock in between, and the file is
 * put back. Two recoverers of one stale lock therefore cannot delete each other's fresh lock.
 * @param {string} path
 * @param {LockOwner} judged
 * @returns {boolean} Whether the stale lock is gone.
 */
function removeStale(path, judged) {
  const aside = siblingPath(path, "stale");
  try {
    renameSync(path, aside);
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return true;
    throw err;
  }
  const text = readFileSync(aside, "utf8");
  let moved;
  try {
    moved = JSON.parse(text);
  } catch {
    moved = null;
  }
  try {
    if (moved?.token === judged.token) return true;
    // A new owner took the lock between the judgement and the rename, so its lock goes back. If yet
    // another owner holds the path by now, `tryCreate` refuses and that owner's lock stands.
    tryCreate(path, text);
    return false;
  } finally {
    unlinkSync(aside);
  }
}

/**
 * The owner fields that may be reported to a caller. The token is how the holder proves ownership, so it
 * stays in the file.
 * @param {unknown} owner
 * @returns {Record<string, unknown> | null}
 */
function publicOwner(owner) {
  if (!isOwner(owner)) return null;
  return { pid: owner.pid, host: owner.host, acquiredAt: owner.acquiredAt, resource: owner.resource };
}

/**
 * Try once to take the lock at `path`. A process that cannot take it does not wait: ARCH-61 lets it use
 * the existing cache or report the refresh as in progress.
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.resource] The cache key, recorded in the owner metadata.
 * @param {() => number} [options.now] Milliseconds since the epoch.
 * @param {(pid: number) => boolean | undefined} [options.isAlive]
 * @param {(pid: number) => string | undefined} [options.processStartOf]
 * @returns {{acquired: true, owner: LockOwner, recovered?: string, release: () => void} | {acquired: false, state: string, reason: string, owner: Record<string, unknown> | null}}
 */
export function acquireLock(path, options = {}) {
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? isPidAlive;
  const processStartOf = options.processStartOf ?? processStartIdentity;
  const host = hostname();
  const processStart = processStartIdentity(process.pid);
  /** @type {LockOwner} */
  const owner = {
    token: randomBytes(16).toString("hex"),
    pid: process.pid,
    host,
    acquiredAt: new Date(now()).toISOString(),
    resource: String(options.resource ?? ""),
    ...(processStart === undefined ? {} : { processStart }),
  };
  const text = `${JSON.stringify(owner)}\n`;
  const held = (recovered) => ({
    acquired: /** @type {const} */ (true),
    owner,
    ...(recovered === undefined ? {} : { recovered }),
    release: () => {
      // Only the holder's own lock is removed: a lock that is not ours any more is someone else's.
      if (readLockOwner(path)?.token !== owner.token) return;
      try {
        unlinkSync(path);
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== "ENOENT") throw err;
      }
    },
  });

  mkdirSync(dirname(path), { recursive: true });
  if (tryCreate(path, text)) return held(undefined);
  const current = readLockOwner(path);
  // The holder released between the two calls: one more try, never a loop.
  if (current === undefined) return tryCreate(path, text) ? held(undefined) : { acquired: false, state: "held", reason: "contended", owner: null };
  const verdict = judgeLock(current, { now: now(), host, isAlive, processStartOf });
  if (verdict.state !== "recoverable") return { acquired: false, ...verdict, owner: publicOwner(current) };
  if (removeStale(path, /** @type {LockOwner} */ (current)) && tryCreate(path, text)) return held(verdict.reason);
  return { acquired: false, state: "held", reason: "contended", owner: null };
}
