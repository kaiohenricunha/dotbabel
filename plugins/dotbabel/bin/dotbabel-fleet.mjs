#!/usr/bin/env node
/**
 * dotbabel-fleet — keep concurrent Claude Code sessions off each other's
 * files and CPUs.
 *
 * A session's first edit to a file in a governed repo (one with a
 * `.dotbabel.json`) claims that path. The PreToolUse hook then denies another
 * live session's edit to it, and the deny reason names the owner to
 * SendMessage. Claims live in a machine-level ledger keyed by the repo's
 * origin URL, so every worktree and every clone of one repo share them. A
 * claim ends when its owner releases it, when the owner's process exits, or
 * when the worktree it was made in is removed.
 *
 * Event feed: after a `gh pr merge`, the post-tool hook records the merge
 * (confirmed through `gh pr view`), and every other session that claims
 * files in that repo reads it on its next tool call or prompt.
 *
 * CPU lanes: `lane` runs a command through scripts/fleet-lane.sh, which waits
 * for a free lane of CPUs and pins the command to it, and `lanes` shows who
 * holds each lane. hooks/fleet-shell-prefix.sh (the CLAUDE_CODE_SHELL_PREFIX
 * target) sends heavy Bash tool commands to the same script.
 *
 * ALL git and bash shell-outs live here. `src/fleet/*` decides, stores, and formats.
 *
 * Usage:
 *   dotbabel fleet board   [--json]
 *   dotbabel fleet claim   <pattern>... [--note <text>] [--json]
 *   dotbabel fleet release <pattern>... | --all
 *   dotbabel fleet prune
 *   dotbabel fleet hook    pre-edit | session-start | post-tool | prompt   (hook JSON on stdin)
 *   dotbabel fleet lane    [--name <label>] -- <command> [args...]
 *   dotbabel fleet lanes   [--json]
 *   dotbabel fleet events  [--all] [--json]
 *   dotbabel fleet event   --pr <N> [--repo <owner/name>]
 *
 * Environment:
 *   DOTBABEL_FLEET_MODE=off               turn the hooks off
 *   DOTBABEL_FLEET_ESCALATE_MINUTES=<n>   ask the user after n minutes of blocks (default 15, 0 = never)
 *   DOTBABEL_FLEET_STATE_DIR=<dir>        ledger root (default $XDG_STATE_HOME/dotbabel/fleet)
 *   CLAUDE_CONFIG_DIR                     where Claude Code keeps sessions/ (default ~/.claude)
 *
 * Exits:
 *   0   ok. `hook` always exits 0: it fails open, so a broken ledger never blocks an edit
 *   1   `claim` refused: a live peer holds an overlapping claim
 *   N   `lane`: the command's own exit status
 *   2   environment error: not in a git repo, or not inside a Claude Code session
 *   64  bad CLI invocation
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokedDirectly, misfiredAs } from "../src/lib/invoked-direct.mjs";
import { parse } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import {
  formatAskReason,
  formatBoard,
  formatDenyReason,
  formatSessionContext,
} from "../src/fleet/format.mjs";
import { deliverEvents, listEventNames, parseMergeCommand, readEvents, recordMerge } from "../src/fleet/events.mjs";
import { formatLanes, parseLayout, readLaneState } from "../src/fleet/lanes.mjs";
import {
  RECORD_SCHEMA,
  listRepoDirs,
  ownClaimsByRepo,
  readDenials,
  readOwnerRecords,
  removeOwnerRecord,
  repoDir,
  stateRoot,
  writeDenials,
  writeOwnerRecord,
} from "../src/fleet/ledger.mjs";
import {
  addClaim,
  decideEdit,
  isSharedPath,
  normalizePattern,
  normalizeRemote,
  patternsOverlap,
  releaseClaims,
} from "../src/fleet/policy.mjs";
import { findSelf, isOwnerAlive, ownerFromEntry, readRegistry, sessionsDir } from "../src/fleet/registry.mjs";

const TOOL = "dotbabel-fleet";
const SELF_PATH = fileURLToPath(import.meta.url);
const LANE_SCRIPT = path.resolve(path.dirname(SELF_PATH), "../scripts/fleet-lane.sh");
const SUBCOMMANDS = new Set(["board", "claim", "release", "prune", "hook", "lane", "lanes", "events", "event"]);
const PR_FIELDS = "number,title,state,mergeCommit,baseRefName,headRefName,files,url";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DEFAULT_ESCALATE_MINUTES = 15;

const USAGE = `Usage:
  dotbabel fleet board   [--json]                       show the claims in this repo
  dotbabel fleet claim   <pattern>... [--note <text>]   claim paths or globs for this session
  dotbabel fleet release <pattern>... | --all           release this session's claims
  dotbabel fleet prune                                  remove claims of exited sessions
  dotbabel fleet hook    <event>                        Claude Code hook entry (JSON on stdin):
                                                        pre-edit, session-start, post-tool, prompt
  dotbabel fleet lane    [--name <label>] -- <cmd>...   run a command in a free CPU lane
  dotbabel fleet lanes   [--json]                       show the CPU lanes and who holds them
  dotbabel fleet events  [--all] [--json]               show recent merges in this repo (or all repos)
  dotbabel fleet event   --pr <N> [--repo <owner/name>] record a merge made outside Claude Code

Patterns are relative to the repo root. A bare path also covers everything
below it; ** and * are globs.

Exit codes: 0 ok, 1 claim refused, 2 env error, 64 usage error.`;

class UsageError extends Error {}
class EnvError extends Error {}

// ---------------------------------------------------------------- git ----

/** Git with the caller's GIT_DIR / GIT_WORK_TREE removed, so -C decides the repo. */
function git(cwd, args) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
  return r.status === 0 ? r.stdout : null;
}

