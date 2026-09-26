// End-to-end tests for bin/dotbabel-fleet.mjs: the PreToolUse and SessionStart
// hooks, and the board / claim / release / prune commands.
//
// Every "session" is a real process, because liveness is read from /proc: this
// test process is the session "self-pane", and a `sleep` child is "peer-pane".
// The registry, the ledger, and HOME are temp dirs, so nothing touches the
// real ~/.claude or ~/.local/state.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, trackTempPath } from "./fixtures/temp-dir.mjs";
import { readOwnerRecords, repoDir } from "../src/fleet/ledger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-fleet.mjs");
const NODE = process.execPath;
const REPO_KEY = "github.com/acme/widget";
const HAS_PROC = fs.existsSync("/proc/self/stat");

function procStart(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() }).trim();
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("DOTBABEL_FLEET_") || k.startsWith("GIT_") || k === "CLAUDE_PROJECT_DIR") delete env[k];
  }
  delete env.XDG_STATE_HOME;
  return { ...env, ...extra };
}

function startSleeper() {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  return { child, pid: child.pid, procStart: procStart(child.pid) };
}

function stop(sleeper) {
  return new Promise((resolve) => {
    if (sleeper.child.exitCode !== null || sleeper.child.signalCode !== null) return resolve();
    sleeper.child.once("exit", () => resolve());
    sleeper.child.kill("SIGKILL");
  });
}

let peer;
beforeAll(() => {
  if (HAS_PROC) peer = startSleeper();
});
afterAll(async () => {
  if (peer) await stop(peer);
});

/**
 * A governed repo plus an isolated registry and ledger.
 * @param {{ dotbabel?: object|null, register?: Array<object> }} [opts]
 */
