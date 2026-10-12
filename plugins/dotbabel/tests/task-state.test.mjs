// Unit tests for src/task-state.mjs: the task contract (goal, done_when) and
// the durable state a session writes as it works (phase, decisions, pending).
//
// The pure half (create / update / close / validate / format) needs no disk.
// The storage half writes under the worktree's git directory, so each test
// gets its own temp git repository.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import {
  TASK_ERROR_CODES,
  TaskError,
  closeTask,
  createTask,
  formatSessionContext,
  isValidSlug,
  listTasks,
  readTask,
  tasksDir,
  updateTask,
  validateTask,
  writeTask,
} from "../src/task-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../schemas/dotbabel.task-state.schema.json"), "utf8"),
);
const T0 = new Date("2026-10-12T10:00:00Z");
const T1 = new Date("2026-10-12T11:00:00Z");

function cleanGitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

function repo() {
  const dir = makeTempDir("task-state-");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: cleanGitEnv() });
  return fs.realpathSync(dir);
}

function sample(overrides = {}) {
  return createTask({
    slug: "fix-login",
    goal: "Login redirects to the page the user asked for",
    doneWhen: ["a test reproduces the wrong redirect", "the full suite passes"],
    constraints: ["touch only the auth module"],
    branch: "fix/login",
    worktree: "/tmp/w",
    now: T0,
    ...overrides,
  });
}

function expectCode(fn, code) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TaskError);
  expect(caught.code).toBe(code);
}

