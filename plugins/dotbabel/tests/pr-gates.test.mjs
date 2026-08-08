import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONDUCTOR_PHASES,
  checkLocalAttestGate,
  checkMergeGate,
  hasSkipCi,
  summarizeGates,
} from "../src/pr-gates.mjs";

const HERE = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));

const SHA = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";
const GOOD_BODY = "## Summary\n\n- does a thing\n\n## Test plan\n\n- [x] npm test\n";

/** Extract the reason codes from a gate result. */
const codes = (result) => result.reasons.map((r) => r.code);

describe("CONDUCTOR_PHASES", () => {
  it("declares the six pipeline phases in order", () => {
    expect(CONDUCTOR_PHASES.map((p) => p.id)).toEqual([
      "pre-pr",
      "open-pr",
      "post-pr-review",
      "review-pr",
      "local-attest",
      "stop",
    ]);
  });

  it("names a real artifact and invocation for every phase", () => {
    for (const phase of CONDUCTOR_PHASES) {
      expect(phase.artifact).toMatch(/^(skills\/.+\/SKILL\.md|commands\/.+\.md)$/);
      expect(phase.invocation.length).toBeGreaterThan(0);
    }
  });

  it("names merge-pr only in the terminal stop phase", () => {
    const mentions = CONDUCTOR_PHASES.filter((p) => p.artifact.includes("merge-pr"));
    expect(mentions).toHaveLength(1);
    expect(mentions[0].id).toBe("stop");
  });

  it("is frozen at both levels", () => {
    expect(Object.isFrozen(CONDUCTOR_PHASES)).toBe(true);
    expect(Object.isFrozen(CONDUCTOR_PHASES[0])).toBe(true);
  });
});

describe("checkLocalAttestGate", () => {
  const clean = { branch: "feat/beta", worktreeStatus: "", localHead: SHA, prHeadOid: SHA, prNumber: 812 };

  it("passes when the tree is clean and local HEAD equals the PR head", () => {
    const r = checkLocalAttestGate(clean);
    expect(r.ok).toBe(true);
    expect(r.gate).toBe("local-attest");
    expect(r.reasons).toEqual([]);
  });

  it("fails WORKTREE_DIRTY and echoes the porcelain output", () => {
    const r = checkLocalAttestGate({ ...clean, worktreeStatus: " M main.go\n" });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("WORKTREE_DIRTY");
    expect(r.reasons.find((x) => x.code === "WORKTREE_DIRTY").detail).toContain("main.go");
  });

  it("treats a whitespace-only porcelain string as clean", () => {
    expect(checkLocalAttestGate({ ...clean, worktreeStatus: "  \n \n" }).ok).toBe(true);
  });

  it("fails HEAD_MISMATCH and names both short SHAs", () => {
    const other = "0000000000000000000000000000000000000000";
    const r = checkLocalAttestGate({ ...clean, prHeadOid: other });
    expect(codes(r)).toContain("HEAD_MISMATCH");
    expect(r.reasons.find((x) => x.code === "HEAD_MISMATCH").message).toContain(SHA.slice(0, 8));
    expect(r.reasons.find((x) => x.code === "HEAD_MISMATCH").message).toContain(other.slice(0, 8));
  });

  it("accepts an abbreviated PR head as a prefix match", () => {
    expect(checkLocalAttestGate({ ...clean, prHeadOid: SHA.slice(0, 7) }).ok).toBe(true);
  });

  it("rejects a prefix shorter than 7 characters", () => {
    expect(checkLocalAttestGate({ ...clean, prHeadOid: SHA.slice(0, 4) }).ok).toBe(false);
  });

  it("is case-insensitive on SHA hex", () => {
    expect(checkLocalAttestGate({ ...clean, prHeadOid: SHA.toUpperCase() }).ok).toBe(true);
  });

  it("fails DETACHED_HEAD when the branch is literally HEAD", () => {
    expect(codes(checkLocalAttestGate({ ...clean, branch: "HEAD" }))).toContain("DETACHED_HEAD");
  });

  it("fails NO_PR when prNumber is null", () => {
    expect(codes(checkLocalAttestGate({ ...clean, prNumber: null }))).toContain("NO_PR");
  });

  it("collects every failing reason rather than short-circuiting", () => {
    const r = checkLocalAttestGate({
      branch: "HEAD",
      worktreeStatus: " M x\n",
      localHead: SHA,
      prHeadOid: "1111111111111111111111111111111111111111",
      prNumber: null,
    });
    expect(codes(r).sort()).toEqual(["DETACHED_HEAD", "HEAD_MISMATCH", "NO_PR", "WORKTREE_DIRTY"]);
  });

  it("offers a hint when it fails", () => {
    expect(checkLocalAttestGate({ ...clean, worktreeStatus: " M x" }).hint).toBeTruthy();
  });
});

