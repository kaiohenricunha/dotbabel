/**
 * The event feed of `dotbabel fleet`: a machine-level record of merges, so a
 * session learns that the base branch moved under the files it claims.
 *
 * Layout under the state root:
 *
 *   events/<stamp>-<pid>.json   one merge each; the name sorts by time
 *   seen/<session-id>           the name of the last event that session saw
 *
 * The session that runs `gh pr merge` writes the event (the PostToolUse
 * hook). Every session reads the events after its own marker on its next
 * tool call or prompt, and gets a message only for repos where it holds
 * claims. hooks/fleet-guard.sh compares the newest event name with the
 * marker in bash, so a session starts Node only when there is news.
 */

import fs from "node:fs";
import path from "node:path";
import { simpleCommands } from "./heavy.mjs";
import { anyPathMatches } from "../spec-harness-lib.mjs";

/** Version of the event format. A reader skips events of another version. */
export const EVENT_SCHEMA = 1;

/** How long an event file is kept. Writers delete older ones. */
export const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EVENT_FILE = /^\d{15}-\d+\.json$/;
const SESSION_ID = /^[\w-]+$/;
const MAX_EVENTS_SHOWN = 5;
const MAX_FILES_SHOWN = 8;

/**
 * The file name of an event: a zero-padded time stamp, so name order is time order.
 *
 * @param {number} atMs epoch ms
 * @param {number} pid  the writer's pid, to keep two same-millisecond events apart
 * @returns {string}
 */
