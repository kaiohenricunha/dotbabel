// Additive boundary tests for `pr-gates.mjs`, closing the gap between the
// extensive existing pr-gates.test.mjs and the TEST-1 mutation-score floor
// (baseline 81.57%, 955 mutants — the largest single file in the grind).
// Fixture helpers mirror pr-gates.test.mjs's own conventions but are
// self-contained here, matching this session's established pattern of one
// additive, standalone `*-behavior.test.mjs` per module.
//
// A handful of mutants are documented as genuinely equivalent rather than
// chased, each confirmed by tracing the actual code path:
//   - 894:44-64 (`commitMessage === ""` forced false, in `hasSkipCi`): with
//     `commitMessage === ""`, `"".split("\n")` still yields `[""]`, and every
//     later check on that single empty line fails to match anything, so the
//     function falls through to the same `absent` result it would have
//     returned early — the early return only saves work, not behavior.
//   - 897:31-33 and 906:38-40 (`lines[0] ?? ""` and `lines[lastIdx] ?? ""`):
//     `String.prototype.split` always returns at least one element, and
//     `lastIdx` is only ever a valid index into `lines`, so neither `??`
//     fallback can ever fire.
//   - 905:10-21 (`lastIdx > 0` -> `lastIdx >= 0`, in `hasSkipCi`'s trailing-
//     blank-line walk): the extra step past index 0 only happens when
//     `lines[0]` is ALSO blank, and in that case the walk-back stops at
//     `lines[lastIdx] ?? ""` = `""` either way — at index 0 directly (real)
//     or at index -1 via the `??` fallback (mutant) — so the two variants
//     always compute the identical `lastLine`. Traced by hand across every
//     case (non-blank line 0 stops both variants identically via the loop's
//     other clause; blank line 0 produces `""` either way).
//   - 229:57-65 and 229:69-77 (`a === ""` and `b === ""` in `shaMatches`'s
//     guard clause, each forced `false`): both are redundant given the
//     `MIN_SHA_PREFIX` (7) check two lines later — an empty string always
//     has length 0, so `short.length < MIN_SHA_PREFIX` already rejects it
//     even with the guard clause disabled.
//   - 233:25-44 (`x.length < y.length` -> `<=`, in `shaMatches`): only
//     changes which of two EQUAL-length strings gets labeled `short` vs
//     `long`. For equal-length strings, `long.startsWith(short)` is true
//     only when they are identical — already handled by the `x === y`
//     check one line above — so relabeling which is which changes nothing
//     observable.
//   - 317:78-80 and 318:80-82 (the `Array.isArray(...) ? ... : []`
//     fallbacks for `changedPaths`/`protectedPaths`, each swapped to a
//     one-element sentinel array): whichever side's fallback fires, the
//     other side's real glob/path list still governs the `.find`/`.some`
//     match, and no realistic glob matches the literal sentinel text.
//   - 406:61-66, 416:19-55, 417:91-93, 419:18-36, 423:11-33 (defaults and
//     fallbacks inside `attestationStatus`): all five are unreachable given
//     the function's own precondition. It is only ever called with
//     `reasons` already computed by `evaluateAttestation`, and it returns
//     early (line 413) whenever `reasons.length > 0`. Every remaining
//     mutant sits on a fallback for a case `evaluateAttestation` itself
//     already validates before it can return an empty reasons list: a
//     non-string `headRefOid` (416) or non-array `attestationComments`
//     (417) would already have produced an `ATTESTATION_INVALID`/
//     `ATTESTATION_MISSING` reason; and `attestationStatus`'s own
//     sha-match filter (418) is a strict subset of the trust+edit+sha
//     filter `evaluateAttestation` already required to pass (so `current.
//     length` (419) can never be 0, and `parsed` (423) can never be null).
//   - 513:91-93 (the `Array.isArray` fallback for `attestationComments`
//     inside `evaluateAttestation` itself): a non-array sentinel iterates
//     the same `c && typeof c.body === "string"` filter as a real value —
//     a bare string element has no `.body`, so it is filtered out either
//     way, same as an empty array would be.
//   - 634:7-26 (`required.length > 0`, the ATTESTATION_INCOMPLETE guard):
//     `required` itself (not just the guard) stays whatever
//     `input.requiredLegs.filter(Boolean)` produced — bypassing the guard
//     still runs `required.filter(...)` on that SAME array, so when it is
//     empty the inner computation is a no-op either way; the guard only
//     matters when `required` is non-empty, and forcing entry when it
//     already would have entered changes nothing.
//   - 684:97-99 (`pathScopedSpecIds`'s `Array.isArray(...) ? ... : []`
//     fallback): only observable if a real spec id happens to equal the
//     literal sentinel text, which `pathScoped.has(specId)` never sees in
//     practice — same reasoning as 317/318.
//   - 743:67-79 (`(n, ids) => n + ids.size` -> `n - ids.size`, inside
//     `requiredTotal`'s reduce): `requiredTotal`'s only use is `===0` two
//     lines later, and every criterion Set has size >= 0 — so any input
//     with at least one non-empty spec makes the sum strictly positive and
//     the running difference strictly negative, and neither equals zero;
//     an all-empty input makes both variants sum to exactly 0. The sign of
//     a non-zero total is never read, only whether it's zero.
//   - 759:54-80 (the `typeof c.body === "string"` clause inside
//     `evaluateCriteria`'s marker-comment filter — and the same clause at
//     418, 515, and 777 for attestation and the earlier criteria filter):
//     `criteriaMarker.parseSha`/`attestMarker.parseSha` each start with
//     their own `typeof body !== "string" -> return null` guard
//     (lib/attest-marker.mjs), so calling them on a non-string body is
//     already safe and already returns null — the outer type check is
//     fully redundant with the callee's own guard.
//   - 863:57-59 and 867:89-91 (the `v ?? []` / `: []` fallbacks inside
//     `toCriteriaMap`, for a Map or plain-object entry whose value isn't a
//     real array): the resulting `Set` only ever gets `.has(realId)`
//     checked against genuine criterion id strings like "AC-1" — a
//     sentinel element never coincidentally matches one.
import { describe, it, expect } from "vitest";
import { checkLocalAttestGate, checkMergeGate, hasSkipCi, summarizeGates } from "../src/pr-gates.mjs";