describe("checkMergeGate", () => {
  const base = { body: GOOD_BODY, hasSpecsDir: false, changedPaths: [], protectedPaths: [] };

  it("passes with both required headings present", () => {
    const r = checkMergeGate(base);
    expect(r.ok).toBe(true);
    expect(r.gate).toBe("merge");
  });

  it("fails MISSING_SUMMARY when only the test plan is present", () => {
    expect(codes(checkMergeGate({ ...base, body: "## Test plan\n\n- [x] ok\n" }))).toContain("MISSING_SUMMARY");
  });

  it("fails MISSING_TEST_PLAN when only the summary is present", () => {
    expect(codes(checkMergeGate({ ...base, body: "## Summary\n\n- x\n" }))).toContain("MISSING_TEST_PLAN");
  });

  it("fails EMPTY_BODY on a whitespace-only body", () => {
    expect(codes(checkMergeGate({ ...base, body: "   \n\n" }))).toEqual(["EMPTY_BODY"]);
  });

  it("fails EMPTY_BODY on a null body", () => {
    expect(codes(checkMergeGate({ ...base, body: null }))).toEqual(["EMPTY_BODY"]);
  });

  it("rejects an h3 heading — the level must be exactly h2", () => {
    expect(codes(checkMergeGate({ ...base, body: "### Summary\n\n## Test plan\n" }))).toContain("MISSING_SUMMARY");
  });

  it("rejects a heading with trailing words", () => {
    expect(codes(checkMergeGate({ ...base, body: "## Summary of changes\n\n## Test plan\n" }))).toContain(
      "MISSING_SUMMARY",
    );
  });

  it("accepts trailing whitespace after the heading text", () => {
    expect(checkMergeGate({ ...base, body: "## Summary   \n\n## Test plan\t\n" }).ok).toBe(true);
  });

  it("accepts up to three leading spaces", () => {
    expect(checkMergeGate({ ...base, body: "   ## Summary\n\n   ## Test plan\n" }).ok).toBe(true);
  });

  it("rejects four leading spaces as an indented code block", () => {
    expect(checkMergeGate({ ...base, body: "    ## Summary\n\n## Test plan\n" }).ok).toBe(false);
  });

  it("does not count headings inside a fenced code block", () => {
    const body = "Docs for the template:\n\n```markdown\n## Summary\n\n## Test plan\n```\n";
    const r = checkMergeGate({ ...base, body });
    expect(r.ok).toBe(false);
    expect(codes(r).sort()).toEqual(["MISSING_SUMMARY", "MISSING_TEST_PLAN"]);
  });

  it("still sees headings outside the fence", () => {
    const body = "## Summary\n\n```markdown\n## Test plan\n```\n\n## Test plan\n\n- [x] ok\n";
    expect(checkMergeGate({ ...base, body }).ok).toBe(true);
  });

  it("handles tilde fences", () => {
    const body = "~~~\n## Summary\n## Test plan\n~~~\n";
    expect(checkMergeGate({ ...base, body }).ok).toBe(false);
  });

  // A naive toggle flips polarity on the inner fence and leaks the headings back
  // out as real body text — letting a body that merely DOCUMENTS the template
  // satisfy the gate, including the protected-path Spec ID requirement.
  it("does not count headings inside a nested fenced block", () => {
    const body = ["````markdown", "```text", "## Summary", "## Test plan", "## Spec ID", "```", "````"].join(
      "\n",
    );
    const r = checkMergeGate({ ...base, body, hasSpecsDir: true });
    expect(r.ok).toBe(false);
    expect(codes(r).sort()).toEqual(["MISSING_SPEC_ID", "MISSING_SUMMARY", "MISSING_TEST_PLAN"]);
  });

  it("closes a fence only on a run at least as long as the opener", () => {
    const body = ["````", "```", "## Summary", "````", "", "## Test plan", ""].join("\n");
    expect(codes(checkMergeGate({ ...base, body }))).toContain("MISSING_SUMMARY");
  });

  it("does not treat a closing fence with an info string as a close", () => {
    const body = ["```", "## Summary", "```js", "## Test plan", "```"].join("\n");
    expect(checkMergeGate({ ...base, body }).ok).toBe(false);
  });

  it("matches a single character with ? but not a separator", () => {
    expect(checkMergeGate({ ...base, changedPaths: ["a/b.mjs"], protectedPaths: ["a/?.mjs"] }).ok).toBe(false);
    expect(checkMergeGate({ ...base, changedPaths: ["a/bc.mjs"], protectedPaths: ["a/?.mjs"] }).ok).toBe(true);
  });

  it("normalizes CRLF line endings", () => {
    expect(checkMergeGate({ ...base, body: "## Summary\r\n\r\n## Test plan\r\n" }).ok).toBe(true);
  });

  it("is case-insensitive on the heading text", () => {
    expect(checkMergeGate({ ...base, body: "## summary\n\n## TEST PLAN\n" }).ok).toBe(true);
  });

  it("requires a spec id when the repo has a specs directory", () => {
    expect(codes(checkMergeGate({ ...base, hasSpecsDir: true }))).toContain("MISSING_SPEC_ID");
  });

  it("accepts a Spec ID heading", () => {
    const body = `${GOOD_BODY}\n## Spec ID\n\ndotbabel-core\n`;
    expect(checkMergeGate({ ...base, hasSpecsDir: true, body }).ok).toBe(true);
  });

  it("accepts a No-spec rationale heading as a substitute", () => {
    const body = `${GOOD_BODY}\n## No-spec rationale\n\ntypo fix\n`;
    expect(checkMergeGate({ ...base, hasSpecsDir: true, body }).ok).toBe(true);
  });

  it("requires a spec id when a changed path matches a protected glob", () => {
    const r = checkMergeGate({
      ...base,
      changedPaths: ["plugins/dotbabel/src/pr-stack.mjs"],
      protectedPaths: ["plugins/dotbabel/src/**"],
    });
    expect(codes(r)).toContain("MISSING_SPEC_ID");
    expect(r.reasons.find((x) => x.code === "MISSING_SPEC_ID").detail).toBe("plugins/dotbabel/src/pr-stack.mjs");
  });

  it("does not require a spec id when no changed path matches", () => {
    expect(
      checkMergeGate({ ...base, changedPaths: ["README.md"], protectedPaths: ["plugins/dotbabel/src/**"] }).ok,
    ).toBe(true);
  });

  it("does not let a single star cross a path separator", () => {
    expect(
      checkMergeGate({ ...base, changedPaths: ["plugins/dotbabel/src/a/b.mjs"], protectedPaths: ["plugins/*"] }).ok,
    ).toBe(true);
  });

  it("matches a double star across separators", () => {
    expect(
      checkMergeGate({ ...base, changedPaths: ["a/b/c/d.mjs"], protectedPaths: ["a/**"] }).ok,
    ).toBe(false);
  });

  it("treats glob special characters literally outside of stars", () => {
    expect(checkMergeGate({ ...base, changedPaths: ["a.b.mjs"], protectedPaths: ["axb.mjs"] }).ok).toBe(true);
  });

  it("fails NOT_MERGEABLE when the PR conflicts", () => {
    expect(codes(checkMergeGate({ ...base, mergeable: "CONFLICTING" }))).toContain("NOT_MERGEABLE");
  });

  it("fails BEHIND_BASE when the branch is behind", () => {
    expect(codes(checkMergeGate({ ...base, mergeStateStatus: "BEHIND" }))).toContain("BEHIND_BASE");
  });

  it("passes with an UNSTABLE merge state", () => {
    expect(checkMergeGate({ ...base, mergeStateStatus: "UNSTABLE" }).ok).toBe(true);
  });
});

