// Unit tests for src/work-graph.mjs: the pure half of the work graph. The
// worktree list comes in as text, the tasks come in as records, and nothing
// here touches git or the disk.

import { describe, expect, it } from "vitest";
import { createTask } from "../src/task-state.mjs";
import { cloneEdges, findCycle, findSlugOwner, parseWorktreeList } from "../src/work-graph.mjs";

const T0 = new Date("2026-10-12T10:00:00Z");

function t(slug, dependsOn = [], worktree = "/w/main") {
  return createTask({ slug, goal: `goal ${slug}`, doneWhen: ["done"], dependsOn, worktree, now: T0 });
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