const GOOD_BODY = "## Summary\n\n- does a thing\n\n## Test plan\n\n- [x] npm test\n";
const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const codes = (result) => result.reasons.map((r) => r.code);

function comment(body, over = {}) {
  return { body, authorAssociation: "OWNER", authorLogin: "owner", lastEditedAt: null, ...over };
}

function evidenceBody(sha, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return [`<!-- dotbabel-criteria verified-sha=${sha} -->`, `<!-- dotbabel-criteria-payload ${encoded} -->`, "### Acceptance criteria evidence"].join("\n");
}

function payloadFor(specs, verdict = "pass", extra = {}) {
  return {
    schema_version: 1,
    tool: { name: "dotbabel", version: "3.4.0" },
    head_sha: HEAD,
    generated_at: "2026-01-01T00:00:00.000Z",
    verdict,
    specs: Object.entries(specs).map(([id, criteria]) => ({ id, criteria: criteria.map((c) => (typeof c === "string" ? { id: c, status: "pass" } : c)) })),
    ...extra,
  };
}

function criteriaInput(over = {}) {
  return {
    body: `${GOOD_BODY}\n## Spec ID\n\nalpha\n`,
    headRefOid: HEAD,
    requiredCriteria: { alpha: ["AC-1"] },
    comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })))],
    ...over,
  };
}

const CONFIG_HASH = `sha256:${"c".repeat(64)}`;
const MERGE_BASE = "d".repeat(40);

function attestPayload(over = {}) {
  return {
    schema_version: 1,
    tool: { name: "dotbabel", version: "4.0.0" },
    head_sha: HEAD,
    generated_at: "2026-01-01T00:00:00.000Z",
    verdict: "pass",
    legs: [
      { name: "test", mode: "hard", status: "pass" },
      { name: "quality", mode: "hard", status: "pass" },
    ],
    merge_base: MERGE_BASE,
    config_hash: CONFIG_HASH,
    ...over,
  };
}

function attestBody(sha, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return [`<!-- local-attest verified-sha=${sha} -->`, `<!-- local-attest-payload ${encoded} -->`, "## Local Attestation"].join("\n");
}

function attestInput(over = {}) {
  return {
    body: GOOD_BODY,
    headRefOid: HEAD,
    attestationEnforced: true,
    attestationComments: [comment(attestBody(HEAD, attestPayload()))],
    expectedConfigHash: CONFIG_HASH,
    expectedMergeBase: MERGE_BASE,
    requiredLegs: ["test", "quality"],
    attestationGovernedTouched: [],
    ...over,
  };
}

describe("hasSkipCi — the skip-checks: true trailer regex", () => {
  it("does not match the trailer text unless it is at the start of the line", () => {
    const result = hasSkipCi(`${GOOD_BODY}\n\nnot the marker skip-checks: true`);
    expect(result.present).toBe(false);
  });

  it("does not match when trailing text follows true", () => {
    const result = hasSkipCi(`${GOOD_BODY}\n\nskip-checks: true please`);
    expect(result.present).toBe(false);
  });

  it("matches any amount of whitespace between the colon and true", () => {
    const result = hasSkipCi(`${GOOD_BODY}\n\nskip-checks:  true`);
    expect(result.present).toBe(true);
    expect(result.location).toBe("trailer");
  });
});

describe("hasSkipCi — trailing blank-line handling", () => {
  it("does not crash when every line, including the first, is blank", () => {
    expect(() => hasSkipCi("\n\n\n")).not.toThrow();
    expect(hasSkipCi("\n\n\n").present).toBe(false);
  });

  it("still finds the trailer past multiple trailing blank lines", () => {
    const result = hasSkipCi("skip-checks: true\n\n\n");
    expect(result.present).toBe(true);
    expect(result.location).toBe("trailer");
  });

  it("treats a whitespace-only trailing line as blank, not as real content", () => {
    const result = hasSkipCi("skip-checks: true\n   \n");
    expect(result.present).toBe(true);
  });

  it("trims the candidate trailer line before matching it", () => {
    const result = hasSkipCi(`${GOOD_BODY}\n\n  skip-checks: true`);
    expect(result.present).toBe(true);
  });

  it("reports present true (not false) for a last-line bracket marker", () => {
    const result = hasSkipCi(`${GOOD_BODY}\n\n[skip ci]`);
    expect(result).toMatchObject({ present: true, location: "last-line" });
  });

  it("reports present true (not false) for the trailer marker specifically", () => {
    const result = hasSkipCi("skip-checks: true");
    expect(result).toMatchObject({ present: true, location: "trailer", marker: "skip-checks: true" });
  });
});

describe("checkMergeGate — protected-path glob matching", () => {
  function globInput(protectedPaths, changedPaths) {
    return { body: `${GOOD_BODY}`, protectedPaths, changedPaths, hasSpecsDir: false };
  }

  it("anchors a bare (no-wildcard) glob to the whole path, not just a suffix", () => {
    const r = checkMergeGate(globInput(["config"], ["myconfig"]));
    expect(codes(r)).not.toContain("MISSING_SPEC_ID");
  });

  it("still requires a Spec ID when a changed path exactly matches a bare glob", () => {
    const r = checkMergeGate(globInput(["config"], ["config"]));
    expect(codes(r)).toContain("MISSING_SPEC_ID");
  });

  it("matches a single * within one path segment", () => {
    const r = checkMergeGate(globInput(["foo*bar"], ["fooXbar"]));
    expect(codes(r)).toContain("MISSING_SPEC_ID");
  });

  it("does not let a single * cross a path segment boundary", () => {
    const r = checkMergeGate(globInput(["foo*bar"], ["foo/bar"]));
    expect(codes(r)).not.toContain("MISSING_SPEC_ID");
  });

  it("lets ** cross path segment boundaries", () => {
    const r = checkMergeGate(globInput(["**/config.json"], ["a/b/config.json"]));
    expect(codes(r)).toContain("MISSING_SPEC_ID");
  });

  it("does not leave a stray literal slash after a **/ prefix", () => {
    // If the redundant "/" right after "**" were not consumed, the compiled
    // pattern would require a literal extra separator that the real path
    // does not have.
    const r = checkMergeGate(globInput(["**/config.json"], ["config.json"]));
    expect(codes(r)).toContain("MISSING_SPEC_ID");
  });

  it("matches a single ? as exactly one character", () => {
    const r = checkMergeGate(globInput(["a?c"], ["abc"]));
    expect(codes(r)).toContain("MISSING_SPEC_ID");
    const miss = checkMergeGate(globInput(["a?c"], ["ac"]));
    expect(codes(miss)).not.toContain("MISSING_SPEC_ID");
  });

  it("requires ALL changed paths against ANY protected glob to be some, not every", () => {
    const r = checkMergeGate(globInput(["config"], ["config", "unrelated.txt"]));
    expect(codes(r)).toContain("MISSING_SPEC_ID");
  });
});