describe("hasSkipCi", () => {
  it("detects a subject-line marker as effective", () => {
    expect(hasSkipCi("chore: wip [skip ci]\n\nbody")).toEqual({
      present: true,
      marker: "[skip ci]",
      location: "subject",
      effective: true,
    });
  });

  it("detects the [ci skip] spelling", () => {
    expect(hasSkipCi("chore: wip [ci skip]").effective).toBe(true);
  });

  it.each([["[no ci]"], ["[skip actions]"], ["[actions skip]"]])("detects %s", (marker) => {
    expect(hasSkipCi(`chore: wip ${marker}`).effective).toBe(true);
  });

  it("is case-insensitive on the marker", () => {
    expect(hasSkipCi("chore: wip [SKIP CI]").present).toBe(true);
  });

  it("detects a marker on the last line as effective", () => {
    const r = hasSkipCi("chore: wip\n\nsome body\n\n[skip ci]");
    expect(r.location).toBe("last-line");
    expect(r.effective).toBe(true);
  });

  it("reports a mid-body marker as present but not effective", () => {
    const r = hasSkipCi("chore: wip\n\n[skip ci] noted here\n\nmore body");
    expect(r).toMatchObject({ present: true, location: "body", effective: false });
  });

  it("detects the skip-checks trailer as effective", () => {
    const r = hasSkipCi("chore: wip\n\nbody\n\nskip-checks: true");
    expect(r).toMatchObject({ marker: "skip-checks: true", location: "trailer", effective: true });
  });

  it("returns present:false when there is no marker", () => {
    expect(hasSkipCi("feat: real work")).toEqual({
      present: false,
      marker: null,
      location: null,
      effective: false,
    });
  });

  it.each([[""], [null], [undefined], [42]])("returns present:false for %p", (input) => {
    expect(hasSkipCi(input).present).toBe(false);
  });

  it("treats a single-line message as its own subject", () => {
    expect(hasSkipCi("chore: wip [skip ci]").location).toBe("subject");
  });

  it("ignores trailing blank lines when locating the last line", () => {
    expect(hasSkipCi("chore: wip\n\nbody\n\n[skip ci]\n\n\n").effective).toBe(true);
  });
});