describe("isValidSlug", () => {
  it("accepts lowercase words joined by dashes", () => {
    expect(isValidSlug("fix-login")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
    expect(isValidSlug("issue-431")).toBe(true);
  });

  it("rejects a slug that could leave the tasks directory or hide a file", () => {
    for (const bad of ["", "../x", "a/b", ".hidden", "-lead", "UPPER", "a b", "a.json", "x".repeat(65), 7, null]) {
      expect(isValidSlug(bad)).toBe(false);
    }
  });
});

describe("createTask", () => {
  it("builds an open task whose contract is the goal and the done_when list", () => {
    const task = sample();
    expect(task).toEqual({
      schema_version: 1,
      slug: "fix-login",
      status: "open",
      goal: "Login redirects to the page the user asked for",
      done_when: ["a test reproduces the wrong redirect", "the full suite passes"],
      constraints: ["touch only the auth module"],
      phase: "started",
      decisions: [],
      pending: [],
      created_at: "2026-10-12T10:00:00.000Z",
      updated_at: "2026-10-12T10:00:00.000Z",
      closed_at: null,
      branch: "fix/login",
      worktree: "/tmp/w",
    });
    expect(validateTask(task)).toEqual([]);
  });

  it("refuses a task with no done_when item, because success must be defined first", () => {
    expectCode(() => sample({ doneWhen: [] }), TASK_ERROR_CODES.TASK_INVALID);
    expectCode(() => sample({ doneWhen: ["  "] }), TASK_ERROR_CODES.TASK_INVALID);
  });

  it("refuses an empty goal and a bad slug", () => {
    expectCode(() => sample({ goal: " " }), TASK_ERROR_CODES.TASK_INVALID);
    expectCode(() => sample({ slug: "../escape" }), TASK_ERROR_CODES.TASK_SLUG_INVALID);
  });

  it("takes an explicit starting phase", () => {
    expect(sample({ phase: "reproduce" }).phase).toBe("reproduce");
  });
});

describe("updateTask", () => {
  it("sets the phase, appends decisions and pending items, and stamps updated_at", () => {
    const next = updateTask(sample(), {
      phase: "fix",
      decisions: ["the bug is in the redirect guard"],
      pending: ["check the logout path", "update the docs"],
      now: T1,
    });
    expect(next.phase).toBe("fix");
    expect(next.decisions).toEqual([{ at: "2026-10-12T11:00:00.000Z", text: "the bug is in the redirect guard" }]);
    expect(next.pending).toEqual(["check the logout path", "update the docs"]);
    expect(next.updated_at).toBe("2026-10-12T11:00:00.000Z");
    expect(next.created_at).toBe("2026-10-12T10:00:00.000Z");
  });

  it("removes a finished pending item and leaves the input untouched", () => {
    const before = updateTask(sample(), { pending: ["a", "b"], now: T1 });
    const after = updateTask(before, { done: ["a"], now: T1 });
    expect(after.pending).toEqual(["b"]);
    expect(before.pending).toEqual(["a", "b"]);
  });

  it("refuses to finish an item that is not pending", () => {
    expectCode(() => updateTask(sample(), { done: ["nope"], now: T1 }), TASK_ERROR_CODES.TASK_PENDING_UNKNOWN);
  });

  it("refuses an update that changes nothing", () => {
    expectCode(() => updateTask(sample(), { now: T1 }), TASK_ERROR_CODES.TASK_UPDATE_EMPTY);
    expectCode(() => updateTask(sample(), { decisions: [], pending: [], now: T1 }), TASK_ERROR_CODES.TASK_UPDATE_EMPTY);
  });

  it("refuses to change a closed task", () => {
    const closed = closeTask(sample(), { now: T1 });
    expectCode(() => updateTask(closed, { phase: "fix", now: T1 }), TASK_ERROR_CODES.TASK_CLOSED);
  });

  it("refuses a blank decision, pending item, or phase", () => {
    expectCode(() => updateTask(sample(), { decisions: [" "], now: T1 }), TASK_ERROR_CODES.TASK_INVALID);
    expectCode(() => updateTask(sample(), { pending: [""], now: T1 }), TASK_ERROR_CODES.TASK_INVALID);
    expectCode(() => updateTask(sample(), { phase: " ", now: T1 }), TASK_ERROR_CODES.TASK_INVALID);
  });
});

describe("closeTask", () => {
  it("marks the task closed and keeps the record", () => {
    const closed = closeTask(sample(), { now: T1 });
    expect(closed.status).toBe("closed");
    expect(closed.closed_at).toBe("2026-10-12T11:00:00.000Z");
    expect(closed.goal).toBe(sample().goal);
    expect(validateTask(closed)).toEqual([]);
  });

  it("refuses to close a task twice", () => {
    expectCode(() => closeTask(closeTask(sample(), { now: T1 }), { now: T1 }), TASK_ERROR_CODES.TASK_CLOSED);
  });
});

describe("validateTask and the schema agree", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const schemaValid = ajv.compile(SCHEMA);

  it("accepts a created, updated, and closed task", () => {
    const updated = updateTask(sample(), { phase: "verify", decisions: ["d"], pending: ["p"], now: T1 });
    for (const task of [sample(), updated, closeTask(updated, { now: T1 })]) {
      expect(validateTask(task)).toEqual([]);
      expect(schemaValid(task)).toBe(true);
    }
  });

  it("rejects the same malformed records", () => {
    const good = sample();
    const bad = [
      { ...good, extra: 1 },
      { ...good, schema_version: 2 },
      { ...good, status: "paused" },
      { ...good, done_when: [] },
      { ...good, decisions: [{ text: "no time" }] },
      { ...good, slug: "Bad Slug" },
      { ...good, pending: "one" },
      { ...good, closed_at: "yesterday" },
      (({ goal, ...rest }) => rest)(good),
    ];
    for (const record of bad) {
      expect(validateTask(record).length).toBeGreaterThan(0);
      expect(schemaValid(record)).toBe(false);
    }
    expect(validateTask(null).length).toBeGreaterThan(0);
    expect(validateTask([]).length).toBeGreaterThan(0);
  });
});

describe("formatSessionContext", () => {
  it("is empty when no task is open", () => {
    expect(formatSessionContext([])).toBe("");
    expect(formatSessionContext([closeTask(sample(), { now: T1 })])).toBe("");
  });

  it("names each open task with its phase, contract, pending items, and latest decisions", () => {
    const task = updateTask(sample(), {
      phase: "verify",
      decisions: ["d1", "d2", "d3", "d4"],
      pending: ["run the full suite"],
      now: T1,
    });
    const text = formatSessionContext([task]);
    expect(text).toContain("fix-login");
    expect(text).toContain("phase: verify");
    expect(text).toContain("Login redirects to the page the user asked for");
    expect(text).toContain("a test reproduces the wrong redirect");
    expect(text).toContain("run the full suite");
    expect(text).toContain("d4");
    expect(text).not.toContain("d1");
    expect(text).toContain("dotbabel task show fix-login");
  });

  it("lists the most recently updated tasks first and bounds how many it prints", () => {
    const tasks = Array.from({ length: 7 }, (_, i) =>
      updateTask(sample({ slug: `task-${i}` }), { phase: "p", now: new Date(T0.getTime() + i * 60_000) }),
    );
    const text = formatSessionContext(tasks);
    expect(text.indexOf("task-6")).toBeLessThan(text.indexOf("task-5"));
    expect(text).not.toContain("task-0");
    expect(text).toContain("2 more open task(s)");
  });

  it("truncates a very long field so the context stays small", () => {
    const text = formatSessionContext([sample({ goal: "g".repeat(5000) })]);
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain("…");
  });
});

