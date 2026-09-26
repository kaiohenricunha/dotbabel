// End-to-end tests for the merge token of bin/dotbabel-fleet.mjs: the
// PreToolUse Bash hook (`pre-bash`) that takes the token for a rebase onto the
// base, a local-attest, or a gh pr merge, and denies a peer while the token is
// held; the release after a recorded merge; the shared-file edit check; and the
// `token` command. Every "session" is a real process, as in fleet-cli.test.mjs.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { repoDir } from "../src/fleet/ledger.mjs";
import { readToken } from "../src/fleet/token.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-fleet.mjs");
const GUARD = path.resolve(__dirname, "../hooks/fleet-guard.sh");
const NODE = process.execPath;
const REPO_KEY = "github.com/acme/widget";
const HAS_PROC = fs.existsSync("/proc/self/stat");

const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(process.env.FAKE_GH_PR_JSON || "{}");
  process.exit(0);
}
process.exit(1);
`;

function prJson(number, head) {
  return JSON.stringify({
    number,
    title: `pr ${number}`,
    state: "MERGED",
    mergeCommit: { oid: String(number).repeat(40).slice(0, 40) },
    baseRefName: "main",
    headRefName: head,
    files: [{ path: "src/x.mjs" }],
    url: `https://github.com/acme/widget/pull/${number}`,
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
beforeAll(() => {
  if (HAS_PROC) peer = startSleeper();
});
afterAll(() => {
  for (const s of sleepers) s.child.kill("SIGKILL");
});