describe("checkLocalAttestGate — sha comparison boundaries", () => {
  const base = { branch: "feature", worktreeStatus: "", prNumber: 7 };

  it("rejects a non-string localHead", () => {
    const r = checkLocalAttestGate({ ...base, localHead: 12345, prHeadOid: HEAD });
    expect(codes(r)).toContain("HEAD_MISMATCH");
  });

  it("rejects a non-string prHeadOid", () => {
    const r = checkLocalAttestGate({ ...base, localHead: HEAD, prHeadOid: 12345 });
    expect(codes(r)).toContain("HEAD_MISMATCH");
  });

  it("rejects an empty-string localHead", () => {
    const r = checkLocalAttestGate({ ...base, localHead: "", prHeadOid: HEAD });
    expect(codes(r)).toContain("HEAD_MISMATCH");
  });

  it("rejects an empty-string prHeadOid", () => {
    const r = checkLocalAttestGate({ ...base, localHead: HEAD, prHeadOid: "" });
    expect(codes(r)).toContain("HEAD_MISMATCH");
  });

  it("accepts two identical short strings, even shorter than the minimum prefix length", () => {
    const r = checkLocalAttestGate({ ...base, localHead: "abc", prHeadOid: "abc" });
    expect(codes(r)).not.toContain("HEAD_MISMATCH");
  });

  it("shows only the first 8 hex characters of each sha in the mismatch message", () => {
    const other = "f".repeat(40);
    const r = checkLocalAttestGate({ ...base, localHead: HEAD, prHeadOid: other });
    const reason = r.reasons.find((x) => x.code === "HEAD_MISMATCH");
    expect(reason.message).toBe(`local HEAD ${HEAD.slice(0, 8)} does not match PR head ${other.slice(0, 8)}`);
  });

  it("shows (none) in the mismatch message when a sha is missing, not the literal text undefined", () => {
    const r = checkLocalAttestGate({ ...base, localHead: undefined, prHeadOid: HEAD });
    const reason = r.reasons.find((x) => x.code === "HEAD_MISMATCH");
    expect(reason.message).toContain("(none)");
  });
});

describe("checkLocalAttestGate — the other reasons and the result shape", () => {
  const passing = { branch: "feature", worktreeStatus: "", prNumber: 7, localHead: HEAD, prHeadOid: HEAD };

  it("reports NO_PR, with its exact message, for undefined (not just null) prNumber", () => {
    const r = checkLocalAttestGate({ ...passing, prNumber: undefined });
    expect(r.reasons.find((x) => x.code === "NO_PR").message).toBe("no open pull request resolved for this branch");
  });

  it("reports DETACHED_HEAD with its exact message", () => {
    const r = checkLocalAttestGate({ ...passing, branch: "HEAD" });
    expect(r.reasons.find((x) => x.code === "DETACHED_HEAD").message).toBe("HEAD is detached; check out the PR branch first");
  });

  it("does not throw when worktreeStatus is not a string at all", () => {
    expect(() => checkLocalAttestGate({ ...passing, worktreeStatus: undefined })).not.toThrow();
    expect(codes(checkLocalAttestGate({ ...passing, worktreeStatus: undefined }))).not.toContain("WORKTREE_DIRTY");
  });

  it("reports WORKTREE_DIRTY with its exact message and a trimmed detail", () => {
    const r = checkLocalAttestGate({ ...passing, worktreeStatus: "  M file.txt  \n" });
    const reason = r.reasons.find((x) => x.code === "WORKTREE_DIRTY");
    expect(reason.message).toBe("working tree has uncommitted changes");
    expect(reason.detail).toBe("M file.txt");
  });

  it("always returns an empty warnings array", () => {
    expect(checkLocalAttestGate(passing).warnings).toEqual([]);
    expect(checkLocalAttestGate({}).warnings).toEqual([]);
  });

  it("returns hint null on success and a real hint string on failure", () => {
    expect(checkLocalAttestGate(passing).hint).toBeNull();
    expect(checkLocalAttestGate({}).hint).toBe("commit or stash your changes and push before attesting");
  });
});

describe("checkMergeGate — body and mergeability reasons", () => {
  it("reports EMPTY_BODY with its exact message", () => {
    const r = checkMergeGate({ body: "" });
    expect(r.reasons.find((x) => x.code === "EMPTY_BODY").message).toBe("PR body is empty");
  });

  it("reports MISSING_SUMMARY with its exact message", () => {
    const r = checkMergeGate({ body: "## Test plan\n\n- [x] x\n" });
    expect(r.reasons.find((x) => x.code === "MISSING_SUMMARY").message).toBe("body must contain an h2 `## Summary` section");
  });

  it("reports MISSING_TEST_PLAN with its exact message", () => {
    const r = checkMergeGate({ body: "## Summary\n\n- x\n" });
    expect(r.reasons.find((x) => x.code === "MISSING_TEST_PLAN").message).toBe("body must contain an h2 `## Test plan` section");
  });

  it("reports DEFERRED_TEST_PLAN with its exact message", () => {
    const r = checkMergeGate({ body: `${GOOD_BODY}\n<!-- test-plan: deferred -->` });
    expect(r.reasons.find((x) => x.code === "DEFERRED_TEST_PLAN").message).toBe("test plan is deferred to local-attest and has not been cleared");
  });

  it("reports MISSING_SPEC_ID with its exact message when the repo has a specs dir", () => {
    const r = checkMergeGate({ body: GOOD_BODY, hasSpecsDir: true });
    expect(r.reasons.find((x) => x.code === "MISSING_SPEC_ID").message).toBe("body must contain `## Spec ID` or `## No-spec rationale`");
  });

  it("carries no detail field at all when the spec requirement came from hasSpecsDir, not a protected-path hit", () => {
    const r = checkMergeGate({ body: GOOD_BODY, hasSpecsDir: true });
    const reason = r.reasons.find((x) => x.code === "MISSING_SPEC_ID");
    expect("detail" in reason).toBe(false);
  });

  it("reports NOT_MERGEABLE with its exact message", () => {
    const r = checkMergeGate({ body: GOOD_BODY, mergeable: "CONFLICTING" });
    expect(r.reasons.find((x) => x.code === "NOT_MERGEABLE").message).toBe("PR has merge conflicts with its base");
  });

  it("reports BEHIND_BASE with its exact message", () => {
    const r = checkMergeGate({ body: GOOD_BODY, mergeStateStatus: "BEHIND" });
    expect(r.reasons.find((x) => x.code === "BEHIND_BASE").message).toBe("branch is behind its base; rebase before merging");
  });

  it("chooses the re-attest hint over the template hint when the failure is attestation-shaped", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [] }));
    expect(r.hint).toBe("re-run `dotbabel local-attest --pr <N>` so the evidence names the current head");
  });

  it("chooses the template hint, not the re-attest hint, for a non-attestation failure", () => {
    const r = checkMergeGate({ body: "" });
    expect(r.hint).toBe("see .github/PULL_REQUEST_TEMPLATE.md for the required sections");
  });

  it("returns hint null only when there are zero reasons", () => {
    const r = checkMergeGate({ body: GOOD_BODY });
    expect(r.reasons).toEqual([]);
    expect(r.hint).toBeNull();
  });
});