export function eventName(atMs, pid) {
  return `${String(Math.floor(atMs)).padStart(15, "0")}-${pid}.json`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * The names of all event files, oldest first.
 *
 * @param {string} root state root
 * @returns {string[]}
 */
export function listEventNames(root) {
  try {
    return fs
      .readdirSync(path.join(root, "events"))
      .filter((n) => EVENT_FILE.test(n))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write one event, and delete the events older than the retention window.
 *
 * @param {string} root
 * @param {object} event
 * @param {{now?: number, pid?: number}} [opts]
 * @returns {string} the event's file name
 */
export function writeEvent(root, event, { now = Date.now(), pid = process.pid } = {}) {
  const name = eventName(now, pid);
  writeAtomic(path.join(root, "events", name), `${JSON.stringify(event, null, 2)}\n`);
  const cutoff = eventName(now - EVENT_TTL_MS, 0);
  for (const old of listEventNames(root)) {
    if (old < cutoff) fs.rmSync(path.join(root, "events", old), { force: true });
  }
  return name;
}

/**
 * Read the named events, skipping files that are unreadable or of another version.
 *
 * @param {string} root
 * @param {string[]} names
 * @returns {Array<{name: string, event: object}>}
 */
export function readEvents(root, names) {
  const out = [];
  for (const name of names) {
    try {
      const event = JSON.parse(fs.readFileSync(path.join(root, "events", name), "utf8"));
      if (event && event.schema === EVENT_SCHEMA && typeof event.repo === "string") out.push({ name, event });
    } catch {
      // A file mid-write or a foreign file: not an event.
    }
  }
  return out;
}

/**
 * The name of the last event a session saw, or null before its first hook call.
 *
 * @param {string} root
 * @param {string} sessionId
 * @returns {string|null}
 */
export function readSeen(root, sessionId) {
  if (!SESSION_ID.test(String(sessionId))) return null;
  try {
    return fs.readFileSync(path.join(root, "seen", sessionId), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Record the last event a session saw.
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {string} name
 * @returns {void}
 */
export function writeSeen(root, sessionId, name) {
  if (!SESSION_ID.test(String(sessionId))) throw new Error(`unsafe session id: ${sessionId}`);
  writeAtomic(path.join(root, "seen", sessionId), `${name}\n`);
}

/**
 * The repo key ("host/owner/name") of a pull request URL.
 *
 * @param {string} url e.g. https://github.com/owner/name/pull/426
 * @returns {string|null}
 */
export function repoKeyFromPrUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  const [owner, name] = parsed.pathname.split("/").filter(Boolean);
  return owner && name ? `${parsed.hostname.toLowerCase()}/${owner}/${name}` : null;
}

const MERGE_VALUED = new Set(["--subject", "-t", "--body", "-b", "--body-file", "-F", "--author-email", "-A", "--match-head-commit"]);

/**
 * Find a `gh pr merge` in a shell command line. `target` is the PR number,
 * URL, or branch (null: the current branch's PR); `repo` is the --repo value.
 *
 * @param {string|null|undefined} command
 * @returns {{target: string|null, repo: string|null}|null} null when the line runs no gh pr merge
 */
export function parseMergeCommand(command) {
  for (const words of simpleCommands(command) ?? []) {
    if (words[0].slice(words[0].lastIndexOf("/") + 1) !== "gh" || words[1] !== "pr" || words[2] !== "merge") continue;
    let target = null;
    let repo = null;
    for (let i = 3; i < words.length; i += 1) {
      const w = words[i];
      if (w === "--repo" || w === "-R") {
        repo = words[i + 1] ?? null;
        i += 1;
      } else if (w.startsWith("--repo=")) {
        repo = w.slice("--repo=".length);
      } else if (MERGE_VALUED.has(w)) {
        i += 1;
      } else if (!w.startsWith("-") && target === null) {
        target = w;
      }
    }
    return { target, repo };
  }
  return null;
}

/**
 * The events that matter to one session: merges by another session in a repo
 * where this session holds active claims, each with the merged files those
 * claims cover.
 *
 * @param {Array<{name: string, event: object}>} events
 * @param {object} args
 * @param {string} args.selfKey
 * @param {Record<string, Array<{pattern: string, active?: boolean}>>} args.claimsByRepo
 * @returns {Array<{event: object, overlap: string[]}>}
 */
export function relevantEvents(events, { selfKey, claimsByRepo }) {
  const out = [];
  for (const { event } of events) {
    if (event.by?.key && event.by.key === selfKey) continue;
    const claims = (claimsByRepo[event.repo] ?? []).filter((c) => c.active !== false);
    if (claims.length === 0) continue;
    const files = Array.isArray(event.files) ? event.files : [];
    const overlap = files.filter((f) => claims.some((c) => anyPathMatches(c.pattern, [f])));
    out.push({ event, overlap });
  }
  return out;
}

function list(items, max) {
  const shown = items.slice(0, max);
  return shown.join(", ") + (items.length > max ? `, +${items.length - max} more` : "");
}

/**
 * The context a session reads about merges it has not seen.
 *
 * @param {Array<{event: object, overlap: string[]}>} items
 * @returns {string}
 */
export function formatEventContext(items) {
  const lines = [];
  for (const { event, overlap } of items.slice(0, MAX_EVENTS_SHOWN)) {
    const base = event.base || "main";
    const who = event.by?.name ? ` by "${event.by.name}"` : "";
    const count = Array.isArray(event.files) ? event.files.length : 0;
    const title = event.title ? ` "${event.title}"` : "";
    lines.push(
      `dotbabel fleet: #${event.pr}${title} merged into ${base} of ${event.repo} as ${String(event.sha).slice(0, 7)}${who} (${count} file${count === 1 ? "" : "s"}).`,
    );
    if (overlap.length > 0) {
      lines.push(
        `It changed ${overlap.length} file${overlap.length === 1 ? "" : "s"} that this session claims: ${list(overlap, MAX_FILES_SHOWN)}.`,
        `Rebase your branch onto the new ${base} before you push or merge: git fetch origin && git rebase origin/${base}`,
      );
    } else {
      lines.push("None of them are files that this session claims.");
    }
  }
  if (items.length > MAX_EVENTS_SHOWN) {
    lines.push(`+${items.length - MAX_EVENTS_SHOWN} more merges. Run: dotbabel fleet events`);
  }
  return lines.join("\n");
}

const MAX_FILES_STORED = 500;

/**
 * The merge event for a pull request, from `gh pr view --json
 * number,title,state,mergeCommit,baseRefName,headRefName,files,url`.
 *
 * @param {object} pr
 * @param {{key: string, name: string|null}|null} by the session that merged it, when known
 * @param {number} now epoch ms
 * @returns {object|null} null unless the pull request is merged and names its repo
 */
export function eventFromPr(pr, by, now) {
  const repo = repoKeyFromPrUrl(pr?.url);
  if (!repo || pr.state !== "MERGED" || !pr.mergeCommit?.oid) return null;
  const files = (Array.isArray(pr.files) ? pr.files : []).map((f) => f?.path).filter((p) => typeof p === "string");
  return {
    schema: EVENT_SCHEMA,
    type: "merge",
    repo,
    pr: pr.number,
    title: pr.title ?? null,
    base: pr.baseRefName ?? null,
    head: pr.headRefName ?? null,
    sha: pr.mergeCommit.oid,
    files: files.slice(0, MAX_FILES_STORED),
    filesTruncated: files.length > MAX_FILES_STORED,
    by: by ? { key: by.key, name: by.name ?? null } : null,
    at: new Date(now).toISOString(),
  };
}

/**
 * Record a merged pull request once: a second report of the same repo, pull
 * request, and merge commit (a retried command, a manual `event --pr`) is a no-op.
 *
 * @param {string} root
 * @param {object} pr `gh pr view` JSON
 * @param {{by?: object|null, now?: number, pid?: number}} [opts]
 * @returns {{recorded: boolean, reason?: string, name?: string, event?: object}}
 */
export function recordMerge(root, pr, { by = null, now = Date.now(), pid = process.pid } = {}) {
  const event = eventFromPr(pr, by, now);
  if (!event) return { recorded: false, reason: "not-merged" };
  const known = readEvents(root, listEventNames(root)).some(
    ({ event: e }) => e.repo === event.repo && e.pr === event.pr && e.sha === event.sha,
  );
  if (known) return { recorded: false, reason: "already-recorded", event };
  return { recorded: true, name: writeEvent(root, event, { now, pid }), event };
}

/**
 * The context text for the events a session has not seen, and advance its
 * marker. On a session's first call the marker starts at the newest event, so
 * a new session is not told about merges from before it started.
 *
 * @param {string} root
 * @param {string} sessionId
 * @param {{selfKey: string, claimsByRepo: Record<string, Array<object>>}} who
 * @returns {string} "" when there is nothing to tell
 */
export function deliverEvents(root, sessionId, { selfKey, claimsByRepo }) {
  if (!SESSION_ID.test(String(sessionId))) return "";
  const names = listEventNames(root);
  const newest = names.at(-1) ?? "0";
  const seen = readSeen(root, sessionId);
  if (seen === null) {
    writeSeen(root, sessionId, newest);
    return "";
  }
  const fresh = names.filter((n) => n > seen);
  if (fresh.length === 0) return "";
  writeSeen(root, sessionId, newest);
  const items = relevantEvents(readEvents(root, fresh), { selfKey, claimsByRepo });
  return items.length > 0 ? formatEventContext(items) : "";
}