describe("summarizeGates", () => {
  it("reports ok:true when every gate passed", () => {
    const s = summarizeGates([
      { ok: true, gate: "a", reasons: [], hint: null },
      { ok: true, gate: "b", reasons: [], hint: null },
    ]);
    expect(s).toMatchObject({ ok: true, passed: ["a", "b"], failed: [] });
  });

  it("collects failed gate names and dedupes reason codes", () => {
    const s = summarizeGates([
      { ok: false, gate: "a", reasons: [{ code: "X", message: "" }], hint: null },
      { ok: false, gate: "b", reasons: [{ code: "X", message: "" }, { code: "Y", message: "" }], hint: null },
    ]);
    expect(s.ok).toBe(false);
    expect(s.failed).toEqual(["a", "b"]);
    expect(s.reasonCodes).toEqual(["X", "Y"]);
  });

  it("returns ok:true for an empty array", () => {
    expect(summarizeGates([])).toMatchObject({ ok: true, passed: [], failed: [] });
  });

  it("keeps counts consistent", () => {
    const s = summarizeGates([
      { ok: true, gate: "a", reasons: [], hint: null },
      { ok: false, gate: "b", reasons: [{ code: "Z", message: "" }], hint: null },
    ]);
    expect(s.count).toEqual({ total: 2, passed: 1, failed: 1 });
  });
});

describe("module purity", () => {
  it("pr-gates.mjs performs no I/O", () => {
    const src = readFileSync(resolve(HERE, "..", "src", "pr-gates.mjs"), "utf8");
    expect(src).not.toMatch(/node:child_process|node:fs|node:os|node:process/);
  });
});