describe("checkMergeGate — attestation status field", () => {
  it("reports state off with a null sha, empty legs, and a null code when enforcement is off", () => {
    const r = checkMergeGate({ body: GOOD_BODY });
    expect(r.attestation).toEqual({ state: "off", sha: null, legs: [], code: null });
  });

  it("reports state failed with the FIRST reason's code, not just any code", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [] }));
    expect(r.attestation.state).toBe("failed");
    expect(r.attestation.code).toBe("ATTESTATION_MISSING");
  });

  it("names the exact head sha and the exact passed legs on a verified attestation", () => {
    const r = checkMergeGate(attestInput());
    expect(r.attestation).toEqual({ state: "verified", sha: HEAD, legs: ["test", "quality"], code: null });
  });

  it("matches the attestation comment by its own marker sha, not any comment in the list", () => {
    const r = checkMergeGate(
      attestInput({
        attestationComments: [comment(attestBody(OLDER, attestPayload({ head_sha: OLDER })), { authorAssociation: "CONTRIBUTOR" }), comment(attestBody(HEAD, attestPayload()))],
      }),
    );
    expect(r.attestation.sha).toBe(HEAD);
  });

  it("reads legs from the current-head comment, not from whichever comment happens to be last in the list", () => {
    // The current, matching comment is listed FIRST and a mismatched (older
    // sha) comment LAST — a filter-removal bug that picks the raw list's
    // last entry regardless of sha would report the older comment's legs.
    const r = checkMergeGate(
      attestInput({
        attestationComments: [
          comment(attestBody(HEAD, attestPayload())),
          comment(attestBody(OLDER, attestPayload({ head_sha: OLDER, legs: [{ name: "onlyold", mode: "hard", status: "pass" }] })), { authorAssociation: "CONTRIBUTOR" }),
        ],
      }),
    );
    expect(r.attestation.legs).toEqual(["test", "quality"]);
  });

  it("returns empty legs, not the payload's own leg list, when the attestation state is not ok", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [comment(`<!-- local-attest verified-sha=${HEAD} -->\nno payload line`)] }));
    expect(r.attestation.legs).toEqual([]);
  });
});

describe("checkMergeGate — governed-change detail formatting", () => {
  it("joins every touched governed file into one comma-separated detail string", () => {
    const r = checkMergeGate(attestInput({ attestationGovernedTouched: ["a.json", "b.json", "c.json"] }));
    expect(r.warnings[0].detail).toBe("a.json, b.json, c.json");
  });

  it("marks a governed-change warning explicitly as a warning, not a silent flag", () => {
    const r = checkMergeGate(attestInput({ attestationGovernedTouched: ["a.json"] }));
    expect(r.warnings[0].warning).toBe(true);
  });
});

