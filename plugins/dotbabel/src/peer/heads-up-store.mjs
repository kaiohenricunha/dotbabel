/** Opt-in, read-only watch of Claude Code's "You should know" store. It never invokes a model, reads a transcript, or writes a Claude Code file. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { enqueueHeadsUp } from "./state.mjs";

/** Claude Code releases whose store format was measured (docs/research/heads-up-advisor-integration-feasibility.md). */
export const MEASURED_CLAUDE_VERSIONS = Object.freeze(["2.1.307", "2.1.309"]);

const require = createRequire(import.meta.url);
let validator;
// Every peer command loads this module, so the validator loads only for a project that sets peer.
function validPeer(value) {
  if (!validator) {
    const { default: Ajv } = require("ajv/dist/2020.js");
    const schema = require("../../../../schemas/dotbabel.config.schema.json");
    validator = new Ajv({ strict: false }).compile(schema.properties.peer);
  }
  return validator(value);
}
const PLUGIN = "cc-plugin-you-should-know@builtin";
// The measured store is about 22 KB; the project config cap follows the Model Intelligence reader.
const MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAGS = new Set(["Heads up", "You should know"]);
const TOP = new Set(["sessions", "seen", "known", "typedPastInARow", "looksToSkip"]);
const SESSION = new Set(["id", "askedTurn", "offeredTurn", "tag", "view"]);
const OFFER = ["explanation", "kind", "line", "shownAt"];
const BAD_CONFIG = "invalid or unreadable peer.heads_up in .dotbabel.json; the watcher is off";
const FORWARDED_BY = "the relay watcher";

/** The store file, named by the first 12 hex of sha256 of the add-on name. @param {NodeJS.ProcessEnv} [env] @param {string} [home] @returns {string} */
export function storeFile(env = process.env, home = os.homedir()) {
  const digest = createHash("sha256").update(PLUGIN).digest("hex").slice(0, 12);
  return path.join(
    env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    "plugins",
    "store",
    `cc-plugin-you-should-know_builtin-${digest}.json`,
  );
}

