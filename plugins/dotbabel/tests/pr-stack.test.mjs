import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STACK_ACTION,
  STACK_PROBLEM,
  buildStackGraph,
  topoOrder,
  planStack,
  planChildTransition,
} from "../src/pr-stack.mjs";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "fixtures", "pr-stack");

/** Load a raw `gh pr list --json …` fixture payload. */
function fixture(name) {
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), "utf8"));
}

const ALPHA_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("buildStackGraph", () => {
  it("returns an empty graph for an empty PR list", () => {
    const g = buildStackGraph(fixture("empty"));
    expect(g.nodes).toEqual({});
    expect(g.roots).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.cycles).toEqual([]);
    expect(g.duplicateHeads).toEqual([]);
    expect(g.ignored).toEqual([]);
  });

  it("defaults trunk to main", () => {
    expect(buildStackGraph(fixture("empty")).trunk).toBe("main");
  });

  it("builds a single root node for one PR based on trunk", () => {
    const g = buildStackGraph([
      { number: 1, headRefName: "feat/solo", baseRefName: "main", state: "OPEN", mergeStateStatus: "CLEAN" },
    ]);
    expect(g.roots).toEqual([1]);
    expect(g.nodes["1"].parent).toBeNull();
    expect(g.nodes["1"].depth).toBe(0);
    expect(g.nodes["1"].rootedOnTrunk).toBe(true);
    expect(g.nodes["1"].orphan).toBe(false);
  });

  it("links child to parent when child.baseRefName === parent.headRefName", () => {
    const g = buildStackGraph(fixture("two-pr-stack"));
    expect(g.nodes["812"].parent).toBe(811);
    expect(g.nodes["811"].parent).toBeNull();
  });

  it("records the reverse edge on the parent's children array", () => {
    const g = buildStackGraph(fixture("two-pr-stack"));
    expect(g.nodes["811"].children).toEqual([812]);
    expect(g.nodes["812"].children).toEqual([]);
    expect(g.edges).toEqual([{ parent: 811, child: 812 }]);
  });

  it("assigns depth 0 to trunk-rooted PRs and depth N to descendants", () => {
    const g = buildStackGraph(fixture("two-pr-stack"));
    expect(g.nodes["811"].depth).toBe(0);
    expect(g.nodes["812"].depth).toBe(1);
  });

  it("builds a 3-deep chain with correct depths and a single root", () => {
    const g = buildStackGraph(fixture("three-deep"));
    expect(g.roots).toEqual([10]);
    expect(g.nodes["10"].depth).toBe(0);
    expect(g.nodes["20"].depth).toBe(1);
    expect(g.nodes["30"].depth).toBe(2);
  });

  it("treats two PRs sharing one parent as a fan-out, not a cycle", () => {
    const g = buildStackGraph(fixture("fan-out"));
    expect(g.nodes["10"].children).toEqual([21, 22]);
    expect(g.nodes["21"].depth).toBe(1);
    expect(g.nodes["22"].depth).toBe(1);
    expect(g.cycles).toEqual([]);
  });

  it("flags two PRs sharing a headRefName as duplicate-head", () => {
    const g = buildStackGraph(fixture("duplicate-head"));
    expect(g.duplicateHeads).toEqual([{ head: "feat/dupe", numbers: [7, 9] }]);
  });

  it("binds byHead to the lowest PR number when heads collide", () => {
    const g = buildStackGraph(fixture("duplicate-head"));
    expect(g.byHead["feat/dupe"]).toBe(7);
  });

  it("binds byHead to the open PR when the older duplicates are merged", () => {
    const g = buildStackGraph([
      { number: 266, headRefName: "release-please--main", baseRefName: "main", state: "MERGED" },
      { number: 272, headRefName: "release-please--main", baseRefName: "main", state: "MERGED" },
      { number: 277, headRefName: "release-please--main", baseRefName: "main", state: "OPEN" },
    ]);
    expect(g.byHead["release-please--main"]).toBe(277);
  });

  it("marks a PR as orphan when its base is neither trunk nor a known PR head", () => {
    const g = buildStackGraph(fixture("orphan"));
    expect(g.nodes["55"].orphan).toBe(true);
    expect(g.nodes["55"].parent).toBeNull();
    expect(g.nodes["55"].rootedOnTrunk).toBe(false);
  });

  it("records parentState MERGED when the parent PR is merged", () => {
    const g = buildStackGraph([
      { number: 1, headRefName: "feat/alpha", baseRefName: "main", state: "MERGED", mergeStateStatus: "CLEAN" },
      { number: 2, headRefName: "feat/beta", baseRefName: "feat/alpha", state: "OPEN", mergeStateStatus: "BLOCKED" },
    ]);
    expect(g.nodes["2"].parentState).toBe("MERGED");
  });

  it("records parentState CLOSED when the parent was closed without merging", () => {
    const g = buildStackGraph([
      { number: 1, headRefName: "feat/alpha", baseRefName: "main", state: "CLOSED", mergeStateStatus: "CLEAN" },
      { number: 2, headRefName: "feat/beta", baseRefName: "feat/alpha", state: "OPEN", mergeStateStatus: "BLOCKED" },
    ]);
    expect(g.nodes["2"].parentState).toBe("CLOSED");
  });

  it("detects a 2-node cycle, sets inCycle and depth null", () => {
    const g = buildStackGraph(fixture("cycle"));
    expect(g.cycles).toEqual([[900, 901]]);
    expect(g.nodes["900"].inCycle).toBe(true);
    expect(g.nodes["901"].inCycle).toBe(true);
    expect(g.nodes["900"].depth).toBeNull();
  });

  it("rotates a reported cycle to start at the lowest number", () => {
    const g = buildStackGraph(fixture("cycle"));
    expect(g.cycles[0][0]).toBe(900);
  });

  it("keeps an unrelated healthy chain intact alongside a cycle", () => {
    const g = buildStackGraph(fixture("cycle"));
    expect(g.nodes["700"].inCycle).toBe(false);
    expect(g.nodes["700"].depth).toBe(0);
    expect(g.roots).toEqual([700]);
  });

  it("honors a non-default trunk", () => {
    const g = buildStackGraph(
      [{ number: 1, headRefName: "feat/x", baseRefName: "develop", state: "OPEN", mergeStateStatus: "CLEAN" }],
      { trunk: "develop" },
    );
    expect(g.trunk).toBe("develop");
    expect(g.nodes["1"].rootedOnTrunk).toBe(true);
    expect(g.nodes["1"].orphan).toBe(false);
  });

  it("moves malformed entries to ignored instead of throwing", () => {
    const g = buildStackGraph([
      null,
      { headRefName: "feat/no-number", baseRefName: "main" },
      { number: 3, baseRefName: "main" },
      { number: 4, headRefName: "feat/no-base" },
      { number: 5, headRefName: "feat/ok", baseRefName: "main", state: "OPEN", mergeStateStatus: "CLEAN" },
    ]);
    expect(Object.keys(g.nodes)).toEqual(["5"]);
    expect(g.ignored).toHaveLength(4);
    expect(g.ignored[0].reason).toBeTruthy();
  });

  it("does not throw on a non-array input", () => {
    expect(() => buildStackGraph(undefined)).not.toThrow();
    expect(buildStackGraph(undefined).nodes).toEqual({});
  });

  it("returns a JSON-serializable graph", () => {
    const g = buildStackGraph(fixture("three-deep"));
    expect(JSON.parse(JSON.stringify(g))).toEqual(g);
  });

  it("sorts roots, children, and edges ascending for determinism", () => {
    const g = buildStackGraph(fixture("fan-out"));
    expect(g.nodes["10"].children).toEqual([...g.nodes["10"].children].sort((a, b) => a - b));
    expect(g.edges.map((e) => e.child)).toEqual([21, 22]);
  });
});