describe("checkMergeGate — attestation evidence ladder messages", () => {
  it("reports ATTESTATION_INVALID with its exact message when the head sha cannot be read", () => {
    const r = checkMergeGate(attestInput({ headRefOid: undefined }));
    expect(r.reasons.find((x) => x.code === "ATTESTATION_INVALID").message).toBe("the pull request head SHA could not be read, so no evidence can be matched to it");
  });

  it("reports ATTESTATION_BASE_UNREADABLE with the sha sliced to 8 characters in the detail", () => {
    const r = checkMergeGate(attestInput({ attestationBaseUnreadable: "f".repeat(40) }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_BASE_UNREADABLE");
    expect(reason.message).toBe("the base commit is not in this clone, so the attestation policy could not be read");
    expect(reason.detail).toBe(`fetch ${"f".repeat(8)} and re-run`);
  });

  it("reports ATTESTATION_INVALID, with its own detail, when the comment list is unreadable", () => {
    const r = checkMergeGate(attestInput({ attestationComments: null }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_INVALID");
    expect(reason.detail).toBe("comment fetch failed");
  });

  it("only counts a comment as a marker comment when it has a body and a real marker sha", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [{ authorAssociation: "OWNER" }, comment("plain text, no marker")] }));
    expect(codes(r)).toContain("ATTESTATION_MISSING");
  });

  it("reports ATTESTATION_STALE listing every distinct attested sha, sliced to 8 characters", () => {
    const other = "f".repeat(40);
    const r = checkMergeGate(
      attestInput({
        attestationComments: [comment(attestBody(other, attestPayload({ head_sha: other })))],
      }),
    );
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_STALE");
    expect(reason.detail).toBe(`attested ${other.slice(0, 8)}; current ${HEAD.slice(0, 8)}`);
  });

  it("uses the exact current head sha, not a stale one, when matching the trusted comment", () => {
    const r = checkMergeGate(attestInput());
    expect(r.ok).toBe(true);
  });

  it("reports ATTESTATION_INVALID with its own detail when the payload has no data at all", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [comment(`<!-- local-attest verified-sha=${HEAD} -->`)] }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_INVALID");
    expect(reason.detail).toBe("it was written by a dotbabel version that predates the payload; re-run local-attest");
  });

  it("falls back to the parsed state itself as the detail when neither ok nor no-payload", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [comment(`<!-- local-attest verified-sha=${HEAD} -->\n<!-- local-attest-payload not-valid-base64!! -->`)] }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_INVALID");
    expect(reason.detail).toBeTruthy();
  });

  it("reports ATTESTATION_CONFIG_CHANGED with the no-config-hash detail when the payload records none", () => {
    const bad = attestPayload();
    delete bad.config_hash;
    const r = checkMergeGate(attestInput({ attestationComments: [comment(attestBody(HEAD, bad))] }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_CONFIG_CHANGED");
    expect(reason.detail).toBe("the payload records no config_hash");
  });

  it("reports ATTESTATION_INVALID naming the merge_base gap when the payload records none", () => {
    const bad = attestPayload();
    delete bad.merge_base;
    const r = checkMergeGate(attestInput({ attestationComments: [comment(attestBody(HEAD, bad))] }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_INVALID");
    expect(reason.message).toBe("the attestation records no merge base, so the diff it graded cannot be confirmed");
  });

  it("shows both the attested and current merge base, each sliced to 8 characters, on a mismatch", () => {
    const otherBase = "9".repeat(40);
    const r = checkMergeGate(attestInput({ expectedMergeBase: otherBase }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_BASE_MOVED");
    expect(reason.detail).toBe(`attested against ${MERGE_BASE.slice(0, 8)}; current merge base ${otherBase.slice(0, 8)}`);
  });

  it("filters out a falsy entry from requiredLegs before checking for missing ones", () => {
    const r = checkMergeGate(attestInput({ requiredLegs: ["test", "quality", "", null, undefined] }));
    expect(r.ok).toBe(true);
  });

  it("reports the attestation verdict text verbatim in the ATTESTATION_FAILED message", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [comment(attestBody(HEAD, attestPayload({ verdict: "fail" })))] }));
    expect(r.reasons.find((x) => x.code === "ATTESTATION_FAILED").message).toBe("the attestation verdict is fail");
  });
});

describe("checkMergeGate — criteria evidence ladder messages", () => {
  it("pluralizes the CRITERIA_SPEC_UNKNOWN message for more than one unknown id", () => {
    const r = checkMergeGate(criteriaInput({ unknownSpecIds: ["ghost-one", "ghost-two"] }));
    const reason = r.reasons.find((x) => x.code === "CRITERIA_SPEC_UNKNOWN");
    expect(reason.message).toBe("body names Spec IDs that are not a spec at the head commit");
    expect(reason.detail).toBe("ghost-one, ghost-two");
  });

  it("uses the singular phrasing for exactly one unknown id", () => {
    const r = checkMergeGate(criteriaInput({ unknownSpecIds: ["ghost-one"] }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_SPEC_UNKNOWN").message).toBe("body names a Spec ID that is not a spec at the head commit");
  });

  it("filters a falsy entry out of unknownSpecIds before counting and joining", () => {
    const r = checkMergeGate(criteriaInput({ unknownSpecIds: ["ghost-one", "", null] }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_SPEC_UNKNOWN").detail).toBe("ghost-one");
  });

  it("only treats a criterion as weakened-in-scope when its spec is in the path-scoped set", () => {
    const r = checkMergeGate(
      criteriaInput({
        requiredCriteria: { alpha: ["AC-1"] },
        baseActiveCriteria: { alpha: ["AC-1", "AC-2"] },
        pathScopedSpecIds: ["alpha"],
      }),
    );
    expect(codes(r)).toContain("CRITERIA_SCOPE_WEAKENED");
    expect(codes(r)).not.toContain("CRITERIA_WEAKENED");
    expect(r.reasons.find((x) => x.code === "CRITERIA_SCOPE_WEAKENED").message).toBe("a criterion governing the changed files is planned or missing at the head");
  });

  it("joins multiple weakened-in-scope criteria with a comma", () => {
    const r = checkMergeGate(
      criteriaInput({
        requiredCriteria: { alpha: [] },
        baseActiveCriteria: { alpha: ["AC-1", "AC-2"] },
        pathScopedSpecIds: ["alpha"],
      }),
    );
    expect(r.reasons.find((x) => x.code === "CRITERIA_SCOPE_WEAKENED").detail).toBe("alpha/AC-1, alpha/AC-2");
  });

  it("reports CRITERIA_WEAKENED with its exact message when the spec is NOT path-scoped", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: ["AC-1"] }, baseActiveCriteria: { alpha: ["AC-1", "AC-2"] } }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_WEAKENED").message).toBe("a criterion active on the base branch is planned or missing at the head");
  });

  it("joins multiple weakened criteria across specs with a comma", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: [], beta: [] }, baseActiveCriteria: { alpha: ["AC-1"], beta: ["AC-2"] } }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_WEAKENED").detail).toBe("alpha/AC-1, beta/AC-2");
  });

  it("treats criteriaChangeRationale strictly: a truthy-but-not-true value must not downgrade CRITERIA_WEAKENED to a warning", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: [] }, baseActiveCriteria: { alpha: ["AC-1"] }, criteriaChangeRationale: "yes" }));
    expect(codes(r)).toContain("CRITERIA_WEAKENED");
    expect(r.warnings.map((w) => w.code)).not.toContain("CRITERIA_WEAKENED");
  });

  it("skips the evidence ladder entirely when every linked spec requires zero criteria, rather than crashing on an unreadable comment list", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: [], beta: [] }, comments: null }));
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual([]);
  });

  it("reports CRITERIA_FILES_UNREADABLE with its exact message and stops before the evidence ladder", () => {
    const r = checkMergeGate(criteriaInput({ criteriaFilesUnreadable: true, comments: null }));
    expect(codes(r)).toEqual(["CRITERIA_FILES_UNREADABLE"]);
    expect(r.reasons[0].message).toBe("the pull request's changed-file list could not be read in full, so criteria scope is unknown");
  });

  it("reports CRITERIA_BASE_UNREADABLE with the sha sliced to 8 characters", () => {
    const r = checkMergeGate(criteriaInput({ criteriaBaseUnreadable: "f".repeat(40), comments: null }));
    const reason = r.reasons.find((x) => x.code === "CRITERIA_BASE_UNREADABLE");
    expect(reason.message).toBe("the base commit is not in this clone, so the criteria rules could not be read");
    expect(reason.detail).toBe(`fetch ${"f".repeat(8)} and re-run`);
  });

  it("reports CRITERIA_EVIDENCE_INVALID with its exact message and detail when the comment list is unreadable", () => {
    const r = checkMergeGate(criteriaInput({ comments: null }));
    const reason = r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_INVALID");
    expect(reason.message).toBe("the evidence comments could not be read");
    expect(reason.detail).toBe("comment fetch failed");
  });

  it("treats a comment with no lastEditedAt property at all as unedited, same as an explicit null", () => {
    const r = checkMergeGate(criteriaInput({ comments: [{ body: evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })), authorAssociation: "OWNER" }] }));
    expect(r.ok).toBe(true);
  });

  it("only counts a comment as a marker comment when it has a body and a real marker sha", () => {
    const r = checkMergeGate(criteriaInput({ comments: [{ authorAssociation: "OWNER" }, comment("plain text")] }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_MISSING");
  });

  it("reports CRITERIA_EVIDENCE_MISSING with its exact message", () => {
    const r = checkMergeGate(criteriaInput({ comments: [comment("nothing here")] }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_MISSING").message).toBe("linked specs declare active criteria, but no evidence comment carries the marker");
  });

  it("reports CRITERIA_EVIDENCE_UNTRUSTED with its exact message", () => {
    const r = checkMergeGate(criteriaInput({ comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })), { authorAssociation: "CONTRIBUTOR" })] }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_UNTRUSTED").message).toBe("no evidence comment has both a trusted author association and no edit");
  });

  it("shows the current head sha, sliced, and every distinct evidence sha, sliced, on CRITERIA_EVIDENCE_STALE", () => {
    const r = checkMergeGate(criteriaInput({ comments: [comment(evidenceBody(OLDER, payloadFor({ alpha: ["AC-1"] }, "pass", { head_sha: OLDER })))] }));
    const reason = r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_STALE");
    expect(reason.detail).toBe(`head ${HEAD.slice(0, 8)}; evidence ${OLDER.slice(0, 8)}`);
  });

  it("reports CRITERIA_EVIDENCE_INVALID with its own detail when the payload does not parse", () => {
    const body = [`<!-- dotbabel-criteria verified-sha=${HEAD} -->`, `<!-- dotbabel-criteria-payload !!!not-base64!!! -->`].join("\n");
    const r = checkMergeGate(criteriaInput({ comments: [comment(body)] }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_INVALID").detail).toBeTruthy();
  });

  it("reports CRITERIA_EVIDENCE_INVALID with its own detail when the payload fails schema validation", () => {
    const bad = { ...payloadFor({ alpha: ["AC-1"] }), schema_version: 99 };
    const r = checkMergeGate(criteriaInput({ comments: [comment(evidenceBody(HEAD, bad))] }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_INVALID").detail).toBeTruthy();
  });

  it("names every gap between required and covered criteria in CRITERIA_EVIDENCE_INCOMPLETE", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: ["AC-1"], beta: ["AC-2"] } }));
    const reason = r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_INCOMPLETE");
    expect(reason.message).toBe("the evidence payload does not cover every active criterion");
    expect(reason.detail).toBe("beta/AC-2");
  });

  it("reports the criteria verdict text verbatim in the CRITERIA_FAILED message", () => {
    const r = checkMergeGate(criteriaInput({ comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] }, "fail")))] }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_FAILED").message).toBe("the evidence payload verdict is fail");
  });
});

