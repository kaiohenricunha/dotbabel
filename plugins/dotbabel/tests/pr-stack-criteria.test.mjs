/**
 * P-B3 — the criteria half of the merge gate's input.
 *
 * `checkMergeGate` is pure, so these tests cover the part that is not: which
 * ref each fact is read from, what happens when `gh` fails, and whether the
 * comment fetch stays cheap on a long thread. A stubbed `sh` records every
 * command, which is how the base-ref rule is asserted — the security property
 * is the ref each read names, and only the command string shows it.
 */
import { describe, it, expect } from "vitest";
import { criteriaGateInputs } from "../src/criteria/gate-inputs.mjs";
import { checkMergeGate } from "../src/pr-gates.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const SPEC_AT_HEAD = JSON.stringify({
  acceptance_criteria: [
    { id: "AC-1", status: "active" },
    { id: "AC-2", status: "planned" },
  ],
});

const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
const err = (stderr = "boom") => ({ status: 1, stdout: "", stderr });

/**
 * A `deps.sh` stub driven by an ordered [pattern, reply] table, recording every
 * command it is asked to run. An unmatched command is a test bug, not a
 * silently empty result, so it throws.
 */
function stubSh(replies) {
  const calls = [];
  const sh = (cmd) => {
    calls.push(cmd);
    for (const [re, reply] of replies) {
      if (re.test(cmd)) return typeof reply === "function" ? reply(cmd) : reply;
    }
    throw new Error(`unstubbed command: ${cmd}`);
  };
  return { deps: { sh }, calls };
}

/** One GraphQL page of `count` comments, chained to `next` when given. */
function commentPage(count, { after = null, hasNextPage = false, cursor = "c1" } = {}) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          comments: {
            pageInfo: { hasNextPage, endCursor: cursor },
            nodes: Array.from({ length: count }, (_, i) => ({
              body: `comment ${after ?? "p0"}-${i}`,
              authorAssociation: "CONTRIBUTOR",
              lastEditedAt: null,
              author: { login: "someone" },
            })),
          },
        },
      },
    },
  });
}

const VIEW = {
  body: "## Summary\n\nx\n\n## Test plan\n\n- [x] y\n\n## Spec ID\n\nalpha\n",
  headRefOid: HEAD,
  baseRefOid: BASE,
};