function world({ viaGuard = false } = {}) {
  const root = makeTempDir("fleet-token-cli-");
  const repo = path.join(root, "widget");
  const config = path.join(root, "home", ".claude");
  const state = path.join(root, "state");
  const bin = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() });
  git(["init", "-q", "-b", "main"]);
  git(["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  git(["checkout", "-q", "-b", "feat/x"]);
  fs.writeFileSync(path.join(repo, ".dotbabel.json"), "{}");
  const startedAt = Date.now() - 60_000;
  const register = (s) =>
    fs.writeFileSync(path.join(config, "sessions", `${s.pid}.json`), JSON.stringify({ status: "busy", startedAt, ...s }));
  register({ pid: process.pid, sessionId: "sess-self", procStart: procStart(process.pid), name: "self-pane" });
  register({ pid: peer.pid, sessionId: "sess-peer", procStart: peer.procStart, name: "peer-pane" });
  const env = cleanEnv({
    HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: config,
    DOTBABEL_FLEET_STATE_DIR: state,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_PR_JSON: prJson(426, "feat/x"),
  });
  const w = { root, repo, state, env, git, register };
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
  w.bash = (sessionId, command, extra = {}) =>
    w.hook("pre-bash", { session_id: sessionId, tool_name: "Bash", tool_input: { command }, ...extra.payload }, extra.env);
  w.ran = (sessionId, command) =>
    w.hook("post-tool", { session_id: sessionId, tool_name: "Bash", tool_input: { command }, tool_response: { stdout: "" } });
  w.edit = (sessionId, rel) =>
    w.hook("pre-edit", { session_id: sessionId, tool_name: "Edit", tool_input: { file_path: path.join(repo, rel) } });
  w.token = () => readToken(repoDir(state, REPO_KEY));
  w.cli = (args) => spawnSync(NODE, [BIN, ...args], { cwd: repo, env, encoding: "utf8" });
  return w;
}

describe.skipIf(!HAS_PROC)("merge token: pre-bash hook", () => {
  it("takes the token for a rebase onto main and denies a peer's local-attest, naming the holder", () => {
    const w = world();
    expect(w.bash("sess-self", "git fetch origin && git rebase origin/main")).toBeNull();
    expect(w.token()).toMatchObject({ owner: { name: "self-pane" }, branch: "feat/x", kind: "rebase" });

    const out = w.bash("sess-peer", "dotbabel local-attest --pr 5 --no-push");
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain('"self-pane" holds the merge token for github.com/acme/widget');
    expect(w.token().owner.name).toBe("self-pane");
  });

  it("frees the token when the holder's merge is recorded", () => {
    const w = world();
    w.bash("sess-self", "git rebase origin/main");
    expect(w.bash("sess-self", "gh pr merge 426 --squash")).toBeNull();
    w.ran("sess-self", "gh pr merge 426 --squash");
    expect(w.token()).toBeNull();
    expect(w.bash("sess-peer", "gh pr merge 427 --squash")).toBeNull();
    expect(w.token().owner.name).toBe("peer-pane");
  });

  it("gives a peer the token of a session that exited", async () => {
    const w = world();
    const gone = startSleeper();
    w.register({ pid: gone.pid, sessionId: "sess-gone", procStart: gone.procStart, name: "gone-pane" });
    w.bash("sess-gone", "git rebase origin/main");
    expect(w.token().owner.name).toBe("gone-pane");
    // Wait on the event loop, so node reaps the child and no zombie stays in /proc.
    const exited = new Promise((resolve) => gone.child.once("exit", resolve));
    gone.child.kill("SIGKILL");
    await exited;
    expect(w.bash("sess-peer", "git rebase origin/main")).toBeNull();
    expect(w.token().owner.name).toBe("peer-pane");
  });

  it("gives a peer an idle token after the idle window", () => {
    const w = world();
    w.bash("sess-self", "git rebase origin/main");
    expect(w.bash("sess-peer", "git rebase origin/main", { env: { DOTBABEL_FLEET_TOKEN_IDLE_MINUTES: "0" } })).toBeNull();
    expect(w.token().owner.name).toBe("peer-pane");
  });

  it("keeps the token fresh after the holder's local-attest ends", () => {
    const w = world();
    w.bash("sess-self", "dotbabel local-attest --pr 5");
    const before = w.token().touchedAt;
    execFileSync("sleep", ["0.02"]);
    w.ran("sess-self", "dotbabel local-attest --pr 5");
    expect(Date.parse(w.token().touchedAt)).toBeGreaterThan(Date.parse(before));
  });

  it("checks the token of the --repo repository for a merge run outside a checkout", () => {
    const w = world();
    w.bash("sess-self", "git rebase origin/main");
    const out = w.bash("sess-peer", "gh pr merge 5 --repo acme/widget --squash", { payload: { cwd: w.root } });
    expect(out.permissionDecision).toBe("deny");
  });

  it("needs no token for other commands, ungoverned repos, or with the fleet off", () => {
    const w = world();
    expect(w.bash("sess-self", "git status && ls")).toBeNull();
    expect(w.bash("sess-self", "git rebase origin/main", { env: { DOTBABEL_FLEET_MODE: "off" } })).toBeNull();
    expect(w.token()).toBeNull();
    fs.rmSync(path.join(w.repo, ".dotbabel.json"));
    expect(w.bash("sess-self", "git rebase origin/main")).toBeNull();
    expect(w.token()).toBeNull();
  });

  it("denies a peer through fleet-guard.sh, as Claude Code runs it", () => {
    const w = world({ viaGuard: true });
    expect(w.bash("sess-self", "git rebase origin/main")).toBeNull();
    expect(w.bash("sess-peer", "gh pr merge 5 --squash").permissionDecision).toBe("deny");
  });
});

describe.skipIf(!HAS_PROC)("merge token: shared files", () => {
  it("denies a peer's edit of a shared file while the token is held, and allows the holder's", () => {
    const w = world();
    expect(w.edit("sess-peer", "package-lock.json")).toBeNull(); // no token yet
    w.bash("sess-self", "git rebase origin/main");
    const out = w.edit("sess-peer", "package-lock.json");
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("merge token");
    expect(out.permissionDecisionReason).toContain("package-lock.json");
    expect(w.edit("sess-self", "package-lock.json")).toBeNull();
  });
});

describe.skipIf(!HAS_PROC)("dotbabel-fleet token", () => {
  it("shows, takes, and releases the token of this repo", () => {
    const w = world();
    expect(w.cli(["token"]).stdout).toContain("Merge token for github.com/acme/widget: free.");
    const take = w.cli(["token", "take"]);
    expect(take.status).toBe(0);
    expect(w.token().owner.name).toBe("self-pane");
    expect(w.cli(["token", "status"]).stdout).toContain('held by "self-pane"');
    expect(JSON.parse(w.cli(["token", "--json"]).stdout)).toMatchObject({ repo: REPO_KEY, holder: { owner: { name: "self-pane" } } });
    expect(w.cli(["token", "release"]).status).toBe(0);
    expect(w.token()).toBeNull();
    expect(w.cli(["token", "release"]).status).toBe(1);
  });

  it("refuses to take a token that a peer holds, and the board shows the holder", () => {
    const w = world();
    w.bash("sess-peer", "git rebase origin/main");
    const take = w.cli(["token", "take"]);
    expect(take.status).toBe(1);
    expect(take.stderr).toContain('"peer-pane" holds the merge token');
    expect(w.cli(["board"]).stdout).toContain('Merge token for github.com/acme/widget: held by "peer-pane"');
  });

  it("exits 64 for an unknown token action", () => {
    expect(world().cli(["token", "steal"]).status).toBe(64);
  });
});