describe("checkMergeGate — require_ci_check (withCi)", () => {
  it("reports CRITERIA_CI_CHECK_FAILED naming the actual check status", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: {}, requireCiCheck: true, ciCriteriaCheck: "failure" }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_CI_CHECK_FAILED").message).toBe("require_ci_check is set and the 'dotbabel criteria' check is failure");
  });

  it("reports absent, not the literal text undefined, when the check status is missing entirely", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: {}, requireCiCheck: true, ciCriteriaCheck: undefined }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_CI_CHECK_FAILED").message).toContain("absent");
  });
});

describe("checkMergeGate — toCriteriaMap normalizes a Map input the same as a plain object", () => {
  it("accepts requiredCriteria as a Map and reaches the same result as the equivalent object", () => {
    const asObject = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: ["AC-1"] } }));
    const asMap = checkMergeGate(criteriaInput({ requiredCriteria: new Map([["alpha", ["AC-1"]]]) }));
    expect(codes(asMap)).toEqual(codes(asObject));
  });

  it("treats a Map value that is not an array as no ids, not as a crash", () => {
    expect(() => checkMergeGate(criteriaInput({ baseActiveCriteria: new Map([["alpha", null]]) }))).not.toThrow();
  });

  it("treats a Map value that is not an array as an EMPTY id set, not a one-element sentinel", () => {
    // requiredTotal (sum of every spec's required-id-set size) is what
    // decides whether the evidence ladder runs at all. A null Map value
    // that fell back to a one-element sentinel array instead of `[]` would
    // make requiredTotal nonzero and wrongly trigger evidence checking
    // against an unreadable comment list.
    const r = checkMergeGate(criteriaInput({ requiredCriteria: new Map([["alpha", null]]), comments: null }));
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual([]);
  });
});

describe("checkMergeGate — glob direction and lookahead boundaries", () => {
  function globInput(protectedPaths, changedPaths) {
    return { body: GOOD_BODY, protectedPaths, changedPaths, hasSpecsDir: false };
  }

  it("requires the literal text after ** to still be honored, not swallowed by a backward lookahead", () => {
    const matches = checkMergeGate(globInput(["a**b"], ["a/x/y/b"]));
    expect(codes(matches)).toContain("MISSING_SPEC_ID");
    const noMatch = checkMergeGate(globInput(["a**b"], ["a/x/y/c"]));
    expect(codes(noMatch)).not.toContain("MISSING_SPEC_ID");
  });

  it("only consumes a literal / right after **, not an arbitrary next character", () => {
    const r = checkMergeGate(globInput(["**x"], ["anythingY"]));
    expect(codes(r)).not.toContain("MISSING_SPEC_ID");
  });

  it("requires a changed path to match every protected glob it's checked against, some not every, across multiple globs", () => {
    const r = checkMergeGate(globInput(["config", "totally-unrelated-pattern"], ["config"]));
    expect(codes(r)).toContain("MISSING_SPEC_ID");
  });
});