/** The nearest existing directory at or above `target`, and the segments below it. */
function nearestDir(target) {
  let dir = path.resolve(target);
  const rest = [];
  if (!isDir(dir)) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  while (!isDir(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
  return { dir, rest };
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The repo that holds `target`, with the target's repo-relative path.
 * `target` can name a file or directory that does not exist yet.
 */
function resolveRepo(target) {
  const near = nearestDir(target);
  if (!near) return null;
  const out = git(near.dir, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
    "--show-prefix",
  ]);
  if (out === null) return null;
  const [toplevel, commonDir, prefix = ""] = out.split("\n");
  if (!toplevel || !commonDir) return null;
  const rel = [prefix.replace(/\/+$/, ""), ...near.rest].filter(Boolean).join("/");
  const remote = git(toplevel, ["config", "--get", "remote.origin.url"]);
  const key = normalizeRemote(remote) ?? `local:${commonDir}`;
  const branch = (git(toplevel, ["symbolic-ref", "--short", "-q", "HEAD"]) ?? "").trim() || null;
  const config = readFleetConfig(toplevel);
  return { toplevel, rel, key, branch, governed: config !== null, config: config ?? {} };
}

/** `.dotbabel.json` → its `fleet` object; null when the repo is not governed. */
function readFleetConfig(toplevel) {
  const file = path.join(toplevel, ".dotbabel.json");
  if (!fs.existsSync(file)) return null;
  try {
    const fleet = JSON.parse(fs.readFileSync(file, "utf8"))?.fleet;
    return fleet && typeof fleet === "object" && !Array.isArray(fleet) ? fleet : {};
  } catch {
    return {};
  }
}

function isIgnored(toplevel, rel) {
  return git(toplevel, ["check-ignore", "-q", "--", rel]) !== null;
}

// ------------------------------------------------------------ settings ----

function fleetOff(repo) {
  return (process.env.DOTBABEL_FLEET_MODE || repo.config.mode) === "off";
}

function sharedGlobs(repo) {
  const shared = repo.config.shared;
  return Array.isArray(shared) ? shared.filter((s) => typeof s === "string") : [];
}

function escalateAfterMs(repo) {
  const raw = process.env.DOTBABEL_FLEET_ESCALATE_MINUTES ?? repo.config.escalate_after_minutes;
  const minutes = raw === undefined || raw === "" ? NaN : Number(raw);
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_ESCALATE_MINUTES) * 60_000;
}

/** How a session should run this CLI: the `dotbabel` on PATH, or this file. */
function cliCommand() {
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, "dotbabel")));
  return onPath ? "dotbabel fleet" : `node ${JSON.stringify(SELF_PATH)}`;
}

// -------------------------------------------------------------- owners ----

/** True when the registry can vouch for liveness: readable, with a live entry. */
function registryHealthy(registry) {
  return registry.ok && registry.entries.some((e) => isOwnerAlive(e));
}