describe("storage under the worktree's git directory", () => {
  it("round-trips a task and never shows it in git status", () => {
    const root = repo();
    const task = sample({ worktree: root });
    writeTask(root, task, { create: true });
    expect(readTask(root, "fix-login")).toEqual(task);
    const dir = tasksDir(root);
    expect(dir.startsWith(path.join(root, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "fix-login.json"))).toBe(true);
    const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
      env: cleanGitEnv(),
    });
    expect(status).toBe("");
  });

  it("keeps a linked worktree's tasks apart from the main checkout's", () => {
    const root = repo();
    execFileSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "init"], {
      env: { ...cleanGitEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const linked = path.join(makeTempDir("task-state-wt-"), "wt");
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "side", linked], { env: cleanGitEnv() });
    writeTask(linked, sample({ slug: "side-task" }), { create: true });
    expect(listTasks(fs.realpathSync(linked)).tasks.map((t) => t.slug)).toEqual(["side-task"]);
    expect(listTasks(root).tasks).toEqual([]);
  });

  it("refuses to create a task that already exists", () => {
    const root = repo();
    writeTask(root, sample(), { create: true });
    expectCode(() => writeTask(root, sample(), { create: true }), TASK_ERROR_CODES.TASK_EXISTS);
  });

  it("reports a missing task as not found", () => {
    expectCode(() => readTask(repo(), "absent"), TASK_ERROR_CODES.TASK_NOT_FOUND);
  });

  it("reports a corrupt task file as invalid", () => {
    const root = repo();
    writeTask(root, sample(), { create: true });
    fs.writeFileSync(path.join(tasksDir(root), "fix-login.json"), "{not json");
    expectCode(() => readTask(root, "fix-login"), TASK_ERROR_CODES.TASK_INVALID);
  });

  it("refuses a symlinked tasks directory", () => {
    const root = repo();
    const elsewhere = makeTempDir("task-state-elsewhere-");
    fs.mkdirSync(path.join(root, ".git", "dotbabel"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, ".git", "dotbabel", "tasks"));
    expectCode(() => writeTask(root, sample(), { create: true }), TASK_ERROR_CODES.TASK_PATH_UNSAFE);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses a symlinked task file", () => {
    const root = repo();
    writeTask(root, sample({ slug: "real" }), { create: true });
    const dir = tasksDir(root);
    fs.symlinkSync(path.join(dir, "real.json"), path.join(dir, "fix-login.json"));
    expectCode(() => readTask(root, "fix-login"), TASK_ERROR_CODES.TASK_PATH_UNSAFE);
  });

  it("refuses a bad slug before touching the disk", () => {
    expectCode(() => readTask(repo(), "../../etc/passwd"), TASK_ERROR_CODES.TASK_SLUG_INVALID);
  });

  it("lists valid tasks and reports the files it could not read", () => {
    const root = repo();
    writeTask(root, sample({ slug: "one" }), { create: true });
    writeTask(root, sample({ slug: "two" }), { create: true });
    fs.writeFileSync(path.join(tasksDir(root), "broken.json"), "[]");
    fs.writeFileSync(path.join(tasksDir(root), "notes.txt"), "ignored");
    const { tasks, problems } = listTasks(root);
    expect(tasks.map((t) => t.slug).sort()).toEqual(["one", "two"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken.json");
  });

  it("lists nothing in a repository that has no tasks yet", () => {
    expect(listTasks(repo())).toEqual({ tasks: [], problems: [] });
  });

  it("names the environment problem outside a git repository", () => {
    expectCode(() => tasksDir(makeTempDir("task-state-nogit-")), TASK_ERROR_CODES.TASK_NO_REPO);
  });
});