/** Read one regular file of this user without following a final symlink. @param {string} file @returns {{text?: string, state?: string}} */
function readBounded(file) {
  let fd;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > MAX_BYTES ||
      (process.getuid && stat.uid !== process.getuid())
    )
      return { state: "refused" };
    return { text: fs.readFileSync(fd, "utf8") };
  } catch (err) {
    if (err.code === "ENOENT") return { state: "missing" };
    return { state: ["ELOOP", "EISDIR"].includes(err.code) ? "refused" : "unreadable" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const plain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
function validSession(s) {
  if (!plain(s) || !Object.keys(s).every((k) => SESSION.has(k)) || !UUID.test(s.id)) return false;
  if (s.askedTurn !== undefined && !UUID.test(s.askedTurn)) return false;
  if (s.offeredTurn !== undefined && !UUID.test(s.offeredTurn)) return false;
  if (s.tag !== undefined && !TAGS.has(s.tag)) return false;
  if ((s.offeredTurn === undefined) !== (s.tag === undefined)) return false;
  if (s.view === undefined) return true;
  if (!plain(s.view) || !text(s.view.kind, 64)) return false;
  // Other view kinds are never read, so only their kind is checked.
  if (s.view.kind !== "offer") return true;
  const v = s.view;
  return (
    s.offeredTurn !== undefined &&
    Object.keys(v).sort().join() === OFFER.join() &&
    text(v.line, 4096) &&
    typeof v.explanation === "string" &&
    v.explanation.length <= 16384 &&
    Number.isFinite(v.shownAt)
  );
}

/** Accept only the measured store shape. @param {unknown} d @returns {{sessions: object[], seen: string[]}|null} */
export function parseStore(d) {
  if (!plain(d) || !Object.keys(d).every((k) => TOP.has(k))) return null;
  const { sessions, seen, known } = d;
  if (!Array.isArray(sessions) || sessions.length > 1000 || !sessions.every(validSession))
    return null;
  if (new Set(sessions.map((s) => s.id)).size !== sessions.length) return null;
  const lines = (v) => Array.isArray(v) && v.length <= 50 && v.every((l) => typeof l === "string");
  if (!lines(seen) || (known !== undefined && !lines(known))) return null;
  for (const k of ["typedPastInARow", "looksToSkip"])
    if (d[k] !== undefined && !Number.isFinite(d[k])) return null;
  return { sessions, seen };
}

/** Read the store once. "unreadable" is transient: the caller skips the tick and retries. @param {string} file @returns {{state: "ok"|"store_missing"|"unknown_format"|"unreadable", snapshot?: object}} */
export function readStore(file) {
  const read = readBounded(file);
  if (read.state === "missing") return { state: "store_missing" };
  if (read.state === "refused") return { state: "unknown_format" };
  if (read.state) return { state: "unreadable" };
  let document;
  try {
    document = JSON.parse(read.text);
  } catch {
    // A partial write parses as broken JSON.
    return { state: "unreadable" };
  }
  const snapshot = parseStore(document);
  return snapshot ? { state: "ok", snapshot } : { state: "unknown_format" };
}

/** Notes shown now. @param {{sessions: object[]}} snapshot @returns {{sessionId: string, offeredTurn: string, tag: string, line: string, explanation: string, shownAt: number}[]} */
export function openOffers(snapshot) {
  return snapshot.sessions
    .filter((s) => s.view?.kind === "offer")
    .map((s) => ({
      sessionId: s.id,
      offeredTurn: s.offeredTurn,
      tag: s.tag,
      line: s.view.line,
      explanation: s.view.explanation,
      shownAt: s.view.shownAt,
    }));
}

/** Lines appended to the sliding seen window. @param {string[]} prev @param {string[]} next @returns {string[]} */
function addedLines(prev, next) {
  for (let o = Math.min(prev.length, next.length); o >= 0; o--)
    if (prev.slice(prev.length - o).every((l, n) => l === next[n])) return next.slice(o);
  return next;
}

/** Attribute a note that closed between two reads: one new seen line and exactly one session whose offered turn changed. @param {object} prev @param {object} next @returns {{kind: "none"|"pending"}|{kind: "ambiguous", sessions: string[]}|{kind: "single", sessionId: string, offeredTurn: string, tag: string, line: string}} */
export function attribute(prev, next) {
  const added = addedLines(prev.seen, next.seen);
  const before = new Map(prev.sessions.map((s) => [s.id, s.offeredTurn]));
  const changed = next.sessions.filter(
    (s) => s.offeredTurn !== undefined && before.get(s.id) !== s.offeredTurn,
  );
  if (!added.length) return { kind: "none" };
  // The add-on writes the seen line before the session record.
  if (!changed.length) return { kind: "pending" };
  if (added.length > 1 || changed.length > 1)
    return { kind: "ambiguous", sessions: changed.map((s) => s.id) };
  const [s] = changed;
  return {
    kind: "single",
    sessionId: s.id,
    offeredTurn: s.offeredTurn,
    tag: s.tag,
    line: added[0],
  };
}

/** The installed Claude Code version, read without a shell. @param {Function} [run] @returns {string|null} */
export function claudeVersion(run = execFileSync) {
  try {
    const out = run("claude", ["--version"], {
      encoding: "utf8",
      shell: false,
      timeout: 5000,
      maxBuffer: 4096,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The project's opt-in, read from Main's worktree. Anything but a valid setting is off. @param {string} worktree @returns {{mode: "off"|"enqueue", diagnostic?: string}} */
export function readHeadsUpMode(worktree) {
  const read = readBounded(path.join(worktree, ".dotbabel.json"));
  if (read.state === "missing") return { mode: "off" };
  try {
    if (read.state) throw new Error(read.state);
    const document = JSON.parse(read.text);
    if (!plain(document) || (document.peer !== undefined && !validPeer(document.peer)))
      throw new Error("invalid");
    return { mode: document.peer?.heads_up?.mode === "enqueue" ? "enqueue" : "off" };
  } catch {
    return { mode: "off", diagnostic: BAD_CONFIG };
  }
}

/** Where a forwarded note came from, read from Main's worktree without changing it or taking its index lock. @param {object} p @param {string} forwardedBy @returns {object} */
export function noteOrigin(p, forwardedBy) {
  const read = (args) => {
    try {
      return execFileSync("git", ["--no-optional-locks", "-C", p.main.worktree, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
    } catch {
      return null;
    }
  };
  const status = read(["status", "--porcelain"]);
  const lines = status ? status.split("\n") : [];
  const at = p.main.key.indexOf(":");
  return {
    forwardedBy,
    main: at < 0 ? p.main.key.slice(0, 8) : p.main.key.slice(0, at + 9),
    repo: p.main.repo,
    worktree: p.main.worktree,
    head: read(["rev-parse", "--short", "HEAD"]) ?? "unknown",
    tree:
      status === null
        ? "status unknown"
        : lines.some((l) => !l.startsWith("??"))
          ? "uncommitted changes"
          : lines.length
            ? "untracked files only"
            : "clean",
  };
}

/** The watcher fields for peer status, with the current setting. It holds no note text. @param {object} p @param {{mode: string, diagnostic?: string}} setting from readHeadsUpMode, read before the ledger lock @param {boolean} relayAlive @returns {object} */
export function headsUpStatus(p, { mode, diagnostic }, relayAlive) {
  return {
    state: "off",
    claudeVersion: null,
    forwarded: 0,
    ambiguous: 0,
    ...p.heads_up,
    mode,
    // A stopped relay watches nothing, whatever it recorded last.
    ...(mode === "off" || !relayAlive ? { state: "off" } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

const key = (sessionId, offeredTurn) => `${sessionId}\n${offeredTurn}`;
// A failed version probe is retried after this long; a measured result is kept for the relay run.
const PROBE_RETRY_MS = 60000;
// The record follows its seen line at once; after this many reads a lone line is dropped.
const PENDING_TICKS = 5;
const WATCHER_ERROR = "the watcher failed on this tick and retries on the next";

/**
 * One watcher per relay run. prepare reads files and Git outside the ledger lock. apply runs inside the
 * tick transaction and changes only the pair. commit runs after that transaction is written, so a
 * rolled-back write leaves the watcher's memory as it was and the next tick retries.
 * The memory (the forwarded notes and the last snapshot) lives only as long as the relay.
 * @param {{env?: NodeJS.ProcessEnv, version?: Function, readMode?: Function, origin?: Function, file?: string}} [opts]
 * @returns {{prepare: (pair: object, now?: number) => object, apply: (p: object, prepared: object, now?: number) => void, commit: (prepared: object) => void}}
 */
export function createHeadsUpWatcher({
  env = process.env,
  version = claudeVersion,
  readMode = readHeadsUpMode,
  origin = noteOrigin,
  file = storeFile(env),
} = {}) {
  let installed,
    probedAt = -Infinity,
    prev = null,
    pending = 0,
    counts = null,
    failure = null,
    handled = new Set();

  function probe(now) {
    if (installed || now - probedAt < PROBE_RETRY_MS) return;
    probedAt = now;
    installed = version();
  }

  function prepare(pair, now = Date.now()) {
    const { mode, diagnostic } = readMode(pair.main.worktree);
    const report = (state, note = diagnostic) => ({
      mode,
      state,
      claudeVersion: installed ?? null,
      ...(note ? { diagnostic: note } : {}),
    });
    // A fresh baseline follows every pause, so notes that closed meanwhile never replay.
    const pause = (state, note) => ({ reset: true, status: report(state, note) });
    if (mode !== "enqueue") return pause("off");
    if (pair.main.harness !== "claude") return pause("off", "Main is not a Claude Code session");
    probe(now);
    if (!MEASURED_CLAUDE_VERSIONS.includes(installed)) return pause("unsupported_version");
    if (pair.main.version && !MEASURED_CLAUDE_VERSIONS.includes(pair.main.version))
      return pause(
        "unsupported_version",
        `Main runs Claude Code ${pair.main.version}, which is not measured`,
      );
    const read = readStore(file);
    if (read.state === "unreadable") return { skip: true };
    if (read.state !== "ok") return pause(read.state);
    const next = read.snapshot,
      mine = (id) => `claude:${id}` === pair.main.key;
    const candidates = openOffers(next).filter(
      (o) => mine(o.sessionId) && !handled.has(key(o.sessionId, o.offeredTurn)),
    );
    const mark = [];
    let ambiguous = 0,
      keep = false;
    if (!prev) {
      // The baseline: a closed record was shown before this relay started.
      for (const s of next.sessions)
        if (s.offeredTurn !== undefined && s.view?.kind !== "offer")
          mark.push(key(s.id, s.offeredTurn));
    } else {
      const found = attribute(prev, next);
      const open = (k) => candidates.some((c) => key(c.sessionId, c.offeredTurn) === k);
      keep = found.kind === "pending" && pending < PENDING_TICKS;
      if (found.kind === "single" && mine(found.sessionId)) {
        const k = key(found.sessionId, found.offeredTurn);
        if (!handled.has(k) && !open(k)) candidates.push({ ...found, explanation: null });
      }
      if (found.kind === "ambiguous" && found.sessions.some(mine)) {
        const record = next.sessions.find((s) => mine(s.id));
        const k = key(record.id, record.offeredTurn);
        if (!handled.has(k) && !open(k)) {
          ambiguous++;
          mark.push(k);
        }
      }
    }
    return {
      status: report("watching"),
      candidates,
      mark,
      ambiguous,
      keep,
      snapshot: next,
      origin: candidates.length ? origin(pair, FORWARDED_BY) : null,
    };
  }

  function apply(p, prepared, now = Date.now()) {
    if (prepared.failed) {
      if (p.heads_up) p.heads_up = { ...p.heads_up, diagnostic: WATCHER_ERROR };
      return;
    }
    if (prepared.skip) return;
    const base = counts ?? {
      forwarded: p.heads_up?.forwarded ?? 0,
      ambiguous: p.heads_up?.ambiguous ?? 0,
    };
    const staged = {
      counts: { forwarded: base.forwarded, ambiguous: base.ambiguous + (prepared.ambiguous ?? 0) },
      handled: [...(prepared.mark ?? [])],
      failure,
    };
    for (const c of prepared.candidates ?? []) {
      if (`claude:${c.sessionId}` !== p.main.key) continue;
      const before = p.sequence;
      try {
        enqueueHeadsUp(
          p,
          `${c.tag} · ${c.line}${c.explanation ? `\n${c.explanation}` : ""}`,
          prepared.origin,
          { now },
        );
        if (p.sequence > before) staged.counts.forwarded++;
        staged.failure = null;
      } catch {
        // Each refusal is deterministic (the note's size or text), so a retry would repeat it.
        staged.failure = "a note could not be queued";
      }
      staged.handled.push(key(c.sessionId, c.offeredTurn));
    }
    prepared.staged = staged;
    const status = { ...prepared.status, ...staged.counts };
    if (staged.failure && !status.diagnostic) status.diagnostic = staged.failure;
    // A project that never opted in keeps its ledger unchanged.
    if (p.heads_up === undefined && status.mode === "off") return;
    if (JSON.stringify(p.heads_up) !== JSON.stringify(status)) p.heads_up = status;
  }

  function commit(prepared) {
    const { staged } = prepared;
    if (!staged) return;
    counts = staged.counts;
    failure = staged.failure;
    if (prepared.reset) {
      prev = null;
      pending = 0;
      return;
    }
    if (!prepared.snapshot) return;
    pending = prepared.keep ? pending + 1 : 0;
    if (!prepared.keep) prev = prepared.snapshot;
    // Prune against the store as read now, so a key added on this tick stays.
    const present = new Set(prepared.snapshot.sessions.map((s) => key(s.id, s.offeredTurn)));
    handled = new Set([...handled, ...staged.handled].filter((k) => present.has(k)));
  }

  return { prepare, apply, commit };
}