describe("topoOrder", () => {
  it("returns an empty order for an empty graph", () => {
    expect(topoOrder(buildStackGraph(fixture("empty")))).toEqual({
      ok: true,
      order: [],
      cycles: [],
      unordered: [],
    });
  });

  it("orders parent before child for a 2-PR stack", () => {
    expect(topoOrder(buildStackGraph(fixture("two-pr-stack"))).order).toEqual([811, 812]);
  });

  it("orders a 3-deep chain root to leaf", () => {
    expect(topoOrder(buildStackGraph(fixture("three-deep"))).order).toEqual([10, 20, 30]);
  });

  it("breaks fan-out ties by ascending PR number", () => {
    expect(topoOrder(buildStackGraph(fixture("fan-out"))).order).toEqual([10, 21, 22]);
  });

  it("returns ok:false with cycle members listed in unordered", () => {
    const r = topoOrder(buildStackGraph(fixture("cycle")));
    expect(r.ok).toBe(false);
    expect(r.unordered).toEqual([900, 901]);
    expect(r.cycles).toEqual([[900, 901]]);
  });

  it("still orders the acyclic remainder when part of the graph cycles", () => {
    expect(topoOrder(buildStackGraph(fixture("cycle"))).order).toEqual([700]);
  });

  it("places an orphan-based PR at the front as its own root", () => {
    expect(topoOrder(buildStackGraph(fixture("orphan"))).order).toEqual([55]);
  });

  it("is idempotent", () => {
    const g = buildStackGraph(fixture("three-deep"));
    expect(topoOrder(g)).toEqual(topoOrder(g));
  });
});

