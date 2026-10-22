/**
 * Find Claude Code and Codex sessions for `dotbabel fleet`: the session
 * registry, process liveness, and which session is running the current
 * process. This is the host adapters' implementation of `identity` and
 * `liveness`; `host-adapter.mjs` declares the adapter and imports this
 * module, never the other way round.
 *
 * Claude Code keeps one file per running session in `~/.claude/sessions/`
 * (`<pid>.json`: pid, sessionId, procStart, name, status, ...). That format is
 * internal to Claude Code and can change, so every reader here tolerates
 * missing or malformed files, and callers fail open when a session cannot be
 * identified.
 *
 * An owner is a process incarnation, keyed `<pid>-<procStart>`: the pid alone
 * can be reused, and a session id changes on /clear while the process (and
 * the work in its worktree) stays.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Parent-chain hops `findSelf` walks before it gives up. */
const MAX_ANCESTRY_HOPS = 64;

/**
 * The directory of Claude Code's session registry.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function sessionsDir(env = process.env, home = os.homedir()) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "sessions");
}

/**
 * Read every usable registry entry. `ok` is false when the directory cannot
 * be read at all, which callers treat as "liveness unknown".
 *
 * @param {string} dir
 * @returns {{ok: boolean, entries: Array<{pid: number, sessionId?: string, procStart?: string, name?: string, status?: string}>}}
 */
export function readRegistry(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { ok: false, entries: [] };
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (entry && Number.isInteger(entry.pid) && entry.pid > 0) entries.push(entry);
    } catch {
      // A file mid-write, or not a registry entry. Skip it.
    }
  }
  return { ok: true, entries };
}

/**
 * Parse `/proc/<pid>/stat`. The command name (field 2) can hold spaces and
 * parentheses, so fields are counted from its last closing parenthesis.
 *
 * @param {string} text
 * @returns {{ppid: number, startTime: string}|null}
 */
export function parseProcStat(text) {
  const close = String(text).lastIndexOf(")");
  if (close < 0) return null;
  // fields[0] is field 3 (state), so field N is fields[N - 3].
  const fields = String(text)
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || !/^\d+$/.test(startTime ?? "")) return null;
  return { ppid, startTime };
}

/**
 * Whether a process exists, with its parent and start time where /proc
 * exposes them. Without /proc (macOS), existence comes from signal 0, and
 * EPERM still means the process exists.
 *
 * @param {number} pid
 * @param {{procRoot?: string, kill?: (pid: number, signal: number) => unknown}} [opts]
 * @returns {{exists: boolean, ppid: number|null, startTime: string|null}}
 */
export function processState(pid, { procRoot = "/proc", kill = process.kill.bind(process) } = {}) {
  if (fs.existsSync(procRoot)) {
    let text;
    try {
      text = fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    } catch {
      return { exists: false, ppid: null, startTime: null };
    }
    const stat = parseProcStat(text);
    return { exists: true, ppid: stat?.ppid ?? null, startTime: stat?.startTime ?? null };
  }
  try {
    kill(pid, 0);
    return { exists: true, ppid: null, startTime: null };
  } catch (err) {
    return { exists: /** @type {any} */ (err)?.code === "EPERM", ppid: null, startTime: null };
  }
}

/** Parent pid from /proc, or from `ps` where there is no /proc. */
function parentPid(pid, opts) {
  const procRoot = opts.procRoot ?? "/proc";
  if (fs.existsSync(procRoot)) return processState(pid, opts).ppid;
  const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  const ppid = Number(String(r.stdout ?? "").trim());
  return r.status === 0 && Number.isInteger(ppid) ? ppid : null;
}

/**
 * True when the owner's process still runs. A recorded start time that
 * differs from the live one means the pid was reused, so the owner is gone.
 *
 * @param {{pid: number, procStart?: string|null}} owner
 * @param {{procRoot?: string, kill?: (pid: number, signal: number) => unknown}} [opts]
 * @returns {boolean}
 */
export function isOwnerAlive(owner, opts = {}) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  const state = processState(owner.pid, opts);
  if (!state.exists) return false;
  return !(owner.procStart && state.startTime && String(owner.procStart) !== state.startTime);
}

