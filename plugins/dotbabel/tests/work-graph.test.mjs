// Tests for src/work-graph.mjs, the pure half of the work graph, and for the
// graph reads the task CLI builds on it. The pure tests feed records in and
// touch nothing; the read tests build a temp clone with linked worktrees and
// run the real bin, so nothing touches this checkout's own task state.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { closeTask, createTask, listCloneTasks, tasksDir, writeTask } from "../src/task-state.mjs";
import {
  buildWorkGraph,
  cloneEdges,
  dependencyStates,
  findCycle,
  findSlugOwner,
  nextTasks,
  parseWorktreeList,
  topologicalOrder,
} from "../src/work-graph.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-task.mjs");
const T0 = new Date("2026-10-12T10:00:00Z");
// Every bin spawn writes its clone registry under this temp state directory,
// never under the developer's own.
const STATE_HOME = makeTempDir("work-graph-state-");
const REGISTRY = path.join(STATE_HOME, "dotbabel", "graph", "clones.json");

function t(slug, dependsOn = [], worktree = "/w/main") {
  return createTask({ slug, goal: `goal ${slug}`, doneWhen: ["done"], dependsOn, worktree, now: T0 });
}

function closed(task) {
  return closeTask(task, { now: T0 });
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return {
    ...env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    XDG_STATE_HOME: STATE_HOME,
  };
}

function repo() {
  const dir = makeTempDir("work-graph-");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: cleanEnv() });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "init"], { env: cleanEnv() });
  return fs.realpathSync(dir);
}

function addWorktree(root, name) {
  const linked = path.join(makeTempDir("work-graph-wt-"), name);
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", name, linked], { env: cleanEnv() });
  return fs.realpathSync(linked);
}

function put(root, slug, dependsOn = []) {
  const task = createTask({ slug, goal: `goal ${slug}`, doneWhen: ["done"], dependsOn, worktree: root, now: T0 });
  writeTask(root, task, { create: true });
  return task;
}

function run(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...cleanEnv(), ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A clone with an `origin`, so it has a repository key and registers itself on a task write. */
function cloneOf(url) {
  const root = repo();
  execFileSync("git", ["-C", root, "remote", "add", "origin", url], { env: cleanEnv() });
  return root;
}

/**
 * A `gh` on PATH that answers `gh api repos/<owner>/<repo>/issues/<n>` from a
 * script and appends each call to $GH_LOG: #1 a merged pull request, #2 a
 * closed issue, #3 an open pull request, #4 not found (which GitHub also
 * answers for a private repository the account cannot see), anything else a
 * failure.
 */
function fakeGh() {
  const dir = makeTempDir("work-graph-gh-");
  const script = [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$*" >> "$GH_LOG"',
    'case "$2" in',
    '  */issues/1) echo \'{"number":1,"state":"closed","pull_request":{"merged_at":"2026-01-01T00:00:00Z"}}\' ;;',
    '  */issues/2) echo \'{"number":2,"state":"closed"}\' ;;',
    '  */issues/3) echo \'{"number":3,"state":"open","pull_request":{"merged_at":null}}\' ;;',
    '  */issues/4) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
    '  *) echo "gh: could not connect" >&2; exit 1 ;;',
    "esac",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "gh"), script, { mode: 0o755 });
  const log = path.join(dir, "calls.log");
  return { env: { PATH: `${dir}${path.delimiter}${process.env.PATH}`, GH_LOG: log }, log };
}

function states(out, slug) {
  const task = out.blocked.find((t) => t.slug === slug) ?? out.ready.find((t) => t.slug === slug);
  return task?.waits_on ?? [];
}