describe("criteriaGateInputs", () => {
  it("reads the criteria configuration from the base ref, not the pull request head", () => {
    const { deps, calls } = stubSh([
      [/git show .*:docs\/specs\/alpha\/spec\.json/, ok(SPEC_AT_HEAD)],
      [new RegExp(`git show ${BASE}:\\.dotbabel\\.json`), ok(JSON.stringify({ criteria: { enforcement: "warn" } }))],
      [new RegExp(`git show ${HEAD}:\\.dotbabel\\.json`), ok(JSON.stringify({ criteria: { enforcement: "block" } }))],
      [/gh api graphql/, ok(commentPage(0))],
    ]);

    const out = criteriaGateInputs(deps, VIEW, 42);

    // The base ref's setting wins, and the head's is never even read: a PR
    // that flips enforcement to "warn" in its own branch must not be judged
    // by that edit (KD-14).
    expect(out.criteriaEnforcement).toBe("warn");
    expect(calls).toContain(`git show ${BASE}:.dotbabel.json`);
    expect(calls.some((c) => c === `git show ${HEAD}:.dotbabel.json`)).toBe(false);

    // Specs, by contrast, are read at BOTH refs: the head supplies what must
    // be proven, the base supplies what may not be quietly dropped.
    expect(calls).toContain(`git show ${HEAD}:docs/specs/alpha/spec.json`);
    expect(calls).toContain(`git show ${BASE}:docs/specs/alpha/spec.json`);
    expect(out.requiredCriteria).toEqual({ alpha: ["AC-1"] });
  });

  it("fails the gate when the comment fetch errors", () => {
    const { deps } = stubSh([
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, err("HTTP 502")],
    ]);

    const out = criteriaGateInputs(deps, VIEW, 42);
    // null, not [] — REL-3 draws exactly this distinction, and the gate turns
    // it into a failing reason rather than "no evidence comment exists".
    expect(out.comments).toBeNull();

    const gate = checkMergeGate({ ...VIEW, ...out });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.map((r) => r.code)).toContain("CRITERIA_EVIDENCE_INVALID");
  });

  it("returns null rather than a truncated list when a GraphQL error arrives with HTTP 200", () => {
    const { deps } = stubSh([
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(JSON.stringify({ data: { repository: null }, errors: [{ message: "NOT_FOUND" }] }))],
    ]);
    expect(criteriaGateInputs(deps, VIEW, 42).comments).toBeNull();
  });

  it("gates a pull request with 300 stubbed comments across several pages within 10 seconds", () => {
    let page = 0;
    const { deps, calls } = stubSh([
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [
        /gh api graphql/,
        () => {
          page += 1;
          return ok(commentPage(100, { after: `p${page}`, hasNextPage: page < 3, cursor: `cursor-${page}` }));
        },
      ],
    ]);

    const started = Date.now();
    const out = criteriaGateInputs(deps, VIEW, 42);
    const gate = checkMergeGate({ ...VIEW, ...out });
    const elapsed = Date.now() - started;

    expect(out.comments).toHaveLength(300);
    expect(elapsed).toBeLessThan(10_000);

    // Three pages, and each after the first carries the previous endCursor —
    // a cursor that never advances would loop on page 1 and still return 300.
    const graphql = calls.filter((c) => c.startsWith("gh api graphql"));
    expect(graphql).toHaveLength(3);
    expect(graphql[1]).toContain('-f cursor="cursor-1"');
    expect(graphql[2]).toContain('-f cursor="cursor-2"');

    // None of the 300 carries the marker, so the gate blocks on missing
    // evidence rather than passing a PR whose proof was never posted.
    expect(gate.reasons.map((r) => r.code)).toContain("CRITERIA_EVIDENCE_MISSING");
  });

  it("returns no criteria inputs at all when the body declares no Spec ID", () => {
    // Back-compat: `{}` leaves checkMergeGate on its pre-criteria behaviour,
    // and nothing is shelled out for a repository that never adopted criteria.
    const { deps, calls } = stubSh([]);
    expect(criteriaGateInputs(deps, { ...VIEW, body: "## Summary\n\nx\n" }, 42)).toEqual({});
    expect(calls).toEqual([]);
  });

  it("reports a Spec ID with no spec at the head as unknown, and skips the check run unless required", () => {
    const { deps, calls } = stubSh([
      [new RegExp(`git show ${HEAD}:docs/specs/alpha/spec\\.json`), err("path does not exist")],
      [new RegExp(`git show ${BASE}:docs/specs/alpha/spec\\.json`), ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(commentPage(0))],
    ]);

    const out = criteriaGateInputs(deps, VIEW, 42);
    expect(out.unknownSpecIds).toEqual(["alpha"]);
    expect(out.requiredCriteria).toEqual({});
    expect(out.baseActiveCriteria).toEqual({ alpha: ["AC-1"] });
    // require_ci_check defaults to false, so the check-run lookup is not paid for.
    expect(out.ciCriteriaCheck).toBeNull();
    expect(calls.some((c) => c.includes("check-runs"))).toBe(false);
  });

  it("reads the check run on the head SHA and takes the newest run of that name", () => {
    const { deps, calls } = stubSh([
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok(JSON.stringify({ criteria: { require_ci_check: true } }))],
      [/gh api graphql/, ok(commentPage(0))],
      [
        /check-runs/,
        ok(
          JSON.stringify({
            check_runs: [
              { name: "dotbabel criteria", conclusion: "failure" },
              { name: "other", conclusion: "success" },
              { name: "dotbabel criteria", conclusion: "success" },
            ],
          }),
        ),
      ],
    ]);

    const out = criteriaGateInputs(deps, VIEW, 42);
    expect(out.requireCiCheck).toBe(true);
    expect(out.ciCriteriaCheck).toBe("success");
    expect(calls.some((c) => c.includes(`commits/${HEAD}/check-runs`))).toBe(true);
    // `--paginate` on this object endpoint emits one JSON object per page,
    // which JSON.parse rejects — the lookup would then always answer null.
    expect(calls.some((c) => c.includes("--paginate"))).toBe(false);
  });

  it("detects the Criteria change rationale heading in the body", () => {
    const { deps } = stubSh([
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(commentPage(0))],
    ]);
    const body = `${VIEW.body}\n## Criteria change rationale\n\nAC-2 moved to planned.\n`;
    expect(criteriaGateInputs(deps, { ...VIEW, body }, 42).criteriaChangeRationale).toBe(true);
    expect(criteriaGateInputs(deps, VIEW, 42).criteriaChangeRationale).toBe(false);
  });
});