function world({ dotbabel = {}, register } = {}) {
  const root = makeTempDir("fleet-cli-");
  const repo = path.join(root, "widget");
  const home = path.join(root, "home");
  const config = path.join(home, ".claude");
  const state = path.join(root, "state");
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  if (dotbabel) fs.writeFileSync(path.join(repo, ".dotbabel.json"), JSON.stringify(dotbabel));
  fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\n");
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "docs", "a.md"), "a\n");

  const sessions = register ?? [
    { pid: process.pid, sessionId: "sess-self", procStart: procStart(process.pid), name: "self-pane", status: "busy" },
    { pid: peer.pid, sessionId: "sess-peer", procStart: peer.procStart, name: "peer-pane", status: "idle" },
  ];
  for (const s of sessions) {
    fs.writeFileSync(path.join(config, "sessions", `${s.pid}.json`), JSON.stringify({ kind: "interactive", ...s }));
  }

  const env = cleanEnv({ HOME: home, CLAUDE_CONFIG_DIR: config, DOTBABEL_FLEET_STATE_DIR: state });
  const w = { root, repo, home, config, state, env };
  w.hook = (event, payload, extraEnv = {}) =>
    spawnSync(NODE, [BIN, "hook", event], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
  w.edit = (sessionId, rel, extraEnv = {}, tool = "Edit") =>
    w.hook(
      "pre-edit",
      {
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: { file_path: path.isAbsolute(rel) ? rel : path.join(repo, rel) },
        cwd: repo,
      },
      extraEnv,
    );
  w.cli = (args, { cwd = repo, extraEnv = {} } = {}) =>
    spawnSync(NODE, [BIN, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
  w.records = () => readOwnerRecords(repoDir(state, REPO_KEY));
  w.claimsOf = (name) =>
    w
      .records()
      .filter((r) => r.owner.name === name)
      .flatMap((r) => r.claims.map((c) => c.pattern));
  return w;
}

function decision(result) {
  expect(result.status).toBe(0);
  if (result.stdout.trim() === "") return { action: "allow" };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe("PreToolUse");
  return { action: out.permissionDecision, reason: out.permissionDecisionReason };
}

describe.skipIf(!HAS_PROC)("dotbabel-fleet hook pre-edit", () => {
  it("claims a file on the first edit and says nothing", () => {
    const w = world();
    expect(decision(w.edit("sess-self", "docs/a.md"))).toEqual({ action: "allow" });
    expect(w.claimsOf("self-pane")).toEqual(["docs/a.md"]);
  });

  it("denies a live peer's edit to the claimed file and tells it whom to message", () => {
    const w = world();
    w.edit("sess-self", "docs/a.md");
    const d = decision(w.edit("sess-peer", "docs/a.md"));
    expect(d.action).toBe("deny");
    expect(d.reason).toContain('"self-pane"');
    expect(d.reason).toContain("docs/a.md");
    expect(d.reason).toMatch(/SendMessage/);
    expect(w.claimsOf("peer-pane")).toEqual([]);
  });

  it("lets the owner keep editing its own file", () => {
    const w = world();
    w.edit("sess-self", "docs/a.md");
    expect(decision(w.edit("sess-self", "docs/a.md"))).toEqual({ action: "allow" });
    expect(w.claimsOf("self-pane")).toEqual(["docs/a.md"]);
  });

  it("guards Write, MultiEdit and NotebookEdit too", () => {
    const w = world();
    w.edit("sess-self", "docs/a.md");
    expect(decision(w.edit("sess-peer", "docs/a.md", {}, "Write")).action).toBe("deny");
    expect(decision(w.edit("sess-peer", "docs/a.md", {}, "MultiEdit")).action).toBe("deny");
    const nb = w.hook("pre-edit", {
      session_id: "sess-peer",
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: path.join(w.repo, "docs", "a.md") },
    });
    expect(decision(nb).action).toBe("deny");
  });

  it("claims a new file in a directory that does not exist yet", () => {
    const w = world();
    expect(decision(w.edit("sess-self", "src/new/deep/file.mjs")).action).toBe("allow");
    expect(w.claimsOf("self-pane")).toEqual(["src/new/deep/file.mjs"]);
  });

  it("treats the same path in two worktrees of one repo as one file", () => {
    const w = world();
    git(w.repo, ["add", ".dotbabel.json", ".gitignore"]);
    git(w.repo, ["-c", "user.email=t@e.st", "-c", "user.name=T", "commit", "-q", "-m", "init"]);
    const wt = trackTempPath(path.join(w.root, "wt-peer"));
    git(w.repo, ["worktree", "add", "-q", "-b", "feat/peer", wt]);
    fs.mkdirSync(path.join(wt, "docs"), { recursive: true });

    expect(decision(w.edit("sess-peer", path.join(wt, "docs", "a.md"))).action).toBe("allow");
    const d = decision(w.edit("sess-self", "docs/a.md"));
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("feat/peer");

    // Removing the worktree ends the claim even though the peer still runs.
    git(w.repo, ["worktree", "remove", "--force", wt]);
    expect(decision(w.edit("sess-self", "docs/a.md")).action).toBe("allow");
  });

  it("releases the claims of a session that exited", async () => {
    const gone = startSleeper();
    const w = world({
      register: [
        { pid: process.pid, sessionId: "sess-self", procStart: procStart(process.pid), name: "self-pane" },
        { pid: gone.pid, sessionId: "sess-gone", procStart: gone.procStart, name: "gone-pane" },
      ],
    });
    w.edit("sess-gone", "docs/a.md");
    expect(w.claimsOf("gone-pane")).toEqual(["docs/a.md"]);
    await stop(gone);

    expect(decision(w.edit("sess-self", "docs/a.md")).action).toBe("allow");
    expect(w.claimsOf("gone-pane")).toEqual([]);
    expect(w.claimsOf("self-pane")).toEqual(["docs/a.md"]);
  });

  it("escalates to the user after the window, and not before", () => {
    const w = world();
    w.edit("sess-self", "docs/a.md");
    const fast = { DOTBABEL_FLEET_ESCALATE_MINUTES: "0.0000001" };
    expect(decision(w.edit("sess-peer", "docs/a.md", fast)).action).toBe("deny");
    const second = decision(w.edit("sess-peer", "docs/a.md", fast));
    expect(second.action).toBe("ask");
    expect(second.reason).toContain('"self-pane"');
  });

  it("uses the default window when the escalation setting is not a number", () => {
    const w = world();
    w.edit("sess-self", "docs/a.md");
    const bad = { DOTBABEL_FLEET_ESCALATE_MINUTES: "soon" };
    expect(decision(w.edit("sess-peer", "docs/a.md", bad)).action).toBe("deny");
    expect(decision(w.edit("sess-peer", "docs/a.md", bad)).action).toBe("deny");
  });

  describe("stays silent and claims nothing", () => {
    it("in a repo without .dotbabel.json", () => {
      const w = world({ dotbabel: null });
      expect(decision(w.edit("sess-self", "docs/a.md"))).toEqual({ action: "allow" });
      expect(fs.existsSync(w.state)).toBe(false);
    });

    it("outside any git repo", () => {
      const w = world();
      const loose = path.join(makeTempDir("fleet-loose-"), "notes.md");
      expect(decision(w.edit("sess-self", loose))).toEqual({ action: "allow" });
      expect(fs.existsSync(w.state)).toBe(false);
    });

    it("for a git-ignored file", () => {
      const w = world();
      expect(decision(w.edit("sess-self", "dist/bundle.js"))).toEqual({ action: "allow" });
      expect(w.claimsOf("self-pane")).toEqual([]);
    });

    it("for a shared file such as a lockfile", () => {
      const w = world();
      w.edit("sess-self", "package-lock.json");
      expect(decision(w.edit("sess-peer", "package-lock.json"))).toEqual({ action: "allow" });
      expect(w.records()).toEqual([]);
    });

    it("for a repo's own shared globs in .dotbabel.json", () => {
      const w = world({ dotbabel: { fleet: { shared: ["docs/**"] } } });
      w.edit("sess-self", "docs/a.md");
      expect(decision(w.edit("sess-peer", "docs/a.md"))).toEqual({ action: "allow" });
      expect(w.records()).toEqual([]);
    });

    it("when DOTBABEL_FLEET_MODE=off", () => {
      const w = world();
      w.edit("sess-self", "docs/a.md");
      expect(decision(w.edit("sess-peer", "docs/a.md", { DOTBABEL_FLEET_MODE: "off" }))).toEqual({
        action: "allow",
      });
    });

    it('when .dotbabel.json sets fleet.mode to "off"', () => {
      const w = world({ dotbabel: { fleet: { mode: "off" } } });
      w.edit("sess-self", "docs/a.md");
      expect(w.records()).toEqual([]);
    });

    it("when it cannot tell which session is editing", () => {
      const w = world({
        register: [{ pid: peer.pid, sessionId: "sess-peer", procStart: peer.procStart, name: "peer-pane" }],
      });
      expect(decision(w.edit("sess-nobody", "docs/a.md"))).toEqual({ action: "allow" });
      expect(w.records()).toEqual([]);
    });

    it("for input that is not hook JSON", () => {
      const w = world();
      for (const input of ["", "not json", "[]", JSON.stringify({ tool_input: {} })]) {
        expect(decision(w.hook("pre-edit", input))).toEqual({ action: "allow" });
      }
    });

    it("for an unknown hook event", () => {
      const w = world();
      const r = w.hook("bogus", { session_id: "sess-self" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });
  });
});

describe.skipIf(!HAS_PROC)("dotbabel-fleet hook session-start", () => {
  const start = (w, sessionId = "sess-self") =>
    w.hook("session-start", { session_id: sessionId, hook_event_name: "SessionStart", source: "startup", cwd: w.repo });

  it("prints nothing when nobody holds a claim", () => {
    const r = start(world());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("tells a new session which paths its peers hold", () => {
    const w = world();
    w.edit("sess-peer", "docs/a.md");
    const r = start(w);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"peer-pane"');
    expect(r.stdout).toContain("docs/a.md");
    expect(r.stdout).toContain(REPO_KEY);
  });

  it("prints nothing for a repo without .dotbabel.json", () => {
    const w = world({ dotbabel: null });
    w.edit("sess-peer", "docs/a.md");
    expect(start(w).stdout).toBe("");
  });
});

describe.skipIf(!HAS_PROC)("dotbabel-fleet board / claim / release / prune", () => {
  it("claims a scope, which then blocks a peer's edit inside it", () => {
    const w = world();
    const r = w.cli(["claim", "src/**", "--note", "refactor the parser"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("src/**");
    const d = decision(w.edit("sess-peer", "src/parser/lex.mjs"));
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("refactor the parser");
  });

  it("refuses a claim that overlaps a live peer's claim, and writes nothing", () => {
    const w = world();
    w.edit("sess-peer", "docs/a.md");
    const r = w.cli(["claim", "docs"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"peer-pane"');
    expect(r.stderr).toContain("docs/a.md");
    expect(w.claimsOf("self-pane")).toEqual([]);
  });

  it("rejects a pattern that leaves the repo", () => {
    const w = world();
    expect(w.cli(["claim", "../other/x"]).status).toBe(64);
  });

  it("releases a claim, so the peer can edit again", () => {
    const w = world();
    w.cli(["claim", "src/**"]);
    const r = w.cli(["release", "src/**"]);
    expect(r.status).toBe(0);
    expect(w.claimsOf("self-pane")).toEqual([]);
    expect(decision(w.edit("sess-peer", "src/parser/lex.mjs")).action).toBe("allow");
  });

  it("releases every claim with --all", () => {
    const w = world();
    w.edit("sess-self", "docs/a.md");
    w.cli(["claim", "src/**"]);
    expect(w.cli(["release", "--all"]).status).toBe(0);
    expect(w.claimsOf("self-pane")).toEqual([]);
  });

  it("needs a pattern or --all to release", () => {
    expect(world().cli(["release"]).status).toBe(64);
  });

  it("shows the board as JSON, with this session marked", () => {
    const w = world();
    w.edit("sess-peer", "docs/a.md");
    w.cli(["claim", "src/**"]);
    const r = w.cli(["board", "--json"]);
    expect(r.status).toBe(0);
    const board = JSON.parse(r.stdout);
    expect(board.repo).toBe(REPO_KEY);
    const byName = Object.fromEntries(board.owners.map((o) => [o.name, o]));
    expect(byName["self-pane"].self).toBe(true);
    expect(byName["self-pane"].claims.map((c) => c.pattern)).toEqual(["src/**"]);
    expect(byName["peer-pane"].self).toBe(false);
    expect(byName["peer-pane"].claims.map((c) => c.pattern)).toEqual(["docs/a.md"]);
  });

  it("shows a readable board", () => {
    const w = world();
    w.edit("sess-peer", "docs/a.md");
    const r = w.cli(["board"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(REPO_KEY);
    expect(r.stdout).toContain("peer-pane");
    expect(r.stdout).toContain("docs/a.md");
  });

  it("prunes the records of sessions that exited", async () => {
    const gone = startSleeper();
    const w = world({
      register: [
        { pid: process.pid, sessionId: "sess-self", procStart: procStart(process.pid), name: "self-pane" },
        { pid: gone.pid, sessionId: "sess-gone", procStart: gone.procStart, name: "gone-pane" },
      ],
    });
    w.edit("sess-gone", "docs/a.md");
    await stop(gone);
    const r = w.cli(["prune"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/removed 1/);
    expect(w.records()).toEqual([]);
  });

  it("exits 2 when run outside a Claude Code session", () => {
    const w = world({ register: [] });
    const r = w.cli(["claim", "src/**"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Claude Code session/);
  });

  it("exits 2 outside a git repo", () => {
    const w = world();
    expect(w.cli(["board"], { cwd: makeTempDir("fleet-nogit-") }).status).toBe(2);
  });

  it("prints usage for --help and exits 64 for an unknown subcommand", () => {
    const w = world();
    const help = w.cli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/dotbabel fleet board/);
    expect(w.cli(["frobnicate"]).status).toBe(64);
    expect(w.cli(["board", "--bogus"]).status).toBe(64);
  });
});
