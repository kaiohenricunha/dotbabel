/**
 * The merge token of `dotbabel fleet`: a per-repo lease that lets one session
 * at a time rebase onto the base, attest, and merge. Without it, two pull
 * requests can each pass against an old base and then conflict once both
 * merge.
 *
 * Layout, next to the repo's claims ledger:
 *
 *   <root>/<repo-slug>/merge-token.json   the lease, absent while the token is free
 *   <root>/<repo-slug>/merge-token.lock/  held for the few milliseconds of a change
 *
 * A token is held while its owner's process runs and the owner used it inside
 * the idle window. The owner gives it back by merging, by exiting, or with
 * `dotbabel fleet token release`.
 */

import fs from "node:fs";
import path from "node:path";
import { parseMergeCommand } from "./events.mjs";
import { formatAge } from "./format.mjs";
import { simpleCommands } from "./heavy.mjs";
import { isOwnerAlive } from "./registry.mjs";

/** Version of the token format. A reader ignores a token of another version. */
export const TOKEN_SCHEMA = 1;

/**
 * A holder that ran no token command for this long loses the token. It is
 * long enough for one local-attest that first waits for a CPU lane.
 */
export const DEFAULT_TOKEN_IDLE_MS = 60 * 60_000;

const TOKEN_FILE = "merge-token.json";
const LOCK_DIR = "merge-token.lock";
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 10;

// git rebase modes that continue or stop a rebase that already runs.
const REBASE_CONTROL = new Set(["--continue", "--skip", "--abort", "--quit", "--edit-todo", "--show-current-patch"]);
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const NPX_VALUED = new Set(["-p", "--package", "-c", "--call"]);