describe("parseWorktreeList", () => {
  it("reads the worktree paths out of git worktree list --porcelain", () => {
    const text = [
      "worktree /w/main",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "branch refs/heads/main",
      "",
      "worktree /w/side",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "branch refs/heads/side",
      "",
      "worktree /w/detached",
      "HEAD 0123456789abcdef0123456789abcdef01234567",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(text)).toEqual(["/w/main", "/w/side", "/w/detached"]);
  });

  it("skips a bare entry and ignores blank or unknown lines", () => {
    expect(parseWorktreeList("worktree /w/bare.git\nbare\n\nworktree /w/main\nHEAD abc\n\n")).toEqual(["/w/main"]);
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("cloneEdges and findCycle", () => {
  it("builds edges from bare slug references only", () => {
    const tasks = [t("a", ["b", "acme/web#1", "github.com/acme/web:z"]), t("b")];
    expect(cloneEdges(tasks)).toEqual([["a", "b"]]);
  });

  it("finds a direct, a transitive, and a self cycle, and reports the path", () => {
    expect(findCycle([t("a", ["b"]), t("b", ["a"])])).toEqual(["a", "b", "a"]);
    expect(findCycle([t("a", ["b"]), t("b", ["c"]), t("c", ["a"])])).toEqual(["a", "b", "c", "a"]);
    expect(findCycle([{ ...t("a"), depends_on: ["a"] }])).toEqual(["a", "a"]);
  });

  it("reports no cycle for a chain, a diamond, or a reference to a task that does not exist", () => {
    expect(findCycle([t("a", ["b"]), t("b", ["c"]), t("c")])).toBeNull();
    expect(findCycle([t("a", ["b", "c"]), t("b", ["d"]), t("c", ["d"]), t("d")])).toBeNull();
    expect(findCycle([t("a", ["missing"])])).toBeNull();
    expect(findCycle([])).toBeNull();
  });

  it("starts the reported path at the task named first, so a refusal names the edge being added", () => {
    const tasks = [t("c", ["a"]), t("b", ["c"]), t("a", ["b"])];
    expect(findCycle(tasks, "a")).toEqual(["a", "b", "c", "a"]);
  });
});

describe("findSlugOwner", () => {
  it("names the worktree that holds a slug, open or closed, and null when none does", () => {
    const tasks = [t("a", [], "/w/main"), { ...t("b", [], "/w/side"), status: "closed", closed_at: T0.toISOString() }];
    expect(findSlugOwner(tasks, "a")).toBe("/w/main");
    expect(findSlugOwner(tasks, "b")).toBe("/w/side");
    expect(findSlugOwner(tasks, "c")).toBeNull();
  });
});

describe("dependencyStates", () => {
  it("rates a task of another clone from its registered clones: satisfied, open, missing, ambiguous, or unknown", () => {
    const ref = "github.com/acme/widget:a";
    const task = t("x", [ref, "github.com/acme/other:a"]);
    const one = [{ path: "/c1", tasks: [t("a", [], "/c1")] }];
    expect(dependencyStates(task, [task])).toEqual([
      { ref, kind: "clone-task", state: "unknown" },
      { ref: "github.com/acme/other:a", kind: "clone-task", state: "unknown" },
    ]);
    const open = dependencyStates(task, [task], { clones: new Map([["github.com/acme/widget", one]]) });
    expect(open[0]).toEqual({ ref, kind: "clone-task", state: "open" });
    expect(open[1].state).toBe("unknown");
    const done = [{ path: "/c1", tasks: [closed(t("a", [], "/c1"))] }];
    expect(dependencyStates(task, [task], { clones: new Map([["github.com/acme/widget", done]]) })[0].state).toBe("satisfied");
    const none = [{ path: "/c1", tasks: [t("b", [], "/c1")] }];
    expect(dependencyStates(task, [task], { clones: new Map([["github.com/acme/widget", none]]) })[0].state).toBe("missing");
    const two = [...one, { path: "/c2", tasks: [closed(t("a", [], "/c2"))] }];
    expect(dependencyStates(task, [task], { clones: new Map([["github.com/acme/widget", two]]) })[0].state).toBe("ambiguous");
  });

  it("takes the online answer for a pull request or issue, and stays unknown without one", () => {
    const task = t("x", ["acme/widget#1", "acme/widget#2"]);
    const github = new Map([["acme/widget#1", "satisfied"]]);
    expect(dependencyStates(task, [task], { github })).toEqual([
      { ref: "acme/widget#1", kind: "github", state: "satisfied" },
      { ref: "acme/widget#2", kind: "github", state: "unknown" },
    ]);
    expect(nextTasks([task], { github: new Map([["acme/widget#1", "satisfied"], ["acme/widget#2", "satisfied"]]) }).ready).toEqual([
      { slug: "x", worktree: "/w/main", phase: "started" },
    ]);
  });

  it("rates each reference: satisfied, open, missing, or unknown", () => {
    const tasks = [t("a", ["b", "c", "d", "acme/web#1", "github.com/acme/web:z"]), t("b"), closed(t("c"))];
    expect(dependencyStates(tasks[0], tasks)).toEqual([
      { ref: "b", kind: "task", state: "open" },
      { ref: "c", kind: "task", state: "satisfied" },
      { ref: "d", kind: "task", state: "missing" },
      { ref: "acme/web#1", kind: "github", state: "unknown" },
      { ref: "github.com/acme/web:z", kind: "clone-task", state: "unknown" },
    ]);
    expect(dependencyStates(t("solo"), [t("solo")])).toEqual([]);
  });
});

describe("topologicalOrder and buildWorkGraph", () => {
  it("a topological order keeps every edge", () => {
    const diamond = [t("d"), t("b", ["d"]), t("c", ["d"]), t("a", ["b", "c"])];
    const chain = [t("z", ["y"]), t("y", ["x"]), t("x")];
    for (const tasks of [diamond, chain]) {
      const { order, cycle } = topologicalOrder(tasks);
      expect(cycle).toBeNull();
      expect([...order].sort()).toEqual(tasks.map((task) => task.slug).sort());
      for (const [from, to] of cloneEdges(tasks)) expect(order.indexOf(to)).toBeLessThan(order.indexOf(from));
    }
    expect(topologicalOrder(diamond).order).toEqual(["d", "b", "c", "a"]);
  });

  it("orders ties by slug, skips closed and missing dependencies, and leaves a cycle out of the order", () => {
    expect(topologicalOrder([t("b"), t("a"), t("c")]).order).toEqual(["a", "b", "c"]);
    expect(topologicalOrder([t("a", ["gone", "done"]), closed(t("done"))]).order).toEqual(["a"]);
    const { order, cycle } = topologicalOrder([t("a", ["b"]), t("b", ["a"]), t("c")]);
    expect(order).toEqual(["c"]);
    expect(cycle).toEqual(["a", "b", "a"]);
    expect(topologicalOrder([])).toEqual({ order: [], cycle: null });
  });

  it("builds the graph of the open tasks with its edges, order, and cycle", () => {
    const tasks = [t("a", ["b", "acme/web#1"], "/w/main"), t("b", [], "/w/side"), closed(t("c", ["a"]))];
    expect(buildWorkGraph(tasks)).toEqual({
      tasks: [
        { slug: "a", worktree: "/w/main", phase: "started", depends_on: ["b", "acme/web#1"] },
        { slug: "b", worktree: "/w/side", phase: "started", depends_on: [] },
      ],
      edges: [["a", "b"]],
      order: ["b", "a"],
      cycle: null,
    });
  });
});

describe("nextTasks", () => {
  it("splits the open tasks into ready and blocked, each in dependency order", () => {
    const tasks = [t("a", ["b", "acme/web#1"]), t("b", ["c"]), closed(t("c")), t("d"), t("e", ["gone"])];
    expect(nextTasks(tasks)).toEqual({
      order: ["b", "a", "d", "e"],
      ready: [
        { slug: "b", worktree: "/w/main", phase: "started" },
        { slug: "d", worktree: "/w/main", phase: "started" },
      ],
      blocked: [
        {
          slug: "a",
          worktree: "/w/main",
          phase: "started",
          waits_on: [
            { ref: "b", kind: "task", state: "open" },
            { ref: "acme/web#1", kind: "github", state: "unknown" },
          ],
        },
        { slug: "e", worktree: "/w/main", phase: "started", waits_on: [{ ref: "gone", kind: "task", state: "missing" }] },
      ],
    });
  });

  it("never lists a task of a cycle as ready", () => {
    const { ready, blocked } = nextTasks([t("a", ["b"]), t("b", ["a"])]);
    expect(ready).toEqual([]);
    expect(blocked.map((task) => task.slug).sort()).toEqual(["a", "b"]);
  });
});

describe("graph reads through the task CLI", () => {
  it("task next lists a as ready and b as blocked by a", () => {
    const root = repo();
    const side = addWorktree(root, "side");
    put(root, "a");
    put(side, "b", ["a"]);
    const r = run(side, ["next", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.ready).toEqual([{ slug: "a", worktree: root, phase: "started" }]);
    expect(out.blocked).toEqual([{ slug: "b", worktree: side, phase: "started", waits_on: [{ ref: "a", kind: "task", state: "open" }] }]);
    expect(out.order).toEqual(["a", "b"]);
    const text = run(root, ["next"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/ready:\n\s+a /);
    expect(text.stdout).toMatch(/blocked:\n\s+b .*waits on a \(open\)/);
  });

  it("task graph prints every open task of the clone, its edges, the order, and any cycle", () => {
    const root = repo();
    const side = addWorktree(root, "side");
    put(root, "a", ["b", "acme/web#1"]);
    put(side, "b");
    writeTask(side, closed(put(side, "old")));
    const r = run(root, ["graph", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.tasks.map((task) => task.slug)).toEqual(["a", "b"]);
    expect(out.edges).toEqual([["a", "b"]]);
    expect(out.order).toEqual(["b", "a"]);
    expect(out.cycle).toBeNull();
    expect(out.problems).toEqual([]);
    const text = run(root, ["graph"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("a [open]");
    expect(text.stdout).toContain("depends on: b (open), acme/web#1 (unknown)");
    expect(text.stdout).toContain("order: b, a");
    expect(text.stdout).not.toContain("old");
  });

  it("reports a cycle written on disk and still exits 0", () => {
    const root = repo();
    const a = put(root, "a", ["b"]);
    put(root, "b");
    writeTask(root, { ...a, depends_on: ["b"] });
    const bFile = path.join(tasksDir(root), "b.json");
    fs.writeFileSync(bFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(bFile, "utf8")), depends_on: ["a"] }));
    const r = run(root, ["graph"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cycle: a -> b -> a");
    expect(JSON.parse(run(root, ["graph", "--json"]).stdout).cycle).toEqual(["a", "b", "a"]);
    expect(JSON.parse(run(root, ["next", "--json"]).stdout).ready).toEqual([]);
  });

  it("says so when the clone has no open task", () => {
    const root = repo();
    for (const sub of ["graph", "next"]) {
      const r = run(root, [sub]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("no open tasks in this clone");
      const j = JSON.parse(run(root, [sub, "--json"]).stdout);
      expect(j.ok).toBe(true);
      expect(j.order).toEqual([]);
    }
  });

  it("a graph read names an unreadable task file and goes on", () => {
    const root = repo();
    const side = addWorktree(root, "side");
    put(root, "a");
    put(side, "b", ["a"]);
    fs.writeFileSync(path.join(tasksDir(side), "broken.json"), "{not json");
    for (const sub of ["graph", "next"]) {
      const r = run(root, [sub, "--json"]);
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.problems).toHaveLength(1);
      expect(out.problems[0]).toContain("broken.json");
      expect(out.problems[0]).toContain(side);
      expect(out.order).toEqual(["a", "b"]);
      const text = run(root, [sub]);
      expect(text.code).toBe(0);
      expect(text.stderr).toContain("warning");
      expect(text.stderr).toContain("broken.json");
    }
  });

  it("graph and next finish within 1 second for 20 worktrees and 200 tasks", () => {
    const root = repo();
    const roots = [root];
    for (let i = 1; i < 20; i += 1) roots.push(addWorktree(root, `wt-${i}`));
    let n = 0;
    for (const dir of roots) {
      for (let j = 0; j < 10; j += 1) {
        const deps = n > 0 ? [`task-${n - 1}`] : [];
        if (n % 7 === 0 && n > 10) deps.push(`task-${n - 10}`);
        put(dir, `task-${n}`, deps);
        n += 1;
      }
    }
    expect(n).toBe(200);
    const started = performance.now();
    const clone = listCloneTasks(root);
    const graph = buildWorkGraph(clone.tasks);
    const next = nextTasks(clone.tasks);
    const elapsed = performance.now() - started;
    console.log(`graph + next over ${clone.tasks.length} tasks in ${roots.length} worktrees: ${elapsed.toFixed(0)} ms`);
    expect(clone.problems).toEqual([]);
    expect(graph.tasks).toHaveLength(200);
    expect(graph.cycle).toBeNull();
    expect(graph.order).toHaveLength(200);
    expect(next.ready.map((task) => task.slug)).toEqual(["task-0"]);
    expect(next.blocked).toHaveLength(199);
    expect(elapsed).toBeLessThanOrEqual(1000);
  }, 60_000);
});

describe("cross-repo references through the task CLI", () => {
  it("an offline pull request reference is unknown and blocks without calling gh", () => {
    const root = repo();
    put(root, "a", ["acme/widget#1"]);
    const gh = fakeGh();
    const r = run(root, ["next", "--json"], gh.env);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ready).toEqual([]);
    expect(states(out, "a")).toEqual([{ ref: "acme/widget#1", kind: "github", state: "unknown" }]);
    expect(fs.existsSync(gh.log)).toBe(false);
    const graph = run(root, ["graph"], gh.env);
    expect(graph.stdout).toContain("depends on: acme/widget#1 (unknown)");
    expect(fs.existsSync(gh.log)).toBe(false);
  });

  it("--online resolves a merged pull request and a closed issue through gh, and a gh failure or 404 is unknown", () => {
    const root = repo();
    put(root, "a", ["acme/widget#1", "acme/widget#2"]);
    put(root, "b", ["acme/widget#3"]);
    put(root, "c", ["acme/widget#4", "acme/widget#5"]);
    const gh = fakeGh();
    const r = run(root, ["next", "--json", "--online"], gh.env);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ready.map((t) => t.slug)).toEqual(["a"]);
    expect(states(out, "b")).toEqual([{ ref: "acme/widget#3", kind: "github", state: "open" }]);
    expect(states(out, "c")).toEqual([
      { ref: "acme/widget#4", kind: "github", state: "unknown" },
      { ref: "acme/widget#5", kind: "github", state: "unknown" },
    ]);
    expect(out.problems).toEqual([
      expect.stringMatching(/acme\/widget#4: .*HTTP 404/),
      expect.stringMatching(/acme\/widget#5: .*could not connect/),
    ]);
    expect(r.stderr).toMatch(/warning: acme\/widget#4/);
    expect(r.stderr).toMatch(/warning: acme\/widget#5/);
    const calls = fs.readFileSync(gh.log, "utf8").trim().split("\n").sort();
    expect(calls).toEqual([1, 2, 3, 4, 5].map((n) => `api repos/acme/widget/issues/${n}`));
    const graph = run(root, ["graph", "--online"], gh.env);
    expect(graph.code).toBe(0);
    expect(graph.stdout).toContain("depends on: acme/widget#1 (satisfied), acme/widget#2 (satisfied)");
  });

  it("a task of another registered clone resolves offline, and two clones of one repository make it ambiguous", () => {
    const url = "https://github.com/acme/widget.git";
    const widget = cloneOf(url);
    const here = cloneOf("git@github.com:acme/app.git");
    put(here, "x", ["github.com/acme/widget:a", "github.com/acme/widget:nope", "github.com/acme/none:a"]);
    // Not registered yet: the repository is unknown to this machine.
    let out = JSON.parse(run(here, ["next", "--json"]).stdout);
    expect(states(out, "x").map((w) => w.state)).toEqual(["unknown", "unknown", "unknown"]);
    // A task write in widget registers that clone, and nothing calls gh.
    const gh = fakeGh();
    expect(run(widget, ["new", "a", "--goal", "g", "--done-when", "d"], gh.env).code).toBe(0);
    out = JSON.parse(run(here, ["next", "--json"], gh.env).stdout);
    expect(states(out, "x")).toEqual([
      { ref: "github.com/acme/widget:a", kind: "clone-task", state: "open" },
      { ref: "github.com/acme/widget:nope", kind: "clone-task", state: "missing" },
      { ref: "github.com/acme/none:a", kind: "clone-task", state: "unknown" },
    ]);
    expect(fs.existsSync(gh.log)).toBe(false);
    expect(run(widget, ["close", "a"]).code).toBe(0);
    expect(states(JSON.parse(run(here, ["next", "--json"]).stdout), "x")[0].state).toBe("satisfied");
    // A second clone of widget with the same slug: the graph does not choose (R-8).
    const twin = cloneOf(url);
    expect(run(twin, ["new", "a", "--goal", "g", "--done-when", "d"]).code).toBe(0);
    out = JSON.parse(run(here, ["next", "--json"]).stdout);
    expect(states(out, "x")[0]).toEqual({ ref: "github.com/acme/widget:a", kind: "clone-task", state: "ambiguous" });
    expect(out.ready).toEqual([]);
    expect(run(here, ["next"]).stdout).toContain("github.com/acme/widget:a (ambiguous)");
  });

  it("a task write registers the clone once for all its worktrees, and a clone without origin is not registered", () => {
    const url = "ssh://git@github.com/acme/lib.git";
    const lib = cloneOf(url);
    const side = addWorktree(lib, "side");
    expect(run(side, ["new", "s", "--goal", "g", "--done-when", "d"]).code).toBe(0);
    expect(run(lib, ["new", "m", "--goal", "g", "--done-when", "d"]).code).toBe(0);
    expect(run(lib, ["update", "m", "--phase", "p"]).code).toBe(0);
    const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    expect(registry.schema_version).toBe(1);
    expect(registry.repos["github.com/acme/lib"]).toEqual([lib]);
    const local = repo();
    expect(run(local, ["new", "l", "--goal", "g", "--done-when", "d"]).code).toBe(0);
    const after = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
    expect(Object.keys(after.repos).some((k) => k.startsWith("local:"))).toBe(false);
    expect(after.repos["github.com/acme/lib"]).toEqual([lib]);
  });

  it("a registry that cannot be written warns and still writes the task", () => {
    const lib = cloneOf("https://github.com/acme/ro.git");
    const blocked = path.join(makeTempDir("work-graph-ro-"), "state");
    fs.mkdirSync(path.join(blocked, "dotbabel", "graph", "clones.json"), { recursive: true });
    const r = run(lib, ["new", "r", "--goal", "g", "--done-when", "d"], { XDG_STATE_HOME: blocked });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: clone registry/);
    expect(run(lib, ["show", "r"]).code).toBe(0);
  });
});