/**
 * Owner views for a repo ledger. With `prune`, records of exited owners are
 * deleted instead of returned — only call it that way when the registry is
 * healthy, or a changed registry format would read as "everyone exited".
 */
function loadOwners(dir, registry, { prune, selfKey = null }) {
  const byPid = new Map(registry.entries.map((e) => [e.pid, e]));
  const owners = [];
  let removed = 0;
  for (const record of readOwnerRecords(dir)) {
    const alive = isOwnerAlive(record.owner);
    if (!alive && prune) {
      removeOwnerRecord(dir, record.owner.key);
      removed += 1;
      continue;
    }
    const entry = byPid.get(record.owner.pid);
    const live = entry && ownerFromEntry(entry).key === record.owner.key ? entry : null;
    owners.push({
      key: record.owner.key,
      name: live?.name ?? record.owner.name ?? `pid ${record.owner.pid}`,
      status: live?.status ?? (alive ? "unknown" : "exited"),
      alive,
      self: record.owner.key === selfKey,
      record,
      claims: record.claims.map((c) => ({ ...c, active: !c.worktree || fs.existsSync(c.worktree) })),
    });
  }
  return { owners, removed };
}

function emptyRecord(repoKey, owner) {
  return { schema: RECORD_SCHEMA, repo: repoKey, owner, claims: [], updatedAt: new Date().toISOString() };
}

/** This session's record with the current identity, minus claims whose worktree is gone. */
function ownRecord(owners, repoKey, self) {
  const record = owners.find((o) => o.key === self.key)?.record ?? emptyRecord(repoKey, self);
  return { ...record, owner: self, claims: record.claims.filter((c) => !c.worktree || fs.existsSync(c.worktree)) };
}

/** Save an owner record, or remove it when no claim is left. */
function saveRecord(dir, record) {
  if (record.claims.length === 0) removeOwnerRecord(dir, record.owner.key);
  else writeOwnerRecord(dir, record);
}

// --------------------------------------------------------------- hooks ----

/**
 * PreToolUse on Edit / Write / MultiEdit / NotebookEdit. Returns the hook
 * output object, or null to allow silently.
 */
function preEdit(input, now) {
  if (!EDIT_TOOLS.has(input.tool_name)) return null;
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof target !== "string" || target === "") return null;
  const abs = path.isAbsolute(target) ? target : path.resolve(input.cwd || process.cwd(), target);

  const repo = resolveRepo(abs);
  if (!repo?.governed || fleetOff(repo) || !repo.rel) return null;
  if (isSharedPath(repo.rel, sharedGlobs(repo)) || isIgnored(repo.toplevel, repo.rel)) return null;

  const registry = readRegistry(sessionsDir());
  const selfEntry = findSelf({ entries: registry.entries, sessionId: input.session_id, startPid: process.ppid });
  if (!selfEntry) return null;
  const self = ownerFromEntry(selfEntry);
  const dir = repoDir(stateRoot(), repo.key);
  const window = escalateAfterMs(repo);
  const denials = readDenials(dir, self.key);
  const judge = (owners) =>
    decideEdit({ rel: repo.rel, selfKey: self.key, owners, denial: denials[repo.rel] ?? null, now, escalateAfterMs: window });

  let { owners } = loadOwners(dir, registry, { prune: true, selfKey: self.key });
  let verdict = judge(owners);
  if (verdict.action === "allow" && verdict.claimNeeded) {
    const claim = {
      pattern: repo.rel,
      source: "auto",
      // Stamp the write, not the start of this hook. A session whose re-read
      // below misses a peer then always holds the earlier claim, so the peer's
      // own re-read makes it yield.
      claimedAt: new Date().toISOString(),
      branch: repo.branch,
      worktree: repo.toplevel,
      note: null,
    };
    writeOwnerRecord(dir, addClaim(ownRecord(owners, repo.key, self), claim));
    // Two sessions can pass the check in the same moment. Read again; the
    // later claim yields, and both sides compute the same order.
    ({ owners } = loadOwners(dir, registry, { prune: false, selfKey: self.key }));
    verdict = judge(owners);
    if (verdict.action !== "allow") {
      const again = owners.find((o) => o.key === self.key)?.record;
      if (again) saveRecord(dir, releaseClaims(again, [repo.rel]).record);
    }
  }

  if (verdict.action === "allow") {
    if (denials[repo.rel]) {
      delete denials[repo.rel];
      writeDenials(dir, self.key, denials);
    }
    return null;
  }
  if (verdict.action === "deny" && window > 0) {
    denials[repo.rel] = { owner: verdict.conflict.owner.key, firstDeniedAt: verdict.firstDeniedAt };
    writeDenials(dir, self.key, denials);
  }
  const reason =
    verdict.action === "ask"
      ? formatAskReason({ rel: repo.rel, conflict: verdict.conflict, since: verdict.since, now })
      : formatDenyReason({
          rel: repo.rel,
          repoKey: repo.key,
          conflict: verdict.conflict,
          cli: cliCommand(),
          escalateAt: verdict.escalateAt,
          now,
        });
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: verdict.action, permissionDecisionReason: reason },
  };
}

