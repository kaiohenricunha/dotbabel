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

  it("declares the conductor-only flags each phase must be invoked with", () => {
    // The flag decides whether phase 1 runs a full security review or a
    // secrets scan, and whether phase 4 defers the test plan. Leaving it in
    // prose alone means dropping it silently changes behaviour, so it lives
    // here and the bats contract diffs the prose against it.
    const flags = Object.fromEntries(CONDUCTOR_PHASES.map((p) => [p.id, p.conductorFlags]));
    expect(flags["pre-pr"]).toEqual(["--conductor"]);
    expect(flags["review-pr"]).toEqual(["--conductor"]);
    expect(flags["open-pr"]).toEqual([]);
    expect(flags["post-pr-review"]).toEqual([]);
    expect(flags["local-attest"]).toEqual([]);
    expect(flags["stop"]).toEqual([]);
  });

  it("freezes every conductorFlags array", () => {
    for (const phase of CONDUCTOR_PHASES) {
      expect(Array.isArray(phase.conductorFlags)).toBe(true);
      expect(Object.isFrozen(phase.conductorFlags)).toBe(true);
    }
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

  describe("deferred test plan", () => {
    // `/review-pr --conductor` does not execute test-plan items; the
    // conductor's local-attest phase does. Before this reason existed the
    // handoff was a prose promise: "plan present, nothing run" and "plan
    // present, everything passed" were identical to every downstream gate.
    const DEFERRED = `${GOOD_BODY}\n<!-- test-plan: deferred -->\n`;

    it("blocks a merge while the deferral marker is still in the body", () => {
      expect(codes(checkMergeGate({ ...base, body: DEFERRED }))).toContain("DEFERRED_TEST_PLAN");
    });

    it("passes once the marker is cleared", () => {
      expect(checkMergeGate({ ...base, body: GOOD_BODY }).ok).toBe(true);
    });

    it("tolerates whitespace variance in the marker", () => {
      const spaced = `${GOOD_BODY}\n<!--   test-plan:deferred   -->\n`;
      expect(codes(checkMergeGate({ ...base, body: spaced }))).toContain("DEFERRED_TEST_PLAN");
    });

    it("ignores a marker inside a fenced block, which only documents it", () => {
      const documented = `${GOOD_BODY}\n\`\`\`\n<!-- test-plan: deferred -->\n\`\`\`\n`;
      expect(codes(checkMergeGate({ ...base, body: documented }))).not.toContain(
        "DEFERRED_TEST_PLAN",
      );
    });
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

  it("reports a mid-body marker as effective — GitHub matches it anywhere", () => {
    // Measured, not assumed. On PR #299 a commit whose message mentioned the
    // marker on its second-to-last line, in a sentence saying the commit was
    // NOT skipping CI, skipped every workflow. Re-pushing the identical tree
    // with the token absent from the message ran all 29 checks. `location`
    // still records where it sat, but placement does not change the outcome.
    const r = hasSkipCi("chore: wip\n\n[skip ci] noted here\n\nmore body");
    expect(r).toMatchObject({ present: true, location: "body", effective: true });
  });

  it("treats a marker mentioned in prose as effective, because GitHub does", () => {
    // The trap this cost us: prose that merely names the token still skips.
    // Never write it in a commit message unless you mean it.
    const r = hasSkipCi("ci: explain the policy\n\nNo [skip ci] here: we want CI.\n\ntrailing line");
    expect(r.effective).toBe(true);
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

// --- P-B3: criteria evidence in the merge gate (§5) -------------------------
//
// Every input below is optional, so the cases above (which pass none of them)
// pin the back-compat promise: a caller that knows nothing about criteria gets
// the pre-P-B3 verdict.

const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);

/** Build an evidence comment body for a payload, the way the command writes it. */
function evidenceBody(sha, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return [
    `<!-- dotbabel-criteria verified-sha=${sha} -->`,
    `<!-- dotbabel-criteria-payload ${encoded} -->`,
    "### Acceptance criteria evidence",
  ].join("\n");
}

function payloadFor(specs, verdict = "pass", extra = {}) {
  return {
    schema_version: 1,
    tool: { name: "dotbabel", version: "3.4.0" },
    head_sha: HEAD,
    generated_at: "2026-01-01T00:00:00.000Z",
    verdict,
    specs: Object.entries(specs).map(([id, criteria]) => ({
      id,
      criteria: criteria.map((c) => (typeof c === "string" ? { id: c, status: "pass" } : c)),
    })),
    ...extra,
  };
}

function comment(body, over = {}) {
  return { body, authorAssociation: "OWNER", authorLogin: "owner", lastEditedAt: null, ...over };
}

/** A gate input with criteria wired up and everything else already passing. */
function criteriaInput(over = {}) {
  return {
    body: `${GOOD_BODY}\n## Spec ID\n\nalpha\n`,
    headRefOid: HEAD,
    requiredCriteria: { alpha: ["AC-1"] },
    comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })))],
    ...over,
  };
}