function tokenPath(dir) {
  return path.join(dir, TOKEN_FILE);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while this process holds the token lock. A lock older than
 * LOCK_STALE_MS belongs to a process that died inside the lock and is removed.
 */
function withLock(dir, fn, waitMs = LOCK_WAIT_MS) {
  const lock = path.join(dir, LOCK_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between mkdir and stat
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`merge token lock is busy: ${lock}`);
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function writeAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * The repo's token as written, or null when there is none or it is unreadable.
 * It says nothing about whether the token is still held; see tokenHolder.
 *
 * @param {string} dir the repo's ledger directory
 * @returns {object|null}
 */
export function readToken(dir) {
  try {
    const token = JSON.parse(fs.readFileSync(tokenPath(dir), "utf8"));
    if (token?.schema !== TOKEN_SCHEMA || typeof token.owner?.key !== "string") return null;
    return token;
  } catch {
    return null;
  }
}

/**
 * The token when it is held: its owner runs, and it used the token inside the
 * idle window. Null when the token is free.
 *
 * @param {object|null} token from readToken
 * @param {{now: number, idleMs?: number, isAlive?: (owner: object) => boolean}} opts
 * @returns {object|null}
 */
export function tokenHolder(token, { now, idleMs = DEFAULT_TOKEN_IDLE_MS, isAlive = isOwnerAlive }) {
  if (!token) return null;
  const touched = Date.parse(token.touchedAt);
  if (!Number.isFinite(touched) || now - touched >= idleMs) return null;
  return isAlive(token.owner) ? token : null;
}

/**
 * Take the repo's token for `owner`, or take it again to mark it as used.
 *
 * @param {string} dir
 * @param {object} args
 * @param {string} args.repoKey
 * @param {{key: string, pid: number, procStart?: string|null, name?: string|null}} args.owner
 * @param {string|null} args.branch the branch the owner works on
 * @param {string} args.kind      "rebase", "attest", "merge", or "manual"
 * @param {number} [args.now]
 * @param {number} [args.idleMs]
 * @param {(owner: object) => boolean} [args.isAlive]
 * @param {number} [args.lockWaitMs]
 * @returns {{taken: true, token: object}|{taken: false, holder: object}}
 */
export function takeToken(dir, { repoKey, owner, branch, kind, now = Date.now(), idleMs, isAlive, lockWaitMs }) {
  return withLock(
    dir,
    () => {
      const holder = tokenHolder(readToken(dir), { now, idleMs, isAlive });
      if (holder && holder.owner.key !== owner.key) return { taken: false, holder };
      const at = new Date(now).toISOString();
      const token = {
        schema: TOKEN_SCHEMA,
        repo: repoKey,
        owner,
        branch: branch ?? null,
        kind,
        takenAt: holder?.takenAt ?? at,
        touchedAt: at,
      };
      writeAtomic(tokenPath(dir), token);
      return { taken: true, token };
    },
    lockWaitMs,
  );
}

/**
 * Mark the token as used, if `ownerKey` holds it. Never takes a free token.
 *
 * @param {string} dir
 * @param {string} ownerKey
 * @param {{now?: number}} [opts]
 * @returns {boolean} true when the owner holds the token
 */
export function touchToken(dir, ownerKey, { now = Date.now() } = {}) {
  if (readToken(dir)?.owner.key !== ownerKey) return false;
  return withLock(dir, () => {
    const token = readToken(dir);
    if (token?.owner.key !== ownerKey) return false;
    writeAtomic(tokenPath(dir), { ...token, touchedAt: new Date(now).toISOString() });
    return true;
  });
}

/**
 * Give the token back, if `ownerKey` holds it.
 *
 * @param {string} dir
 * @param {string} ownerKey
 * @returns {boolean} true when a token was released
 */
export function releaseToken(dir, ownerKey) {
  if (readToken(dir)?.owner.key !== ownerKey) return false;
  return withLock(dir, () => {
    if (readToken(dir)?.owner.key !== ownerKey) return false;
    fs.rmSync(tokenPath(dir), { force: true });
    return true;
  });
}

function basename(word) {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** True when a ref names a base branch: "main", "origin/main", "refs/heads/main". */
function namesBase(ref, bases) {
  return bases.some((b) => ref === b || ref.endsWith(`/${b}`));
}

/** `git [global options] <sub> <args>` → {sub, args, cwd}; cwd is the last -C. */
function gitParts(words) {
  let cwd = null;
  let k = 1;
  while (k < words.length && words[k].startsWith("-")) {
    const w = words[k];
    if (GIT_VALUED.has(w)) {
      if (w === "-C") cwd = cwd && !path.isAbsolute(words[k + 1] ?? "") ? path.join(cwd, words[k + 1] ?? "") : (words[k + 1] ?? null);
      k += 2;
    } else {
      k += 1;
    }
  }
  return { sub: words[k] ?? null, args: words.slice(k + 1), cwd };
}

function isBaseRebase({ sub, args }, bases) {
  if (sub === "rebase") {
    if (args.some((a) => REBASE_CONTROL.has(a))) return false;
    return args.some((a) => !a.startsWith("-") && namesBase(a, bases)) || args.some((a) => a.startsWith("--onto=") && namesBase(a.slice(7), bases));
  }
  if (sub === "pull") {
    const rebase = args.some((a) => a === "--rebase" || a === "-r" || (a.startsWith("--rebase=") && a !== "--rebase=false"));
    return rebase && args.some((a) => !a.startsWith("-") && namesBase(a, bases));
  }
  return false;
}

/** The words after an npx-style runner and its options. */
function afterRunner(words) {
  let k = 1;
  while (k < words.length && words[k].startsWith("-")) k += NPX_VALUED.has(words[k]) ? 2 : 1;
  return words.slice(k);
}

function isLocalAttest(words) {
  let w = words;
  if (["npx", "pnpx", "bunx", "node"].includes(basename(w[0]))) w = afterRunner(w);
  if (w.length === 0) return false;
  const tool = basename(w[0]).replace(/\.m?js$/, "");
  if (tool === "dotbabel-local-attest") return true;
  return tool === "dotbabel" && w[1] === "local-attest";
}

/**
 * The first command in a shell command line that needs the repo's merge
 * token: a rebase onto a base branch, a `dotbabel local-attest`, or a
 * `gh pr merge`. It reads quotes and separators, so `git commit -m "git
 * rebase main"` needs no token.
 *
 * @param {string|null|undefined} command
 * @param {{bases?: string[]}} [opts] the base branch names (default main, master)
 * @returns {{kind: "rebase"|"attest"|"merge", cwd: string|null, repo: string|null}|null}
 */
export function findTokenCommand(command, { bases = ["main", "master"] } = {}) {
  if (typeof command !== "string" || command.trim() === "") return null;
  for (const words of simpleCommands(command) ?? []) {
    const tool = basename(words[0]);
    if (tool === "git") {
      const parts = gitParts(words);
      if (isBaseRebase(parts, bases)) return { kind: "rebase", cwd: parts.cwd, repo: null };
    } else if (tool === "gh" && words[1] === "pr" && words[2] === "merge") {
      return { kind: "merge", cwd: null, repo: parseMergeCommand(words.join(" "))?.repo ?? null };
    } else if (isLocalAttest(words)) {
      return { kind: "attest", cwd: null, repo: null };
    }
  }
  return null;
}

/** Local wall-clock HH:MM of epoch ms. */
function clock(ms) {
  return new Date(ms).toTimeString().slice(0, 5);
}

function describeHolder(holder, now) {
  const parts = [];
  if (holder.branch) parts.push(`branch ${holder.branch}`);
  if (holder.kind) parts.push(holder.kind);
  const age = formatAge(now - Date.parse(holder.takenAt));
  parts.push(age === "just now" ? "taken just now" : `taken ${age} ago`);
  return parts.join(", ");
}

/**
 * The reason a session reads when the token guard blocks its command or edit.
 *
 * @param {object} args
 * @param {string} args.repoKey
 * @param {object} args.holder the held token
 * @param {string} args.action  what was blocked, such as "gh pr merge" or "an edit of package-lock.json"
 * @param {string} args.cli     how to run the fleet CLI, such as "dotbabel fleet"
 * @param {number} args.now
 * @param {number} args.idleMs
 * @returns {string}
 */
export function formatTokenDeny({ repoKey, holder, action, cli, now, idleMs }) {
  const owner = `"${holder.owner.name ?? `pid ${holder.owner.pid}`}"`;
  return [
    `dotbabel fleet: the live Claude Code session ${owner} holds the merge token for ${repoKey} (${describeHolder(holder, now)}).`,
    `This ${action} is blocked. Only one session at a time rebases onto the base, attests, and merges in a repo, so that two pull requests do not both pass against an old base.`,
    "Do this:",
    `1. SendMessage ${owner}. Ask when it merges, or ask it to give the token back with: ${cli} token release`,
    "2. Continue with other work, then try again.",
    `The token frees itself when ${owner} merges or exits, or at ${clock(Date.parse(holder.touchedAt) + idleMs)} if it is not used again.`,
    "Do not run this step another way to get around the token.",
  ].join("\n");
}

/**
 * One line about the repo's token, for `token status` and the board.
 *
 * @param {{repoKey: string, holder: object|null, now: number, idleMs: number}} args
 * @returns {string}
 */
export function formatTokenStatus({ repoKey, holder, now, idleMs }) {
  if (!holder) return `Merge token for ${repoKey}: free.`;
  const name = holder.owner.name ?? `pid ${holder.owner.pid}`;
  const until = clock(Date.parse(holder.touchedAt) + idleMs);
  return `Merge token for ${repoKey}: held by "${name}" (${describeHolder(holder, now)}), free at ${until} at the latest.`;
}
