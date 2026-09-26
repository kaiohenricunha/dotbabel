// End-to-end tests for the event feed of bin/dotbabel-fleet.mjs: the
// PostToolUse producer that records a `gh pr merge`, the PostToolUse and
// UserPromptSubmit consumers that tell a peer session, and the `events` /
// `event` commands. A fake `gh` on PATH answers `gh pr view`; every
// "session" is a real process, as in fleet-cli.test.mjs.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { listEventNames, readEvents, readSeen } from "../src/fleet/events.mjs";
import { readOwnerRecords, repoDir } from "../src/fleet/ledger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-fleet.mjs");
const GUARD = path.resolve(__dirname, "../hooks/fleet-guard.sh");
const NODE = process.execPath;
const REPO_KEY = "github.com/acme/widget";
const HAS_PROC = fs.existsSync("/proc/self/stat");
const SHA = "39b71272b8b1458fc8a411ced57d1fc1efce09d8";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, args.join(" ") + "\\n");
if (args[0] === "pr" && args[1] === "view" && !process.env.FAKE_GH_FAIL) {
  process.stdout.write(process.env.FAKE_GH_PR_JSON || "{}");
  process.exit(0);
}
process.stderr.write("fake gh: no answer\\n");
process.exit(1);
`;

function prJson(overrides = {}) {
  return JSON.stringify({
    number: 426,
    title: "feat(fleet): CPU lanes",
    state: "MERGED",
    mergeCommit: { oid: SHA },
    baseRefName: "main",
    headRefName: "feat/lanes",
    files: [{ path: "docs/a.md" }, { path: "src/x.mjs" }],
    url: "https://github.com/acme/widget/pull/426",
    ...overrides,
  });
}

function procStart(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("DOTBABEL_FLEET_") || k.startsWith("GIT_") || k.startsWith("FAKE_GH_") || k === "CLAUDE_PROJECT_DIR") {
      delete env[k];
    }
  }
  delete env.XDG_STATE_HOME;
  return { ...env, ...extra };
}

const sleepers = [];
function startSleeper() {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  const s = { child, pid: child.pid, procStart: procStart(child.pid) };
  sleepers.push(s);
  return s;
}
let peer;
let other;
beforeAll(() => {
  if (!HAS_PROC) return;
  peer = startSleeper();
  other = startSleeper();
});
afterAll(() => {
  for (const s of sleepers) s.child.kill("SIGKILL");
});

// `viaGuard` runs every hook through hooks/fleet-guard.sh, as Claude Code
// does, so the shell fast path is part of the test.
function world({ viaGuard = false } = {}) {
  const root = makeTempDir("fleet-events-cli-");
  const repo = path.join(root, "widget");
  const home = path.join(root, "home");
  const config = path.join(home, ".claude");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() });
  git(["init", "-q", "-b", "main"]);
  git(["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  fs.writeFileSync(path.join(repo, ".dotbabel.json"), "{}");
  // Every session started a minute ago, so the merges of a test come after it.
  const startedAt = Date.now() - 60_000;
  const sessions = [
    { pid: process.pid, sessionId: "sess-self", procStart: procStart(process.pid), name: "self-pane", startedAt },
    { pid: peer.pid, sessionId: "sess-peer", procStart: peer.procStart, name: "peer-pane", startedAt },
    { pid: other.pid, sessionId: "sess-other", procStart: other.procStart, name: "other-pane", startedAt },
  ];
  const register = (s) =>
    fs.writeFileSync(path.join(config, "sessions", `${s.pid}.json`), JSON.stringify({ status: "busy", ...s }));
  sessions.forEach(register);
  const log = path.join(root, "gh.log");
  const env = cleanEnv({
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    DOTBABEL_FLEET_STATE_DIR: state,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_PR_JSON: prJson(),
    FAKE_GH_LOG: log,
  });
  const w = { root, repo, state, env, log, git };
  w.hook = (event, payload, extraEnv = {}) => {
    const [cmd, ...args] = viaGuard ? ["bash", GUARD, event] : [NODE, BIN, "hook", event];
    const r = spawnSync(cmd, args, {
      input: JSON.stringify({ cwd: repo, ...payload }),
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    return r.stdout.trim() === "" ? null : JSON.parse(r.stdout).hookSpecificOutput;
  };
  w.edit = (sessionId, rel) =>
    w.hook("pre-edit", { session_id: sessionId, tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) } });
  w.bash = (sessionId, command, extraEnv) =>
    w.hook("post-tool", { session_id: sessionId, tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "" } }, extraEnv);
  w.read = (sessionId) =>
    w.hook("post-tool", { session_id: sessionId, tool_name: "Read", tool_input: { file_path: path.join(repo, "x") } });
  w.prompt = (sessionId) => w.hook("prompt", { session_id: sessionId, prompt: "go on" });
  w.events = () => readEvents(state, listEventNames(state)).map((e) => e.event);
  w.seen = (sessionId) => readSeen(state, sessionId);
  w.startAt = (sessionId, ms) => register(Object.assign(sessions.find((s) => s.sessionId === sessionId), { startedAt: ms }));
  w.claimsOf = (name) =>
    readOwnerRecords(repoDir(state, REPO_KEY))
      .filter((r) => r.owner.name === name)
      .flatMap((r) => r.claims.map((c) => c.pattern));
  w.cli = (args) => spawnSync(NODE, [BIN, ...args], { cwd: repo, env, encoding: "utf8" });
  return w;
}

describe.skipIf(!HAS_PROC)("event feed: producer and consumers", () => {
  it("records a merge and tells a peer whose claims it touched, once", () => {
    const w = world();
    w.edit("sess-peer", "docs/a.md");
    expect(w.read("sess-peer")).toBeNull(); // nothing merged yet

    expect(w.bash("sess-self", "gh pr merge 426 --squash --delete-branch")).toBeNull();
    const [event] = w.events();
    expect(event).toMatchObject({ type: "merge", repo: REPO_KEY, pr: 426, sha: SHA, base: "main" });
    expect(event.files).toEqual(["docs/a.md", "src/x.mjs"]);
    expect(event.by.name).toBe("self-pane");

    const told = w.read("sess-peer");
    expect(told.hookEventName).toBe("PostToolUse");
    expect(told.additionalContext).toContain("#426");
    expect(told.additionalContext).toContain("docs/a.md");
    expect(told.additionalContext).toContain('"self-pane"');
    expect(told.additionalContext).toContain("git rebase origin/main");

    expect(w.read("sess-peer")).toBeNull();
    expect(w.read("sess-self")).toBeNull(); // its own merge
  });

  it("delivers through UserPromptSubmit to a session that was idle", () => {
    const w = world();
    w.edit("sess-peer", "docs/a.md");
    w.prompt("sess-peer");
    w.bash("sess-self", "gh pr merge 426 --squash");
    const told = w.prompt("sess-peer");
    expect(told.hookEventName).toBe("UserPromptSubmit");
    expect(told.additionalContext).toContain("#426");
  });

  it("tells a session with claims elsewhere in the repo that main moved, without a rebase order", () => {
    const w = world();
    w.edit("sess-other", "lib/y.mjs");
    w.read("sess-other");
    w.bash("sess-self", "gh pr merge 426");
    const told = w.read("sess-other");
    expect(told.additionalContext).toMatch(/none of them/i);
    expect(told.additionalContext).not.toContain("git rebase");
  });

  it("says nothing to a session with no claims in the repo", () => {
    const w = world();
    w.read("sess-other");
    w.bash("sess-self", "gh pr merge 426");
    expect(w.read("sess-other")).toBeNull();
  });

  it("tells a session about a merge made after it started, on its first hook call", () => {
    const w = world();
    w.edit("sess-peer", "docs/a.md");
    w.bash("sess-self", "gh pr merge 426");
    expect(w.read("sess-peer").additionalContext).toContain("#426");
    expect(w.read("sess-peer")).toBeNull();
  });

  it("tells a peer about the first merge ever recorded when the hooks run through fleet-guard.sh", () => {
    const w = world({ viaGuard: true });
    w.edit("sess-peer", "docs/a.md");
    expect(w.read("sess-peer")).toBeNull(); // no event yet, so the shell exits before node
    expect(w.seen("sess-peer")).toBeNull();
    w.bash("sess-self", "gh pr merge 426 --squash");
    const told = w.read("sess-peer");
    expect(told.additionalContext).toContain("#426");
    expect(told.additionalContext).toContain("docs/a.md");
    expect(w.read("sess-peer")).toBeNull();
  });

  it("skips merges from before a session started", () => {
    const w = world();
    w.bash("sess-self", "gh pr merge 426");
    w.startAt("sess-peer", Number(listEventNames(w.state)[0].slice(0, 15)) + 1);
    w.edit("sess-peer", "docs/a.md");
    expect(w.read("sess-peer")).toBeNull();
    w.bash("sess-self", "gh pr merge 427", { FAKE_GH_PR_JSON: prJson({ number: 427, mergeCommit: { oid: "a".repeat(40) } }) });
    expect(w.read("sess-peer").additionalContext).toContain("#427");
  });

  it("passes --repo to gh and records one event per merge commit", () => {
    const w = world();
    w.bash("sess-self", "gh pr merge 426 --repo acme/widget --squash");
    w.bash("sess-self", "gh pr merge 426 --repo acme/widget --squash");
    expect(w.events()).toHaveLength(1);
    expect(fs.readFileSync(w.log, "utf8")).toMatch(/^pr view 426 --json \S+ --repo acme\/widget$/m);
  });

  it("records nothing for a pull request that is not merged, or when gh fails", () => {
    const w = world();
    w.bash("sess-self", "gh pr merge 426", { FAKE_GH_PR_JSON: prJson({ state: "OPEN", mergeCommit: null }) });
    w.bash("sess-self", "gh pr merge 426", { FAKE_GH_FAIL: "1" });
    w.bash("sess-self", "gh pr view 426");
    expect(w.events()).toEqual([]);
  });

  it("releases the merging session's claims on the merged branch", () => {
    const w = world();
    w.edit("sess-self", "docs/on-main.md");
    w.git(["checkout", "-q", "-b", "feat/lanes"]);
    w.edit("sess-self", "docs/b.md");
    w.bash("sess-self", "gh pr merge 426");
    expect(w.claimsOf("self-pane")).toEqual(["docs/on-main.md"]);
  });
});

describe.skipIf(!HAS_PROC)("dotbabel-fleet events / event", () => {
  it("lists recent merges of this repo", () => {
    const w = world();
    w.bash("sess-self", "gh pr merge 426");
    const r = w.cli(["events", "--json"]);
    expect(r.status).toBe(0);
    const list = JSON.parse(r.stdout);
    expect(list.repo).toBe(REPO_KEY);
    expect(list.events.map((e) => e.pr)).toEqual([426]);
    expect(w.cli(["events"]).stdout).toMatch(/#426 .*39b7127/);
  });

  it("records a merge made outside Claude Code, once", () => {
    const w = world();
    const first = w.cli(["event", "--pr", "426"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/recorded/i);
    const second = w.cli(["event", "--pr", "426"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already recorded/i);
    expect(w.events()).toHaveLength(1);
  });

  it("refuses to record a pull request that is not merged", () => {
    const w = world();
    const r = spawnSync(NODE, [BIN, "event", "--pr", "426"], {
      cwd: w.repo,
      env: { ...w.env, FAKE_GH_PR_JSON: prJson({ state: "OPEN", mergeCommit: null }) },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not merged/i);
  });

  it("exits 64 without --pr and 2 when gh fails", () => {
    const w = world();
    expect(w.cli(["event"]).status).toBe(64);
    const r = spawnSync(NODE, [BIN, "event", "--pr", "426"], {
      cwd: w.repo,
      env: { ...w.env, FAKE_GH_FAIL: "1" },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });
});