describe("planStack", () => {
  it("marks a lone trunk-based CLEAN PR as actionable with action land", () => {
    const p = planStack(
      buildStackGraph([
        { number: 1, headRefName: "feat/solo", baseRefName: "main", state: "OPEN", mergeStateStatus: "CLEAN" },
      ]),
    );
    expect(p.ok).toBe(true);
    expect(p.actionable).toHaveLength(1);
    expect(p.actionable[0].action).toBe(STACK_ACTION.LAND);
  });

  it("marks the parent actionable and the child waiting on it", () => {
    const p = planStack(buildStackGraph(fixture("two-pr-stack")));
    expect(p.actionable.map((a) => a.number)).toEqual([811]);
    expect(p.pending).toHaveLength(1);
    expect(p.pending[0].number).toBe(812);
    expect(p.pending[0].action).toBe(STACK_ACTION.WAIT);
    expect(p.pending[0].blockedBy).toEqual([811]);
  });

  it("marks the child as retarget once the parent is MERGED", () => {
    const p = planStack(
      buildStackGraph([
        { number: 1, headRefName: "feat/alpha", baseRefName: "main", state: "MERGED", mergeStateStatus: "CLEAN" },
        { number: 2, headRefName: "feat/beta", baseRefName: "feat/alpha", state: "OPEN", mergeStateStatus: "BLOCKED" },
      ]),
    );
    const child = p.actionable.find((a) => a.number === 2);
    expect(child.action).toBe(STACK_ACTION.RETARGET);
  });

  it("records a parent-closed-unmerged problem when the parent was closed", () => {
    const p = planStack(
      buildStackGraph([
        { number: 1, headRefName: "feat/alpha", baseRefName: "main", state: "CLOSED", mergeStateStatus: "CLEAN" },
        { number: 2, headRefName: "feat/beta", baseRefName: "feat/alpha", state: "OPEN", mergeStateStatus: "BLOCKED" },
      ]),
    );
    expect(p.ok).toBe(false);
    expect(p.problems.map((x) => x.kind)).toContain(STACK_PROBLEM.PARENT_CLOSED_UNMERGED);
  });

  it("marks a trunk-based BEHIND PR as rebase, not land", () => {
    const p = planStack(
      buildStackGraph([
        { number: 1, headRefName: "feat/solo", baseRefName: "main", state: "OPEN", mergeStateStatus: "BEHIND" },
      ]),
    );
    expect(p.actionable[0].action).toBe(STACK_ACTION.REBASE);
  });

  it("marks a trunk-based DIRTY PR as rebase", () => {
    const p = planStack(
      buildStackGraph([
        { number: 1, headRefName: "feat/solo", baseRefName: "main", state: "OPEN", mergeStateStatus: "DIRTY" },
      ]),
    );
    expect(p.actionable[0].action).toBe(STACK_ACTION.REBASE);
  });

  it("reports a cycle as a problem and sets ok:false", () => {
    const p = planStack(buildStackGraph(fixture("cycle")));
    expect(p.ok).toBe(false);
    expect(p.problems.map((x) => x.kind)).toContain(STACK_PROBLEM.CYCLE);
  });

  it("reports an orphan base as a problem and sets ok:false", () => {
    const p = planStack(buildStackGraph(fixture("orphan")));
    expect(p.ok).toBe(false);
    expect(p.problems.map((x) => x.kind)).toContain(STACK_PROBLEM.ORPHAN_BASE);
  });

  it("reports duplicate heads as a problem when two of them are open", () => {
    const p = planStack(buildStackGraph(fixture("duplicate-head")));
    expect(p.ok).toBe(false);
    expect(p.problems.map((x) => x.kind)).toContain(STACK_PROBLEM.DUPLICATE_HEAD);
  });

  it("does not report duplicate heads when only one of them is open", () => {
    // A release bot that reuses one branch across releases is normal, not a defect.
    const p = planStack(
      buildStackGraph([
        { number: 266, headRefName: "release-please--main", baseRefName: "main", state: "MERGED" },
        { number: 272, headRefName: "release-please--main", baseRefName: "main", state: "MERGED" },
        { number: 277, headRefName: "release-please--main", baseRefName: "main", state: "OPEN" },
      ]),
    );
    expect(p.problems).toEqual([]);
    expect(p.ok).toBe(true);
  });

  it("returns ok:true and no problems for a clean 3-deep stack", () => {
    const p = planStack(buildStackGraph(fixture("three-deep")));
    expect(p.ok).toBe(true);
    expect(p.problems).toEqual([]);
    expect(p.order).toEqual([10, 20, 30]);
  });

  it("keeps counts consistent with the arrays", () => {
    const p = planStack(buildStackGraph(fixture("three-deep")));
    expect(p.counts.total).toBe(3);
    expect(p.counts.actionable).toBe(p.actionable.length);
    expect(p.counts.pending).toBe(p.pending.length);
    expect(p.counts.problems).toBe(p.problems.length);
  });

  it("returns ok:true with empty arrays for an empty graph", () => {
    const p = planStack(buildStackGraph(fixture("empty")));
    expect(p).toMatchObject({ ok: true, actionable: [], pending: [], problems: [] });
  });

  it("gives every entry a human-readable reason", () => {
    const p = planStack(buildStackGraph(fixture("two-pr-stack")));
    for (const entry of [...p.actionable, ...p.pending]) {
      expect(typeof entry.reason).toBe("string");
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("planChildTransition", () => {
  const mergedParent = {
    number: 811,
    headRefName: "feat/alpha",
    baseRefName: "main",
    state: "MERGED",
    headRefOid: ALPHA_SHA,
  };
  const child = {
    number: 812,
    headRefName: "feat/beta",
    baseRefName: "feat/alpha",
    state: "OPEN",
    mergeStateStatus: "BEHIND",
  };

  it("emits rebase --onto with the parent SHA when the parent squash-merged", () => {
    const t = planChildTransition({ child, parent: mergedParent });
    const rebase = t.steps.find((s) => s.id === "rebase");
    expect(rebase.cmd).toBe(`git rebase --onto origin/main ${ALPHA_SHA} feat/beta`);
  });

  it("never emits a bare rebase onto the trunk when the base was a PR branch", () => {
    const t = planChildTransition({ child, parent: mergedParent });
    for (const step of t.steps) {
      expect(step.cmd).not.toBe("git rebase origin/main");
    }
  });

  it("retargets the base before rebasing", () => {
    const t = planChildTransition({ child, parent: mergedParent });
    expect(t.steps[0]).toEqual({ id: "retarget", cmd: "gh pr edit 812 --base main" });
    expect(t.needsRetarget).toBe(true);
    expect(t.oldBase).toBe("feat/alpha");
    expect(t.newBase).toBe("main");
    expect(t.action).toBe(STACK_ACTION.RETARGET);
  });

  it("falls back to the parent branch name and warns when headRefOid is absent", () => {
    const t = planChildTransition({ child, parent: { ...mergedParent, headRefOid: undefined } });
    const rebase = t.steps.find((s) => s.id === "rebase");
    expect(rebase.cmd).toBe("git rebase --onto origin/main feat/alpha feat/beta");
    expect(t.warnings.join(" ")).toMatch(/deleted/i);
  });

  // `merge-pr` squash-merges with --delete-branch, and GitHub then AUTO-RETARGETS
  // any open child onto the deleted branch's base. So the child usually arrives
  // ALREADY based on the trunk — a base-pointer comparison cannot tell us whether
  // the parent's commits are still in its history. Keying off it emitted a bare
  // rebase + force-push, the exact corruption this module exists to prevent.
  it("still uses rebase --onto when GitHub already retargeted the child onto the trunk", () => {
    const t = planChildTransition({
      child: { ...child, baseRefName: "main", mergeStateStatus: "BEHIND" },
      parent: mergedParent,
    });
    expect(t.needsRetarget).toBe(false);
    expect(t.rebaseKind).toBe("onto");
    expect(t.steps.find((s) => s.id === "rebase").cmd).toBe(
      `git rebase --onto origin/main ${ALPHA_SHA} feat/beta`,
    );
  });

  it("never emits a bare trunk rebase on any merged-parent path", () => {
    for (const status of ["BEHIND", "DIRTY", "CLEAN", "BLOCKED"]) {
      for (const base of ["main", "feat/alpha"]) {
        const t = planChildTransition({
          child: { ...child, baseRefName: base, mergeStateStatus: status },
          parent: mergedParent,
        });
        for (const step of t.steps) {
          expect(step.cmd).not.toBe("git rebase origin/main");
        }
      }
    }
  });

  it("uses --onto even when the child is CLEAN, since cleanliness proves nothing", () => {
    const t = planChildTransition({
      child: { ...child, baseRefName: "main", mergeStateStatus: "CLEAN" },
      parent: mergedParent,
    });
    expect(t.rebaseKind).toBe("onto");
    expect(t.needsRebase).toBe(true);
  });

  it("returns land with zero steps only when told the parent commits are already gone", () => {
    const t = planChildTransition({
      child: { ...child, baseRefName: "main", mergeStateStatus: "CLEAN" },
      parent: mergedParent,
      parentCommitsInChild: false,
    });
    expect(t.action).toBe(STACK_ACTION.LAND);
    expect(t.needsRebase).toBe(false);
    expect(t.steps).toEqual([]);
  });

  it("rejects a parent SHA that is not a hex object name", () => {
    expect(() =>
      planChildTransition({ child, parent: { ...mergedParent, headRefOid: "$(id)" } }),
    ).toThrow(/sha/i);
  });

  it("rejects a parent SHA shorter than 7 characters", () => {
    expect(() =>
      planChildTransition({ child, parent: { ...mergedParent, headRefOid: "abc" } }),
    ).toThrow(/sha/i);
  });

  it("returns action wait with zero steps when the parent is still OPEN", () => {
    const t = planChildTransition({ child, parent: { ...mergedParent, state: "OPEN" } });
    expect(t.action).toBe(STACK_ACTION.WAIT);
    expect(t.steps).toEqual([]);
    expect(t.needsRetarget).toBe(false);
    expect(t.needsRebase).toBe(false);
  });

  it("retargets but emits no rebase step when the parent was CLOSED unmerged", () => {
    const t = planChildTransition({ child, parent: { ...mergedParent, state: "CLOSED" } });
    expect(t.needsRetarget).toBe(true);
    expect(t.rebaseKind).toBeNull();
    expect(t.steps.map((s) => s.id)).toEqual(["retarget"]);
  });

  it("warns that a closed parent's commits remain in the child's diff", () => {
    const t = planChildTransition({ child, parent: { ...mergedParent, state: "CLOSED" } });
    expect(t.warnings.join(" ")).toMatch(/remain/i);
  });

  it("requires confirmation whenever a force-push step is present", () => {
    const t = planChildTransition({ child, parent: mergedParent });
    expect(t.steps.some((s) => s.cmd.includes("--force-with-lease"))).toBe(true);
    expect(t.confirmationRequired).toBe(true);
  });

  it("never requires confirmation when there are no steps", () => {
    const t = planChildTransition({ child, parent: { ...mergedParent, state: "OPEN" } });
    expect(t.confirmationRequired).toBe(false);
  });

  it("honors a custom remote and trunk in every emitted command", () => {
    const t = planChildTransition({
      child,
      parent: { ...mergedParent, baseRefName: "develop" },
      trunk: "develop",
      remote: "upstream",
    });
    expect(t.newBase).toBe("develop");
    expect(t.steps.find((s) => s.id === "rebase").cmd).toContain("upstream/develop");
    expect(t.steps.find((s) => s.id === "retarget").cmd).toBe("gh pr edit 812 --base develop");
    expect(t.steps.find((s) => s.id === "push").cmd).toContain("upstream");
  });

  it("retargets to the grandparent head, not trunk, in a 3-deep stack", () => {
    const t = planChildTransition({
      child: { number: 30, headRefName: "feat/gamma", baseRefName: "feat/beta", state: "OPEN", mergeStateStatus: "BEHIND" },
      parent: { number: 20, headRefName: "feat/beta", baseRefName: "feat/alpha", state: "MERGED", headRefOid: ALPHA_SHA },
    });
    expect(t.newBase).toBe("feat/alpha");
    expect(t.steps.find((s) => s.id === "retarget").cmd).toBe("gh pr edit 30 --base feat/alpha");
  });

  it("rejects branch names containing shell metacharacters", () => {
    expect(() =>
      planChildTransition({ child: { ...child, headRefName: "feat/x; rm -rf /" }, parent: mergedParent }),
    ).toThrow(/branch/i);
  });

  it("produces commands free of shell metacharacters for well-formed branches", () => {
    const t = planChildTransition({ child, parent: mergedParent });
    for (const step of t.steps) {
      expect(step.cmd).not.toMatch(/[;&|`$(){}<>]/);
    }
  });
});

describe("module purity", () => {
  it("pr-stack.mjs performs no I/O", () => {
    const src = readFileSync(resolve(HERE, "..", "src", "pr-stack.mjs"), "utf8");
    expect(src).not.toMatch(/node:child_process|node:fs|node:os|node:process/);
  });
});
