// End-to-end tests for bin/dotbabel-task.mjs: the task commands and the
// SessionStart hook entry. Each test runs the real bin against a temp git
// repository, so nothing touches this checkout's own task state.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-task.mjs");
const UMBRELLA = path.resolve(__dirname, "../bin/dotbabel.mjs");
const NODE = process.execPath;

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

function repo() {
  const dir = makeTempDir("task-cli-");
  execFileSync("git", ["init", "-q", "-b", "fix/login", dir], { env: cleanEnv() });
  return fs.realpathSync(dir);
}

function task(cwd, args, input) {
  const r = spawnSync(NODE, [BIN, ...args], { cwd, encoding: "utf8", env: cleanEnv(), input });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function json(r) {
  return JSON.parse(r.stdout);
}

const NEW = ["new", "fix-login", "--goal", "Login keeps the target page", "--done-when", "a test reproduces it", "--done-when", "the suite passes"];

describe("dotbabel task new / show", () => {
  it("creates an open task with the contract and records branch and worktree", () => {
    const root = repo();
    const created = task(root, [...NEW, "--constraint", "touch only auth", "--json"]);
    expect(created.code).toBe(0);
    const t = json(created).task;
    expect(t).toMatchObject({
      slug: "fix-login",
      status: "open",
      goal: "Login keeps the target page",
      done_when: ["a test reproduces it", "the suite passes"],
      constraints: ["touch only auth"],
      phase: "started",
      branch: "fix/login",
      worktree: root,
    });
    const shown = task(root, ["show", "fix-login", "--json"]);
    expect(shown.code).toBe(0);
    expect(json(shown).task).toEqual(t);
  });

  it("prints a readable task without --json", () => {
    const root = repo();
    task(root, NEW);
    const shown = task(root, ["show", "fix-login"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("fix-login");
    expect(shown.stdout).toContain("done when");
    expect(shown.stdout).toContain("the suite passes");
  });

  it("refuses a second task with the same slug (exit 1)", () => {
    const root = repo();
    expect(task(root, NEW).code).toBe(0);
    const again = task(root, NEW);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("TASK_EXISTS");
  });

  it("refuses a task without --done-when or --goal (exit 64)", () => {
    const root = repo();
    expect(task(root, ["new", "x", "--goal", "g"]).code).toBe(64);
    expect(task(root, ["new", "x", "--done-when", "d"]).code).toBe(64);
    expect(task(root, ["new", "--goal", "g", "--done-when", "d"]).code).toBe(64);
  });

  it("refuses blank text values as usage errors (exit 64), not environment errors", () => {
    const root = repo();
    expect(task(root, ["new", "a", "--goal", " ", "--done-when", "d"]).code).toBe(64);
    expect(task(root, ["new", "b", "--goal", "g", "--done-when", ""]).code).toBe(64);
    expect(task(root, ["new", "c", "--goal", "g", "--done-when", "d", "--constraint", " "]).code).toBe(64);
    expect(task(root, NEW).code).toBe(0);
    expect(task(root, ["update", "fix-login", "--phase", " "]).code).toBe(64);
    expect(task(root, ["update", "fix-login", "--decision", ""]).code).toBe(64);
    expect(task(root, ["update", "fix-login", "--pending", " "]).code).toBe(64);
  });

  it("refuses a slug that could escape the tasks directory (exit 64)", () => {
    const root = repo();
    const r = task(root, ["new", "../x", "--goal", "g", "--done-when", "d"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("TASK_SLUG_INVALID");
  });

  it("reports an unknown task (exit 1)", () => {
    const r = task(repo(), ["show", "absent"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("TASK_NOT_FOUND");
  });

  it("exits 2 outside a git repository", () => {
    const r = task(makeTempDir("task-cli-nogit-"), NEW);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("TASK_NO_REPO");
  });
});

describe("dotbabel task update / close / list", () => {
  it("sets the phase, appends decisions and pending items, and finishes items", () => {
    const root = repo();
    task(root, NEW);
    const r = task(root, [
      "update",
      "fix-login",
      "--phase",
      "fix",
      "--decision",
      "the guard is wrong",
      "--pending",
      "check logout",
      "--pending",
      "update docs",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(json(r).task.phase).toBe("fix");
    expect(json(r).task.decisions.map((d) => d.text)).toEqual(["the guard is wrong"]);
    expect(json(r).task.pending).toEqual(["check logout", "update docs"]);

    const done = task(root, ["update", "fix-login", "--done", "check logout", "--json"]);
    expect(done.code).toBe(0);
    expect(json(done).task.pending).toEqual(["update docs"]);
  });

  it("refuses an update with nothing to change (exit 64) and an unknown --done item (exit 1)", () => {
    const root = repo();
    task(root, NEW);
    expect(task(root, ["update", "fix-login"]).code).toBe(64);
    const r = task(root, ["update", "fix-login", "--done", "never added"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("TASK_PENDING_UNKNOWN");
  });

  it("closes a task, hides it from list, and shows it with --all", () => {
    const root = repo();
    task(root, NEW);
    task(root, ["new", "other", "--goal", "g", "--done-when", "d"]);
    expect(task(root, ["close", "fix-login"]).code).toBe(0);

    const open = json(task(root, ["list", "--json"]));
    expect(open.tasks.map((t) => t.slug)).toEqual(["other"]);
    const all = json(task(root, ["list", "--all", "--json"]));
    expect(all.tasks.map((t) => t.slug).sort()).toEqual(["fix-login", "other"]);

    const again = task(root, ["close", "fix-login"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("TASK_CLOSED");
    expect(task(root, ["update", "fix-login", "--phase", "x"]).code).toBe(1);
  });

  it("exits 2 with one line, not a stack, for a filesystem error", () => {
    const root = repo();
    fs.mkdirSync(path.join(root, ".git", "dotbabel"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "dotbabel", "tasks"), "not a directory");
    const r = task(root, ["list"]);
    expect(r.code).toBe(2);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it("exits 2 while another writer holds the task's lock", () => {
    const root = repo();
    expect(task(root, NEW).code).toBe(0);
    fs.mkdirSync(path.join(root, ".git", "dotbabel", "tasks", "fix-login.json.lock"));
    const r = task(root, ["update", "fix-login", "--phase", "verify"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/TASK_LOCKED/);
  });

  it("lists nothing, with exit 0, in a repository without tasks", () => {
    const r = task(repo(), ["list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no open tasks");
  });
});

function commitEmpty(root) {
  execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "init"], {
    env: { ...cleanEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

function addWorktree(root, name) {
  const linked = path.join(makeTempDir("task-cli-wt-"), name);
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", name, linked], { env: cleanEnv() });
  return fs.realpathSync(linked);
}

function newTask(cwd, slug, ...extra) {
  return task(cwd, ["new", slug, "--goal", `goal of ${slug}`, "--done-when", "it works", ...extra]);
}

describe("dotbabel task dependencies", () => {
  it("records --depends-on on a new task and shows it", () => {
    const root = repo();
    const created = task(root, [...NEW, "--depends-on", "fix-api", "--depends-on", "acme/web#12", "--json"]);
    expect(created.code).toBe(0);
    expect(json(created).task).toMatchObject({ schema_version: 2, depends_on: ["fix-api", "acme/web#12"] });
    const shown = task(root, ["show", "fix-login"]);
    expect(shown.stdout).toContain("depends on:");
    expect(shown.stdout).toContain("acme/web#12");
    expect(task(root, ["show", "fix-login", "--json"]).stdout).not.toContain("depends on:");
  });

  it("adds and drops dependencies on update, and refuses to drop one the task lacks (exit 1)", () => {
    const root = repo();
    task(root, NEW);
    const added = task(root, ["update", "fix-login", "--depends-on", "fix-api", "--json"]);
    expect(added.code).toBe(0);
    expect(json(added).task.depends_on).toEqual(["fix-api"]);
    const dropped = task(root, ["update", "fix-login", "--drop-depends-on", "fix-api", "--json"]);
    expect(dropped.code).toBe(0);
    expect(json(dropped).task.depends_on).toEqual([]);
    const missing = task(root, ["update", "fix-login", "--drop-depends-on", "fix-api"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("TASK_DEPENDENCY_UNKNOWN");
  });

  it("refuses a malformed reference as a usage error (exit 64) and a self reference (exit 1)", () => {
    const root = repo();
    task(root, NEW);
    const bad = task(root, ["update", "fix-login", "--depends-on", "Not A Ref"]);
    expect(bad.code).toBe(64);
    expect(bad.stderr).toContain("TASK_DEPENDENCY_INVALID");
    const self = task(root, ["update", "fix-login", "--depends-on", "fix-login"]);
    expect(self.code).toBe(1);
    expect(self.stderr).toContain("TASK_CYCLE");
    expect(json(task(root, ["show", "fix-login", "--json"])).task.depends_on).toEqual([]);
  });

  it("task new refuses a slug that another worktree of the clone uses", () => {
    const root = repo();
    commitEmpty(root);
    const side = addWorktree(root, "side");
    expect(newTask(root, "shared").code).toBe(0);
    const refused = newTask(side, "shared");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("TASK_SLUG_TAKEN");
    expect(refused.stderr).toContain(root);
    expect(task(side, ["list", "--json"]).stdout).toContain('"tasks": []');
    expect(newTask(side, "other").code).toBe(0);
  });

  it("task update refuses an edge that closes a cycle", () => {
    const root = repo();
    commitEmpty(root);
    const side = addWorktree(root, "side");
    expect(newTask(root, "a").code).toBe(0);
    expect(newTask(side, "b", "--depends-on", "a").code).toBe(0);
    expect(newTask(side, "c", "--depends-on", "b").code).toBe(0);
    const before = json(task(root, ["show", "a", "--json"])).task;
    const refused = task(root, ["update", "a", "--depends-on", "c"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("TASK_CYCLE");
    expect(refused.stderr).toContain("a -> c -> b -> a");
    expect(json(task(root, ["show", "a", "--json"])).task).toEqual(before);
    expect(task(root, ["update", "a", "--depends-on", "acme/web#1"]).code).toBe(0);
  });

  it("task new refuses a cycle that a forward reference would close, and writes no task", () => {
    const root = repo();
    expect(newTask(root, "a", "--depends-on", "b").code).toBe(0);
    const refused = newTask(root, "b", "--depends-on", "a");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("TASK_CYCLE");
    expect(task(root, ["show", "b"]).code).toBe(1);
    expect(newTask(root, "b", "--depends-on", "acme/web#2").code).toBe(0);
  });
});

describe("dotbabel task hook session-start", () => {
  it("prints the open tasks as SessionStart additionalContext", () => {
    const root = repo();
    task(root, NEW);
    task(root, ["update", "fix-login", "--phase", "verify", "--pending", "run the full suite"]);
    const r = task(root, ["hook", "session-start"], JSON.stringify({ session_id: "s", cwd: root, source: "startup" }));
    expect(r.code).toBe(0);
    const out = json(r);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("fix-login");
    expect(out.hookSpecificOutput.additionalContext).toContain("phase: verify");
    expect(out.hookSpecificOutput.additionalContext).toContain("run the full suite");
  });

  it("uses the payload's cwd, not its own", () => {
    const root = repo();
    task(root, NEW);
    const elsewhere = makeTempDir("task-cli-elsewhere-");
    const r = task(elsewhere, ["hook", "session-start"], JSON.stringify({ cwd: root }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fix-login");
  });

  it("is silent when no task is open", () => {
    const root = repo();
    task(root, NEW);
    task(root, ["close", "fix-login"]);
    const r = task(root, ["hook", "session-start"], JSON.stringify({ cwd: root }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails open on bad input, outside a repository, and for an unknown event", () => {
    const root = repo();
    for (const [cwd, args, input] of [
      [root, ["hook", "session-start"], "{not json"],
      [root, ["hook", "session-start"], "[]"],
      [root, ["hook", "session-start"], JSON.stringify({ cwd: makeTempDir("task-cli-nogit-") })],
      [root, ["hook", "pre-edit"], JSON.stringify({ cwd: root })],
    ]) {
      const r = task(cwd, args, input);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  });
});

describe("dotbabel task usage", () => {
  it("prints help and exits 0, and exits 64 for an unknown subcommand", () => {
    const help = task(repo(), ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("dotbabel task new");
    expect(task(repo(), ["frobnicate"]).code).toBe(64);
    expect(task(repo(), []).code).toBe(64);
  });

  it("is reachable through the umbrella dispatcher", () => {
    const r = spawnSync(NODE, [UMBRELLA, "task", "--help"], { encoding: "utf8", env: cleanEnv() });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dotbabel task new");
  });
});