describe("checkMergeGate — criteria evidence", () => {
  it("fails with CRITERIA_EVIDENCE_MISSING when the spec declares criteria and no evidence exists", () => {
    const r = checkMergeGate(criteriaInput({ comments: [comment("just a normal comment")] }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_MISSING");
    expect(r.ok).toBe(false);
  });

  it("fails with CRITERIA_EVIDENCE_UNTRUSTED when only an untrusted author posted the marker", () => {
    const r = checkMergeGate(
      criteriaInput({
        comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })), { authorAssociation: "CONTRIBUTOR" })],
      }),
    );
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_UNTRUSTED");
  });

  it("fails with CRITERIA_EVIDENCE_UNTRUSTED when an untrusted user edited a trusted marker comment", () => {
    const r = checkMergeGate(
      criteriaInput({
        comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })), { lastEditedAt: "2026-01-02T00:00:00Z" })],
      }),
    );
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_UNTRUSTED");
  });

  it("accepts any trusted unedited marker whose SHA equals the head SHA", () => {
    const r = checkMergeGate(criteriaInput());
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fails with CRITERIA_EVIDENCE_STALE when evidence is pinned to an older commit", () => {
    const r = checkMergeGate(
      criteriaInput({ comments: [comment(evidenceBody(OLDER, payloadFor({ alpha: ["AC-1"] }, "pass", { head_sha: OLDER })))] }),
    );
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_STALE");
  });

  it("fails closed with CRITERIA_EVIDENCE_INVALID when the payload does not decode", () => {
    const body = [`<!-- dotbabel-criteria verified-sha=${HEAD} -->`, `<!-- dotbabel-criteria-payload !!!not-base64!!! -->`].join("\n");
    const r = checkMergeGate(criteriaInput({ comments: [comment(body)] }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_INVALID");
  });

  it("fails closed with CRITERIA_EVIDENCE_INVALID when the payload fails the evidence schema", () => {
    const bad = { ...payloadFor({ alpha: ["AC-1"] }), schema_version: 99 };
    const r = checkMergeGate(criteriaInput({ comments: [comment(evidenceBody(HEAD, bad))] }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_INVALID");
  });

  it("fails closed with CRITERIA_EVIDENCE_INVALID when payload head_sha differs from the marker SHA", () => {
    // The marker is what the gate greps; the payload is what it believes.
    // Letting them disagree would let a trusted marker vouch for other results.
    const mismatched = payloadFor({ alpha: ["AC-1"] }, "pass", { head_sha: OLDER });
    const r = checkMergeGate(criteriaInput({ comments: [comment(evidenceBody(HEAD, mismatched))] }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_INVALID");
  });

  it("fails with CRITERIA_EVIDENCE_INCOMPLETE when a linked spec is missing from the payload", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: ["AC-1"], beta: ["AC-2"] } }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_INCOMPLETE");
  });

  it("treats a pending criterion as uncovered, not as evidence", () => {
    const pendingOnly = payloadFor({ alpha: [{ id: "AC-1", status: "pending" }] });
    const r = checkMergeGate(criteriaInput({ comments: [comment(evidenceBody(HEAD, pendingOnly))] }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_INCOMPLETE");
  });

  it("fails with CRITERIA_FAILED when the payload verdict is fail", () => {
    const r = checkMergeGate(
      criteriaInput({ comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] }, "fail")))] }),
    );
    expect(codes(r)).toContain("CRITERIA_FAILED");
  });

  it("fails with CRITERIA_SPEC_UNKNOWN when a Spec ID names no spec at the head", () => {
    const r = checkMergeGate(criteriaInput({ unknownSpecIds: ["ghost-spec"] }));
    expect(codes(r)).toContain("CRITERIA_SPEC_UNKNOWN");
    expect(r.reasons.find((x) => x.code === "CRITERIA_SPEC_UNKNOWN").detail).toContain("ghost-spec");
  });

  it("fails with CRITERIA_WEAKENED when an active base criterion is planned or missing at the head", () => {
    const r = checkMergeGate(
      criteriaInput({ requiredCriteria: { alpha: ["AC-1"] }, baseActiveCriteria: { alpha: ["AC-1", "AC-2"] } }),
    );
    expect(codes(r)).toContain("CRITERIA_WEAKENED");
    expect(r.reasons.find((x) => x.code === "CRITERIA_WEAKENED").detail).toContain("alpha/AC-2");
  });

  it("reports CRITERIA_WEAKENED as a warning when the body has a Criteria change rationale section", () => {
    const r = checkMergeGate(
      criteriaInput({
        baseActiveCriteria: { alpha: ["AC-1", "AC-2"] },
        criteriaChangeRationale: true,
      }),
    );
    // A warning must not block: the code leaves `reasons` entirely, or the
    // rationale would be a label on a PR that still cannot merge.
    expect(codes(r)).not.toContain("CRITERIA_WEAKENED");
    expect(r.warnings.map((w) => w.code)).toContain("CRITERIA_WEAKENED");
    expect(r.ok).toBe(true);
  });

  it("fails closed with CRITERIA_EVIDENCE_INVALID when the comment list is unreadable", () => {
    // REL-3: a `gh` failure must never read as "no marker comment exists".
    const r = checkMergeGate(criteriaInput({ comments: null }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_INVALID");
    expect(codes(r)).not.toContain("CRITERIA_EVIDENCE_MISSING");
  });

  it("fails with CRITERIA_CI_CHECK_FAILED when require_ci_check is true and the check is not successful", () => {
    const r = checkMergeGate(criteriaInput({ requireCiCheck: true, ciCriteriaCheck: "failure" }));
    expect(codes(r)).toContain("CRITERIA_CI_CHECK_FAILED");
    const ok = checkMergeGate(criteriaInput({ requireCiCheck: true, ciCriteriaCheck: "success" }));
    expect(codes(ok)).not.toContain("CRITERIA_CI_CHECK_FAILED");
  });

  it("moves criteria reasons to warnings when enforcement is warn", () => {
    const blocking = checkMergeGate(criteriaInput({ comments: [comment("nothing here")] }));
    expect(blocking.ok).toBe(false);

    const warned = checkMergeGate(criteriaInput({ comments: [comment("nothing here")], criteriaEnforcement: "warn" }));
    expect(warned.ok).toBe(true);
    expect(warned.reasons).toEqual([]);
    expect(warned.warnings.map((w) => w.code)).toContain("CRITERIA_EVIDENCE_MISSING");
  });

  it("ignores comments when no linked spec declares an active criterion", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: {}, comments: [comment("nothing here")] }));
    expect(codes(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("keeps warnings empty and the verdict unchanged when no criteria inputs are passed", () => {
    const r = checkMergeGate({ body: GOOD_BODY });
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