describe("checkLocalAttestGate — remote-side (none) fallback", () => {
  it("shows (none), not the literal text undefined, when prHeadOid specifically is missing", () => {
    const r = checkLocalAttestGate({ branch: "feature", worktreeStatus: "", prNumber: 7, localHead: HEAD, prHeadOid: undefined });
    expect(r.reasons.find((x) => x.code === "HEAD_MISMATCH").message).toContain("(none)");
  });
});

describe("checkMergeGate — attestationGovernedChange exact fields", () => {
  it("uses the exact governed-change code and message text", () => {
    const r = checkMergeGate(attestInput({ attestationGovernedTouched: ["a.json"] }));
    expect(r.warnings[0]).toMatchObject({
      code: "ATTESTATION_GOVERNED_CHANGE",
      message: "this pull request edits a file that governs what an attestation proves, so its own attestation cannot authorize it; verify it explicitly",
    });
    expect(r.attestation.code).toBe("ATTESTATION_GOVERNED_CHANGE");
  });
});

describe("checkMergeGate — evaluateAttestation robustness and exact messages", () => {
  it("does not crash when attestationComments is undefined rather than null", () => {
    const r = checkMergeGate(attestInput({ attestationComments: undefined }));
    expect(codes(r)).toContain("ATTESTATION_INVALID");
  });

  it("filters out a falsy, bodyless, or markerless entry without crashing, and still finds the real one", () => {
    const r = checkMergeGate(
      attestInput({
        attestationComments: [null, { authorAssociation: "OWNER" }, comment("chatter, no marker"), comment(attestBody(HEAD, attestPayload()))],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("joins multiple distinct stale attested shas with a comma in ATTESTATION_STALE's detail", () => {
    const otherOlder = "9".repeat(40);
    const r = checkMergeGate(
      attestInput({
        attestationComments: [comment(attestBody(OLDER, attestPayload({ head_sha: OLDER }))), comment(attestBody(otherOlder, attestPayload({ head_sha: otherOlder })))],
      }),
    );
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_STALE");
    expect(reason.detail).toBe(`attested ${OLDER.slice(0, 8)}, ${otherOlder.slice(0, 8)}; current ${HEAD.slice(0, 8)}`);
  });

  it("reports the exact no-payload message", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [comment(`<!-- local-attest verified-sha=${HEAD} -->`)] }));
    expect(r.reasons.find((x) => x.code === "ATTESTATION_INVALID").message).toBe("the attestation carries no evidence payload");
  });

  it("reports the exact could-not-be-read message for an undecodable payload, with the real decode error as detail (not the bare state name)", () => {
    const r = checkMergeGate(attestInput({ attestationComments: [comment(`<!-- local-attest verified-sha=${HEAD} -->\n<!-- local-attest-payload !!!not-base64!!! -->`)] }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_INVALID");
    expect(reason.message).toBe("the attestation payload could not be read");
    expect(reason.detail).not.toBe("undecodable");
    expect(reason.detail).toMatch(/decode/);
  });

  it("reports the exact invalid-payload message when the schema itself rejects the payload", () => {
    const bad = { ...attestPayload(), schema_version: 99 };
    const r = checkMergeGate(attestInput({ attestationComments: [comment(attestBody(HEAD, bad))] }));
    expect(r.reasons.find((x) => x.code === "ATTESTATION_INVALID").message).toBe("the attestation payload is not valid");
  });

  it("does not require a merge base check at all when expectedMergeBase is not a string", () => {
    const r = checkMergeGate(attestInput({ expectedMergeBase: undefined }));
    expect(r.ok).toBe(true);
  });

  it("reports the merge-base-missing message and detail with their exact text", () => {
    const noBase = attestPayload();
    delete noBase.merge_base;
    const r = checkMergeGate(attestInput({ attestationComments: [comment(attestBody(HEAD, noBase))] }));
    const reason = r.reasons.find((x) => x.code === "ATTESTATION_INVALID");
    expect(reason.message).toBe("the attestation records no merge base, so the diff it graded cannot be confirmed");
    expect(reason.detail).toBe("re-run local-attest with the base branch fetched");
  });

  it("skips the missing-legs check entirely when requiredLegs is empty after filtering falsy entries", () => {
    const r = checkMergeGate(attestInput({ requiredLegs: ["", null, undefined], attestationComments: [comment(attestBody(HEAD, attestPayload({ legs: [] })))] }));
    expect(codes(r)).not.toContain("ATTESTATION_INCOMPLETE");
  });

  it("joins every missing leg name with a comma in ATTESTATION_INCOMPLETE's detail", () => {
    const r = checkMergeGate(attestInput({ requiredLegs: ["test", "quality", "lint"], attestationComments: [comment(attestBody(HEAD, attestPayload({ legs: [{ name: "test", mode: "hard", status: "pass" }] })))] }));
    expect(r.reasons.find((x) => x.code === "ATTESTATION_INCOMPLETE").detail).toBe("quality, lint");
  });
});

describe("checkMergeGate — evaluateCriteria robustness and exact messages", () => {
  it("does not throw when baseActiveCriteria is null, and treats it as no base criteria", () => {
    expect(() => checkMergeGate(criteriaInput({ baseActiveCriteria: null }))).not.toThrow();
    const r = checkMergeGate(criteriaInput({ baseActiveCriteria: null }));
    expect(codes(r)).not.toContain("CRITERIA_WEAKENED");
  });

  it("does not throw when requiredCriteria is null, and treats it as nothing required", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: null, comments: null }));
    expect(r.ok).toBe(true);
  });

  it("builds a correct Set from a Map entry's real array value, not an empty one", () => {
    const r = checkMergeGate(
      criteriaInput({
        requiredCriteria: new Map([["alpha", ["AC-1"]]]),
        baseActiveCriteria: new Map([["alpha", ["AC-1", "AC-2"]]]),
      }),
    );
    expect(r.reasons.find((x) => x.code === "CRITERIA_WEAKENED").detail).toBe("alpha/AC-2");
  });

  it("builds a correct Set from a plain object's real array value, not an empty one", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: ["AC-1"] }, baseActiveCriteria: { alpha: ["AC-1", "AC-2"] } }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_WEAKENED").detail).toBe("alpha/AC-2");
  });

  it("does not flag a criterion present at both base and head as weakened", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: ["AC-1"] }, baseActiveCriteria: { alpha: ["AC-1"] } }));
    expect(codes(r)).not.toContain("CRITERIA_WEAKENED");
  });

  it("falls back to the default trusted associations when trustedAssociations is an empty array, not just when it's missing", () => {
    // An empty array taken LITERALLY (bypassing the fallback) trusts nobody
    // — including the real default, "OWNER" — which would ALSO report
    // UNTRUSTED for a CONTRIBUTOR author, so that case can't tell the two
    // apart. An OWNER author can: only the real fallback trusts them.
    const r = checkMergeGate(criteriaInput({ trustedAssociations: [], comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })), { authorAssociation: "OWNER" })] }));
    expect(codes(r)).not.toContain("CRITERIA_EVIDENCE_UNTRUSTED");
    expect(r.ok).toBe(true);
  });

  it("honors a real, populated custom trustedAssociations list, not always the OWNER-only default", () => {
    const r = checkMergeGate(criteriaInput({ trustedAssociations: ["CONTRIBUTOR"], comments: [comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })), { authorAssociation: "CONTRIBUTOR" })] }));
    expect(r.ok).toBe(true);
    expect(codes(r)).not.toContain("CRITERIA_EVIDENCE_UNTRUSTED");
  });

  it("falls back to an empty head sha, not the string Stryker was here, when headRefOid is missing", () => {
    const r = checkMergeGate(criteriaInput({ headRefOid: undefined }));
    const reason = r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_STALE");
    expect(reason.message).toBe("every trusted evidence comment names a commit other than the head");
    expect(reason.detail).toBe(`head ; evidence ${HEAD.slice(0, 8)}`);
  });

  it("joins multiple distinct stale evidence shas with a comma", () => {
    const otherOlder = "9".repeat(40);
    const r = checkMergeGate(
      criteriaInput({
        comments: [
          comment(evidenceBody(OLDER, payloadFor({ alpha: ["AC-1"] }, "pass", { head_sha: OLDER }))),
          comment(evidenceBody(otherOlder, payloadFor({ alpha: ["AC-1"] }, "pass", { head_sha: otherOlder }))),
        ],
      }),
    );
    const reason = r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_STALE");
    expect(reason.detail).toBe(`head ${HEAD.slice(0, 8)}; evidence ${OLDER.slice(0, 8)}, ${otherOlder.slice(0, 8)}`);
  });

  it("filters out a falsy, bodyless, or markerless comment without crashing", () => {
    const r = checkMergeGate(criteriaInput({ comments: [null, { authorAssociation: "OWNER" }, comment("chatter"), comment(evidenceBody(HEAD, payloadFor({ alpha: ["AC-1"] })))] }));
    expect(r.ok).toBe(true);
  });

  it("reports CRITERIA_EVIDENCE_INVALID's exact message when the payload does not parse, with the real decode error as detail (not the bare state name)", () => {
    const body = [`<!-- dotbabel-criteria verified-sha=${HEAD} -->`, `<!-- dotbabel-criteria-payload !!!not-base64!!! -->`].join("\n");
    const r = checkMergeGate(criteriaInput({ comments: [comment(body)] }));
    const reason = r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_INVALID");
    expect(reason.message).toBe("the evidence payload could not be read");
    expect(reason.detail).not.toBe("undecodable");
    expect(reason.detail).toMatch(/decode/);
  });

  it("reports CRITERIA_EVIDENCE_INVALID's exact message when the schema rejects the payload", () => {
    const bad = { ...payloadFor({ alpha: ["AC-1"] }), schema_version: 99 };
    const r = checkMergeGate(criteriaInput({ comments: [comment(evidenceBody(HEAD, bad))] }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_INVALID").message).toBe("the evidence payload is not valid");
  });

  it("joins every coverage gap with a comma in CRITERIA_EVIDENCE_INCOMPLETE's detail", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: ["AC-1", "AC-2"], beta: ["AC-3"] } }));
    expect(r.reasons.find((x) => x.code === "CRITERIA_EVIDENCE_INCOMPLETE").detail).toBe("alpha/AC-2, beta/AC-3");
  });

  it("sums criterion counts across multiple specs, not just the first, to decide whether evidence is required at all", () => {
    const r = checkMergeGate(criteriaInput({ requiredCriteria: { alpha: [], beta: ["AC-1"] }, comments: [comment("no evidence at all")] }));
    expect(codes(r)).toContain("CRITERIA_EVIDENCE_MISSING");
  });
});