/** SessionStart: the claims in the session's repo, as plain context text. */
function sessionStart(input) {
  const repo = resolveRepo(input.cwd || process.cwd());
  if (!repo?.governed || fleetOff(repo)) return "";
  const registry = readRegistry(sessionsDir());
  const selfEntry = findSelf({ entries: registry.entries, sessionId: input.session_id, startPid: process.ppid });
  const selfKey = selfEntry ? ownerFromEntry(selfEntry).key : null;
  const { owners } = loadOwners(repoDir(stateRoot(), repo.key), registry, {
    prune: selfEntry !== null,
    selfKey,
  });
  return formatSessionContext({ repoKey: repo.key, owners, cli: cliCommand() });
}

function runHook(event) {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  if (event === "pre-edit") {
    const out = preEdit(input, Date.now());
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } else if (event === "session-start") {
    const text = sessionStart(input);
    if (text) process.stdout.write(`${text}\n`);
  } else if (event === "post-tool" || event === "prompt") {
    const out = eventHook(input, event);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}

// ------------------------------------------------------------ commands ----

function requireRepo() {
  const repo = resolveRepo(process.cwd());
  if (!repo) throw new EnvError("not inside a git repository");
  return repo;
}

function requireSelf(registry) {
  const entry = findSelf({ entries: registry.entries, startPid: process.ppid });
  if (!entry) {
    throw new EnvError(
      "cannot find the Claude Code session that runs this command. Run it from a Claude Code session (Bash tool).",
    );
  }
  return ownerFromEntry(entry);
}

function cmdBoard(args) {
  const repo = requireRepo();
  const registry = readRegistry(sessionsDir());
  const selfEntry = findSelf({ entries: registry.entries, startPid: process.ppid });
  const selfKey = selfEntry ? ownerFromEntry(selfEntry).key : null;
  const { owners, removed } = loadOwners(repoDir(stateRoot(), repo.key), registry, {
    prune: registryHealthy(registry),
    selfKey,
  });
  if (args.json) {
    const view = owners.map(({ record, ...o }) => ({ ...o, pid: record.owner.pid }));
    process.stdout.write(`${JSON.stringify({ repo: repo.key, self: selfKey, owners: view, removed }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatBoard({ repoKey: repo.key, owners, removed, now: Date.now() })}\n`);
  }
  return EXIT_CODES.OK;
}

function cmdClaim(args) {
  if (args.positional.length === 0) throw new UsageError("claim needs at least one pattern");
  const patterns = args.positional.map((p) => {
    try {
      return normalizePattern(p);
    } catch (err) {
      throw new UsageError(/** @type {Error} */ (err).message);
    }
  });
  const repo = requireRepo();
  const registry = readRegistry(sessionsDir());
  const self = requireSelf(registry);
  const dir = repoDir(stateRoot(), repo.key);
  const { owners } = loadOwners(dir, registry, { prune: true, selfKey: self.key });

  const conflicts = [];
  for (const pattern of patterns) {
    for (const o of owners.filter((x) => x.alive && x.key !== self.key)) {
      for (const c of o.claims.filter((x) => x.active && patternsOverlap(pattern, x.pattern))) {
        conflicts.push(`  ${pattern}: "${o.name}" claims ${c.pattern}${c.branch ? ` (branch ${c.branch})` : ""}`);
      }
    }
  }
  if (conflicts.length > 0) {
    process.stderr.write(
      `${TOOL}: claim refused. Live sessions hold overlapping claims:\n${conflicts.join("\n")}\n` +
        "SendMessage each owner to agree on the split, or claim a narrower pattern.\n",
    );
    return EXIT_CODES.VALIDATION;
  }

  let record = ownRecord(owners, repo.key, self);
  const claimedAt = new Date().toISOString();
  const note = typeof args.flags.note === "string" && args.flags.note.trim() ? args.flags.note.trim() : null;
  for (const pattern of patterns) {
    record = addClaim(record, { pattern, source: "explicit", claimedAt, branch: repo.branch, worktree: repo.toplevel, note });
  }
  writeOwnerRecord(dir, record);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ repo: repo.key, owner: self, claimed: patterns }, null, 2)}\n`);
  } else {
    process.stdout.write(`Claimed ${patterns.join(", ")} in ${repo.key} for "${self.name ?? self.key}".\n`);
    if (!repo.governed) {
      process.stdout.write(`Note: ${repo.toplevel} has no .dotbabel.json, so the edit guard does not run there.\n`);
    }
  }
  return EXIT_CODES.OK;
}

function cmdRelease(args) {
  const all = Boolean(args.flags.all);
  if (!all && args.positional.length === 0) throw new UsageError("release needs a pattern or --all");
  const patterns = all
    ? "all"
    : args.positional.map((p) => {
        try {
          return normalizePattern(p);
        } catch (err) {
          throw new UsageError(/** @type {Error} */ (err).message);
        }
      });
  const repo = requireRepo();
  const registry = readRegistry(sessionsDir());
  const self = requireSelf(registry);
  const dir = repoDir(stateRoot(), repo.key);
  const mine = readOwnerRecords(dir).find((r) => r.owner.key === self.key);
  if (!mine) {
    process.stdout.write("This session holds no claims in this repo.\n");
    return EXIT_CODES.OK;
  }
  const { record, removed } = releaseClaims(mine, patterns);
  saveRecord(dir, { ...record, updatedAt: new Date().toISOString() });
  process.stdout.write(
    removed.length === 0
      ? "No claim matched.\n"
      : `Released ${removed.map((c) => c.pattern).join(", ")} in ${repo.key}.\n`,
  );
  return EXIT_CODES.OK;
}

function cmdPrune() {
  const registry = readRegistry(sessionsDir());
  if (!registryHealthy(registry)) {
    throw new EnvError(`cannot read a live Claude Code session registry at ${sessionsDir()}, so liveness is unknown`);
  }
  let removed = 0;
  for (const dir of listRepoDirs(stateRoot())) {
    removed += loadOwners(dir, registry, { prune: true }).removed;
  }
  process.stdout.write(`prune: removed ${removed} claim record${removed === 1 ? "" : "s"} of exited sessions.\n`);
  return EXIT_CODES.OK;
}

// -------------------------------------------------------------- events ----

/** `gh pr view` JSON for a merge target (null: the current branch's PR), or null when gh fails. */
function ghPrView(target, repo, cwd) {
  const args = ["pr", "view", ...(target ? [target] : []), "--json", PR_FIELDS, ...(repo ? ["--repo", repo] : [])];
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Record a confirmed merge, then release the merging session's own claims on
 * the merged branch: that work has landed.
 */
function recordMergeBy(pr, self) {
  const root = stateRoot();
  const result = recordMerge(root, pr, { by: self });
  if (self && result.event?.head) {
    const dir = repoDir(root, result.event.repo);
    const mine = readOwnerRecords(dir).find((r) => r.owner.key === self.key);
    const kept = mine ? mine.claims.filter((c) => c.branch !== result.event.head) : [];
    if (mine && kept.length !== mine.claims.length) {
      saveRecord(dir, { ...mine, claims: kept, updatedAt: new Date().toISOString() });
    }
  }
  return result;
}

/**
 * PostToolUse (`post-tool`) and UserPromptSubmit (`prompt`): record a
 * `gh pr merge` this session just ran, then tell the session about merges it
 * has not seen. fleet-guard.sh starts this only when there is something to do.
 */
function eventHook(input, event) {
  const registry = readRegistry(sessionsDir());
  const selfEntry = findSelf({ entries: registry.entries, sessionId: input.session_id, startPid: process.ppid });
  const self = selfEntry ? ownerFromEntry(selfEntry) : null;
  if (event === "post-tool" && input.tool_name === "Bash") {
    const merge = parseMergeCommand(input.tool_input?.command);
    const pr = merge ? ghPrView(merge.target, merge.repo, input.cwd || process.cwd()) : null;
    if (pr) recordMergeBy(pr, self);
  }
  const root = stateRoot();
  // An unidentified session still advances its marker, so the shell fast path stays fast.
  const text = deliverEvents(root, input.session_id, {
    selfKey: self?.key ?? null,
    claimsByRepo: self ? ownClaimsByRepo(root, self.key) : {},
  });
  if (!text) return null;
  const hookEventName = event === "prompt" ? "UserPromptSubmit" : "PostToolUse";
  return { hookSpecificOutput: { hookEventName, additionalContext: text } };
}

/** `events [--all] [--json]`: the merges recorded in the last 7 days, newest first. */
function cmdEvents(args) {
  const all = Boolean(args.flags.all);
  const repo = all ? null : requireRepo();
  const events = readEvents(stateRoot(), listEventNames(stateRoot()))
    .map((e) => e.event)
    .filter((e) => all || e.repo === repo.key)
    .reverse();
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ repo: repo?.key ?? null, events }, null, 2)}\n`);
    return EXIT_CODES.OK;
  }
  if (events.length === 0) {
    process.stdout.write(`No merges recorded${repo ? ` for ${repo.key}` : ""} in the last 7 days.\n`);
    return EXIT_CODES.OK;
  }
  for (const e of events) {
    const when = String(e.at).slice(0, 16).replace("T", " ");
    const count = Array.isArray(e.files) ? e.files.length : 0;
    const cols = [when, `#${e.pr} ${e.title ?? ""}`.trim(), String(e.sha).slice(0, 7), `${count} files`];
    if (e.by?.name) cols.push(`by ${e.by.name}`);
    if (all) cols.push(e.repo);
    process.stdout.write(`${cols.join("  ")}\n`);
  }
  return EXIT_CODES.OK;
}

