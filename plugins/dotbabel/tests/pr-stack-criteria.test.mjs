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
 * A `deps.run` stub driven by an ordered [pattern, reply] table, recording
 * every ARGV ARRAY it is asked to run. An unmatched command is a test bug, not
 * a silently empty result, so it throws.
 *
 * `calls` holds the argv arrays; `joined` holds them flattened for pattern
 * matching only. Assertions about injection must read `calls`, because that is
 * where the argument boundaries live — the whole security property is that a
 * metacharacter stays inside one argv entry instead of becoming syntax.
 */
function stubSh(replies) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    const joined = argv.join(" ");
    for (const [re, reply] of replies) {
      if (re.test(joined)) return typeof reply === "function" ? reply(argv) : reply;
    }
    throw new Error(`unstubbed command: ${joined}`);
  };
  return { deps: { run }, calls, joined: () => calls.map((a) => a.join(" ")) };
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
    const { deps, calls, joined } = stubSh([
      [/git cat-file -e/, ok("")],
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
    expect(joined()).toContain(`git show ${BASE}:.dotbabel.json`);
    expect(joined().some((c) => c === `git show ${HEAD}:.dotbabel.json`)).toBe(false);

    // Specs, by contrast, are read at BOTH refs: the head supplies what must
    // be proven, the base supplies what may not be quietly dropped.
    expect(joined()).toContain(`git show ${HEAD}:docs/specs/alpha/spec.json`);
    expect(joined()).toContain(`git show ${BASE}:docs/specs/alpha/spec.json`);
    expect(out.requiredCriteria).toEqual({ alpha: ["AC-1"] });
  });

  it("fails the gate when the comment fetch errors", () => {
    const { deps } = stubSh([
      [/git cat-file -e/, ok("")],
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
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(JSON.stringify({ data: { repository: null }, errors: [{ message: "NOT_FOUND" }] }))],
    ]);
    expect(criteriaGateInputs(deps, VIEW, 42).comments).toBeNull();
  });

  it("gates a pull request with 300 stubbed comments across several pages within 10 seconds", () => {
    let page = 0;
    const { deps, calls, joined } = stubSh([
      [/git cat-file -e/, ok("")],
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
    const graphql = joined().filter((c) => c.startsWith("gh api graphql"));
    expect(graphql).toHaveLength(3);
    expect(graphql[1]).toContain("cursor=cursor-1");
    expect(graphql[2]).toContain("cursor=cursor-2");

    // None of the 300 carries the marker, so the gate blocks on missing
    // evidence rather than passing a PR whose proof was never posted.
    expect(gate.reasons.map((r) => r.code)).toContain("CRITERIA_EVIDENCE_MISSING");
  });

  it("never lets a Spec ID from the body reach a shell", () => {
    // Regression, and the most serious defect this unit had. `deps.run` was
    // once `deps.sh`, a string run with shell:true, and the spec id is raw
    // pull-request-body text. A body whose `## Spec ID` section read
    // `alpha;touch${IFS}/tmp/pwned;` executed on the machine of whoever ran
    // the merge gate — remote code execution from an unprivileged pull
    // request. Two independent properties keep it shut, and both are asserted:
    // the id is rejected before use, and nothing is built as a shell string.
    const { deps, calls } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(commentPage(0))],
    ]);
    const evil = "alpha;touch${IFS}/tmp/pwned;";
    const body = `## Summary\n\nx\n\n## Spec ID\n\n${evil}\n`;

    const out = criteriaGateInputs(deps, { ...VIEW, body }, 42);

    // Rejected as a spec id, so it blocks the merge instead of running.
    expect(out.unknownSpecIds).toEqual([evil]);
    expect(checkMergeGate({ ...VIEW, body, ...out }).reasons.map((r) => r.code)).toContain("CRITERIA_SPEC_UNKNOWN");
    // And it never reached a command at all.
    expect(calls.some((argv) => argv.some((a) => a.includes(evil)))).toBe(false);
  });

  it("passes every command as an argv array, never as a shell string", () => {
    // The structural half of the fix: even a value that passes SPEC_ID_RE must
    // not be able to become shell syntax, so `run` receives arrays and the bin
    // spawns them with shell:false.
    const { deps, calls } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(commentPage(0))],
    ]);
    criteriaGateInputs(deps, VIEW, 42);

    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(Array.isArray(argv)).toBe(true);
      expect(["git", "gh"]).toContain(argv[0]);
    }
    // The GraphQL query keeps its sigils verbatim: as an argv entry no shell
    // ever sees it, so it needs no quoting and gets no expansion.
    const query = calls.flat().find((a) => a.startsWith("query="));
    expect(query).toContain("$owner");
    expect(query).toContain("$cursor");
  });

  it("rejects a path-shaped Spec ID rather than reading outside docs/specs", () => {
    const { deps, calls } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(commentPage(0))],
    ]);
    const body = "## Summary\n\nx\n\n## Spec ID\n\n../../../../etc/passwd\n";
    const out = criteriaGateInputs(deps, { ...VIEW, body }, 42);
    expect(out.unknownSpecIds).toEqual(["../../../../etc/passwd"]);
    expect(calls.some((argv) => argv.some((a) => a.includes("passwd")))).toBe(false);
  });

  it("fails closed when the base commit is not in this clone", () => {
    // A shallow checkout or an un-fetched base made every base read fail, which
    // used to look identical to "the base has no such file": baseActiveCriteria
    // went empty so weakening stopped being visible, and require_ci_check fell
    // back to its default of false. Both are fail-open, which REL-3 forbids.
    const { deps } = stubSh([[/git cat-file -e/, err("not a valid object name")]]);
    const out = criteriaGateInputs(deps, VIEW, 42);
    expect(out.criteriaBaseUnreadable).toBe(BASE);

    const gate = checkMergeGate({ ...VIEW, ...out });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.map((r) => r.code)).toContain("CRITERIA_BASE_UNREADABLE");
  });

  it("returns no criteria inputs at all when the body declares no Spec ID", () => {
    // Back-compat: `{}` leaves checkMergeGate on its pre-criteria behaviour,
    // and nothing is shelled out for a repository that never adopted criteria.
    const { deps, calls } = stubSh([]);
    expect(criteriaGateInputs(deps, { ...VIEW, body: "## Summary\n\nx\n" }, 42)).toEqual({});
    expect(calls).toEqual([]);
  });

  it("reports a Spec ID with no spec at the head as unknown, and skips the check run unless required", () => {
    const { deps, calls, joined } = stubSh([
      [/git cat-file -e/, ok("")],
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
    expect(joined().some((c) => c.includes("check-runs"))).toBe(false);
  });

  it("reads the check run on the head SHA and takes the newest run of that name", () => {
    const { deps, calls, joined } = stubSh([
      [/git cat-file -e/, ok("")],
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
    expect(joined().some((c) => c.includes(`commits/${HEAD}/check-runs`))).toBe(true);
    // `--paginate` on this object endpoint emits one JSON object per page,
    // which JSON.parse rejects — the lookup would then always answer null.
    expect(joined().some((c) => c.includes("--paginate"))).toBe(false);
  });

  // The branches below are the fail-closed ones: each turns a broken read into
  // "cannot judge" rather than into a quiet pass. They are unreachable from the
  // happy path, so nothing else exercises them.

  it("treats an unparseable spec.json as an absent spec rather than throwing", () => {
    const { deps } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok("{ not json")],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(commentPage(0))],
    ]);
    const out = criteriaGateInputs(deps, VIEW, 42);
    expect(out.unknownSpecIds).toEqual(["alpha"]);
    expect(checkMergeGate({ ...VIEW, ...out }).reasons.map((r) => r.code)).toContain("CRITERIA_SPEC_UNKNOWN");
  });

  it("returns null when a comment page is not JSON", () => {
    const { deps } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok("<html>502 Bad Gateway</html>")],
    ]);
    expect(criteriaGateInputs(deps, VIEW, 42).comments).toBeNull();
  });

  it("returns null rather than a truncated list when the page cap is reached", () => {
    // Every page claims another follows, so the fetch can never complete.
    let page = 0;
    const { deps, calls, joined } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [
        /gh api graphql/,
        () => {
          page += 1;
          return ok(commentPage(1, { hasNextPage: true, cursor: `cursor-${page}` }));
        },
      ],
    ]);
    expect(criteriaGateInputs(deps, VIEW, 42).comments).toBeNull();
    // Bounded: it stops rather than paging forever.
    expect(joined().filter((c) => c.startsWith("gh api graphql"))).toHaveLength(100);
  });

  it("answers null for the check run when the check-runs response is not JSON", () => {
    const { deps } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok(JSON.stringify({ criteria: { require_ci_check: true } }))],
      [/gh api graphql/, ok(commentPage(0))],
      [/check-runs/, ok("not json")],
    ]);
    const out = criteriaGateInputs(deps, VIEW, 42);
    expect(out.ciCriteriaCheck).toBeNull();
    // null is not "success", so require_ci_check still blocks.
    expect(checkMergeGate({ ...VIEW, ...out }).reasons.map((r) => r.code)).toContain("CRITERIA_CI_CHECK_FAILED");
  });

  it("answers null for the check run when the lookup itself fails", () => {
    const { deps } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok(JSON.stringify({ criteria: { require_ci_check: true } }))],
      [/gh api graphql/, ok(commentPage(0))],
      [/check-runs/, err("HTTP 404")],
    ]);
    expect(criteriaGateInputs(deps, VIEW, 42).ciCriteriaCheck).toBeNull();
  });

  it("answers null when no check run carries the criteria name", () => {
    const { deps } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok(JSON.stringify({ criteria: { require_ci_check: true } }))],
      [/gh api graphql/, ok(commentPage(0))],
      [/check-runs/, ok(JSON.stringify({ check_runs: [{ name: "other", conclusion: "success" }] }))],
    ]);
    expect(criteriaGateInputs(deps, VIEW, 42).ciCriteriaCheck).toBeNull();
  });

  it("falls back to configuration defaults when the base ref has no .dotbabel.json", () => {
    const { deps } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, err("does not exist")],
      [/gh api graphql/, ok(commentPage(0))],
    ]);
    const out = criteriaGateInputs(deps, VIEW, 42);
    expect(out.criteriaEnforcement).toBe("block");
    expect(out.trustedAssociations).toEqual(["OWNER"]);
  });

  it("returns no criteria inputs when the pull request has no ref information", () => {
    const { deps, calls } = stubSh([]);
    expect(criteriaGateInputs(deps, { ...VIEW, headRefOid: "" }, 42)).toEqual({});
    expect(criteriaGateInputs(deps, { ...VIEW, baseRefOid: undefined }, 42)).toEqual({});
    expect(calls).toEqual([]);
  });

  it("detects the Criteria change rationale heading in the body", () => {
    const { deps } = stubSh([
      [/git cat-file -e/, ok("")],
      [/git show .*spec\.json/, ok(SPEC_AT_HEAD)],
      [/git show .*\.dotbabel\.json/, ok("{}")],
      [/gh api graphql/, ok(commentPage(0))],
    ]);
    const body = `${VIEW.body}\n## Criteria change rationale\n\nAC-2 moved to planned.\n`;
    expect(criteriaGateInputs(deps, { ...VIEW, body }, 42).criteriaChangeRationale).toBe(true);
    expect(criteriaGateInputs(deps, VIEW, 42).criteriaChangeRationale).toBe(false);
  });
});