/**
 * The owner identity recorded in the ledger for a registry entry.
 *
 * @param {{pid: number, procStart?: string, startedAt?: number, sessionId?: string, name?: string}} entry
 * @returns {{key: string, pid: number, procStart: string|null, sessionId: string|null, name: string|null}}
 */
export function ownerFromEntry(entry) {
  const stamp = entry.procStart ?? entry.startedAt ?? 0;
  return {
    key: `${entry.pid}-${stamp}`,
    pid: entry.pid,
    procStart: entry.procStart ?? null,
    sessionId: entry.sessionId ?? null,
    name: entry.name ?? null,
  };
}

/**
 * The registry entry of the session this process runs in. A hook knows its
 * `session_id`; a CLI call does not, so it walks up its parent chain until it
 * reaches a process that is in the registry.
 *
 * @param {object} args
 * @param {Array<object>} args.entries registry entries
 * @param {string} [args.sessionId]    the hook input's session_id
 * @param {number} [args.startPid]     first pid of the parent walk
 * @param {string} [args.procRoot]
 * @param {(pid: number, signal: number) => unknown} [args.kill]
 * @returns {object|null} the live registry entry, or null
 */
export function findSelf({ entries, sessionId, startPid, procRoot, kill }) {
  const opts = { procRoot, kill };
  if (sessionId) {
    const hit = entries.find((e) => e.sessionId === sessionId && isOwnerAlive(e, opts));
    if (hit) return hit;
  }
  if (!Number.isInteger(startPid)) return null;
  const byPid = new Map(entries.map((e) => [e.pid, e]));
  const seen = new Set();
  let pid = startPid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && pid > 1 && !seen.has(pid); hop += 1) {
    seen.add(pid);
    const entry = byPid.get(pid);
    if (entry && isOwnerAlive(entry, opts)) return entry;
    pid = parentPid(pid, opts) ?? 0;
  }
  return null;
}

/** A Codex session id is a UUID, as the hook payload and CODEX_THREAD_ID carry it. */
const CODEX_SESSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/**
 * The nearest Codex CLI process above `startPid`: the native `codex` binary,
 * or the node launcher that runs `codex` / `codex.js`. Codex keeps no session
 * registry on disk, so its process incarnation is the owner.
 *
 * @param {number} startPid
 * @param {{procRoot?: string}} [opts]
 * @returns {{pid: number, procStart: string|null}|null}
 */
export function codexAncestor(startPid, { procRoot = "/proc" } = {}) {
  let pid = startPid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && pid > 1; hop += 1) {
    const proc = processState(pid, { procRoot });
    try {
      const argv = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8").split("\0");
      if (
        path.basename(argv[0]) === "codex" ||
        (path.basename(argv[0]) === "node" && /(?:^|\/)codex(?:\.js)?$/.test(argv[1] ?? ""))
      )
        return { pid, procStart: proc.startTime };
    } catch {
      /* A parent can exit during discovery. */
    }
    pid = proc.ppid ?? 0;
  }
  return null;
}

/**
 * The Codex session this process runs in, as a registry-shaped entry. A hook
 * passes the payload's `session_id`; the Codex tool shell exports
 * `CODEX_THREAD_ID`. The id must be a UUID, and a live codex process must be
 * an ancestor, which gives the owner its process incarnation.
 *
 * @param {{sessionId?: string, env?: NodeJS.ProcessEnv, startPid?: number, procRoot?: string}} [args]
 * @returns {{pid: number, procStart: string, sessionId: string, name: string}|null}
 */
export function findCodexSelf({
  sessionId,
  env = process.env,
  startPid = process.ppid,
  procRoot,
} = {}) {
  const id = sessionId || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  if (typeof id !== "string" || !CODEX_SESSION_ID.test(id)) return null;
  const owner = codexAncestor(startPid, { procRoot });
  if (!owner?.procStart) return null;
  // The tail of the id: a UUIDv7 head is a timestamp that sessions started together share.
  return {
    pid: owner.pid,
    procStart: owner.procStart,
    sessionId: id,
    name: `codex ${id.slice(-8)}`,
  };
}