/** `event --pr <N> [--repo <owner/name>]`: record a merge made outside Claude Code. */
function cmdEvent(args) {
  if (typeof args.flags.pr !== "string" || args.flags.pr === "") throw new UsageError("event needs --pr <number>");
  const repo = typeof args.flags.repo === "string" ? args.flags.repo : null;
  const pr = ghPrView(args.flags.pr, repo, process.cwd());
  if (!pr) throw new EnvError("gh pr view failed. Check `gh auth status` and the --pr and --repo values.");
  const selfEntry = findSelf({ entries: readRegistry(sessionsDir()).entries, startPid: process.ppid });
  const result = recordMergeBy(pr, selfEntry ? ownerFromEntry(selfEntry) : null);
  if (result.reason === "not-merged") {
    process.stderr.write(`${TOOL}: #${pr.number ?? args.flags.pr} is not merged, so there is nothing to record.\n`);
    return EXIT_CODES.VALIDATION;
  }
  const what = `#${result.event.pr} (${String(result.event.sha).slice(0, 7)}) in ${result.event.repo}`;
  process.stdout.write(result.recorded ? `Recorded the merge of ${what}.\n` : `Already recorded: ${what}.\n`);
  return EXIT_CODES.OK;
}

// --------------------------------------------------------------- lanes ----