describe("checkMergeGate — toCriteriaMap null safety", () => {
  it("does not throw when baseActiveCriteria is exactly null (not undefined, not an object)", () => {
    // typeof null === "object" in JS, so a check that relies on `typeof
    // value !== "object"` alone (without an explicit `=== null` guard)
    // would fall through to Object.entries(null), which throws.
    expect(() => checkMergeGate(criteriaInput({ baseActiveCriteria: null }))).not.toThrow();
  });

  it("does not throw when requiredCriteria is exactly null", () => {
    expect(() => checkMergeGate(criteriaInput({ requiredCriteria: null, comments: null }))).not.toThrow();
  });
});

describe("summarizeGates — non-array input", () => {
  it("treats a non-array results value as zero gates, not as one gate to introspect", () => {
    expect(() => summarizeGates(null)).not.toThrow();
    expect(summarizeGates(null).count).toEqual({ total: 0, passed: 0, failed: 0 });
  });
});

describe("summarizeGates", () => {
  it("collects only the DISTINCT reason codes across every failed gate, in first-seen order", () => {
    const summary = summarizeGates([
      { ok: false, gate: "a", reasons: [{ code: "X" }, { code: "Y" }] },
      { ok: false, gate: "b", reasons: [{ code: "Y" }, { code: "Z" }] },
    ]);
    expect(summary.reasonCodes).toEqual(["X", "Y", "Z"]);
  });

  it("treats a gate result with no reasons array as contributing no codes, not throwing", () => {
    expect(() => summarizeGates([{ ok: true, gate: "a" }])).not.toThrow();
    expect(summarizeGates([{ ok: true, gate: "a" }]).reasonCodes).toEqual([]);
  });
});