/**
 * `lane [--name <label>] -- <command> [args...]`. Parsed by hand, because the
 * command's own flags must reach it untouched. Resolves to the command's exit
 * status. SIGINT is left to the terminal, which sends it to the whole process
 * group; SIGTERM and SIGHUP are forwarded, since they reach only this process.
 */
function cmdLane(argv) {
  let name = null;
  let i = 0;
  while (i < argv.length && argv[i] !== "--") {
    if (argv[i] !== "--name") break;
    if (argv[i + 1] === undefined) throw new UsageError("--name needs a value");
    name = argv[i + 1];
    i += 2;
  }
  if (argv[i] === "--") i += 1;
  const command = argv.slice(i);
  if (command.length === 0) throw new UsageError("lane needs a command: dotbabel fleet lane -- <command> [args...]");

  const env = { ...process.env };
  if (!env.DOTBABEL_LANE_SESSION) {
    const self = findSelf({ entries: readRegistry(sessionsDir()).entries, startPid: process.ppid });
    if (self?.name) env.DOTBABEL_LANE_SESSION = self.name;
  }
  const args = [LANE_SCRIPT, ...(name ? ["--name", name] : []), "--", ...command];
  return new Promise((resolve) => {
    const child = spawn("bash", args, { stdio: "inherit", env });
    const ignoreInt = () => {};
    const forward = (sig) => child.kill(sig);
    process.on("SIGINT", ignoreInt);
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
    child.on("error", (err) => {
      process.stderr.write(`${TOOL}: cannot run bash: ${err.message}\n`);
      resolve(EXIT_CODES.ENV);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignoreInt);
      process.off("SIGTERM", forward);
      process.off("SIGHUP", forward);
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

/** `lanes [--json]`: the layout from fleet-lane.sh, and who holds or waits for each lane. */
function cmdLanes(args) {
  const r = spawnSync("bash", [LANE_SCRIPT, "--layout"], { encoding: "utf8" });
  if (r.status !== 0) throw new EnvError(`cannot read the lane layout: ${(r.stderr || "bash failed").trim()}`);
  const layout = parseLayout(r.stdout);
  const killSwitch = path.join(stateRoot(), "lanes.off");
  const switchedOff = fs.existsSync(killSwitch);
  const { holders, waiters } = layout.off ? { holders: {}, waiters: [] } : readLaneState(path.join(stateRoot(), "lanes"), layout);
  if (args.json) {
    const view = (info) => ({
      pid: Number(info.pid),
      label: info.label ?? null,
      session: info.session || null,
      cwd: info.cwd ?? null,
      startedAt: new Date(Number(info.started) * 1000).toISOString(),
    });
    const out = {
      off: layout.off || switchedOff,
      killSwitch: switchedOff ? killSwitch : null,
      ncpu: layout.ncpu,
      lanes: layout.lanes.map((l) => ({ ...l, holder: holders[l.index] ? view(holders[l.index]) : null })),
      waiters: waiters.map(view),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatLanes({ layout, holders, waiters, now: Date.now() })}\n`);
    if (switchedOff) process.stdout.write(`The kill switch ${killSwitch} is on, so commands run without a lane.\n`);
  }
  return EXIT_CODES.OK;
}

function main(argv) {
  if (argv[0] === "lane") {
    try {
      return cmdLane(argv.slice(1));
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      process.stderr.write(`${TOOL}: ${err.message}\n`);
      return EXIT_CODES.USAGE;
    }
  }
  let args;
  try {
    args = parse(argv, {
      note: { type: "string" },
      all: { type: "boolean" },
      pr: { type: "string" },
      repo: { type: "string" },
    });
  } catch (err) {
    process.stderr.write(`${TOOL}: ${/** @type {Error} */ (err).message}\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  const [sub, ...rest] = args.positional;
  if (args.help || !sub) {
    process.stdout.write(`${USAGE}\n`);
    return args.help ? EXIT_CODES.OK : EXIT_CODES.USAGE;
  }
  if (!SUBCOMMANDS.has(sub)) {
    process.stderr.write(`${TOOL}: unknown subcommand "${sub}"\n${USAGE}\n`);
    return EXIT_CODES.USAGE;
  }
  if (sub === "hook") {
    // A hook must never fail the edit it guards: any error allows it.
    try {
      runHook(rest[0]);
    } catch (err) {
      if (process.env.DOTBABEL_FLEET_DEBUG) process.stderr.write(`${TOOL}: ${/** @type {Error} */ (err).stack}\n`);
    }
    return EXIT_CODES.OK;
  }
  const subArgs = { ...args, positional: rest };
  try {
    if (sub === "board") return cmdBoard(subArgs);
    if (sub === "claim") return cmdClaim(subArgs);
    if (sub === "release") return cmdRelease(subArgs);
    if (sub === "lanes") return cmdLanes(subArgs);
    if (sub === "events") return cmdEvents(subArgs);
    if (sub === "event") return cmdEvent(subArgs);
    return cmdPrune();
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${TOOL}: ${err.message}\n`);
      return EXIT_CODES.USAGE;
    }
    if (err instanceof EnvError) {
      process.stderr.write(`${TOOL}: ${err.message}\n`);
      return EXIT_CODES.ENV;
    }
    throw err;
  }
}

if (invokedDirectly(import.meta.url)) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
} else if (misfiredAs(TOOL)) {
  process.stderr.write(`${TOOL}: entry guard did not match argv[1]=${process.argv[1]}\n`);
  process.exitCode = EXIT_CODES.ENV;
}
