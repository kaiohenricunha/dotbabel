// merge-verification — the soft path against a forged attestation.
//
// An agent that drives `gh` with the user's token can post a comment that
// looks exactly like a local-attest attestation. This module cannot stop that.
// It decides when /merge-pr verifies an attested pull request anyway (the spot
// check), reads what the default branch's own CI said about each merge (the
// cumulative rule), and recognizes the evidence this layer detects: a real
// test failure on code whose attestation said pass (the contradiction).
//
// Every case here is a decision with no I/O, so the fixtures are hand-built
// GitHub API shapes. The two run fixtures model real runs: one billing-blocked
// (the job never started) and one genuinely red (a job failed with steps, and
// its dependent job was skipped with zero steps).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CONTRADICTION_LABEL,
  LOCKFILE_INSTALLS,
  RUN_STATES,
  SPOT_CHECK_DEFAULTS,
  attestationMatch,
  ciAvailabilityState,
  classifyRun,
  contradictionMarker,
  contradictionRange,
  decideSpotCheck,
  failingCommitMarker,
  findContradictionIssue,
  installCommandsFor,
  isContradiction,
  isSpotCheckOff,
  isWorkflowAuthor,
  mainVerificationStatus,
  mergeSubjectPr,
  renderContradictionIssue,
  renderLocalContradictionIssue,
  resolveSpotCheckPolicy,
  spotCheckRoll,
} from "../src/merge-verification.mjs";
import { buildAttestationPayload, renderAttestationHeader } from "../src/attestation.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const C4 = "4".repeat(40);
const C5 = "5".repeat(40);

const BILLING_MESSAGE =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. " +
  "Please check the 'Billing & plans' section in your settings";

/** A policy as the resolver returns it, with overrides. */
function policy(overrides = {}) {
  return { ...SPOT_CHECK_DEFAULTS, always_paths: [], ...overrides };
}

/** A completed step. */
function step(n, conclusion = "success") {
  return { name: `step ${n}`, number: n, status: "completed", conclusion };
}

/** A real failure: the test job ran steps and one of them failed. */
function redRunFixture() {
  return {
    run: { id: 2, status: "completed", conclusion: "failure", event: "push", head_sha: HEAD },
    jobs: [
      { id: 21, name: "build", status: "completed", conclusion: "success", runner_name: "GitHub Actions 2", steps: [step(1), step(2)] },
      {
        id: 22,
        name: "test",
        status: "completed",
        conclusion: "failure",
        runner_name: "GitHub Actions 3",
        steps: [step(1), step(2), step(3, "failure"), step(4, "skipped")],
      },
      // Downstream of the failure: skipped, zero steps, no runner. Not a
      // sign that CI did not run.
      { id: 23, name: "smoke", status: "completed", conclusion: "skipped", runner_name: null, steps: [] },
    ],
  };
}

/**
 * Billing-blocked: run conclusion failure, the one job never started. GitHub
 * also adds BILLING_MESSAGE as an annotation; classifyRun does not read it,
 * because the zero steps already say the job never started.
 */
function billingRunFixture() {
  return {
    run: { id: 1, status: "completed", conclusion: "failure", event: "push", head_sha: HEAD },
    jobs: [{ id: 11, name: "test", status: "completed", conclusion: "failure", runner_name: "", steps: [] }],
  };
}

describe("resolveSpotCheckPolicy", () => {
  it("turns spot checks fully off when the base config has no spot_check block (opt-in)", () => {
    const off = { rate: 0, rate_when_ci_unavailable: 0, always_paths: [] };
    expect(resolveSpotCheckPolicy(undefined)).toEqual(off);
    expect(resolveSpotCheckPolicy({})).toEqual(off);
    expect(resolveSpotCheckPolicy({ attestation: { enforce: true } })).toEqual(off);
  });

  it("verifies every pull request while CI is unavailable once a spot_check block exists", () => {
    expect(resolveSpotCheckPolicy({ attestation: { spot_check: {} } })).toEqual(SPOT_CHECK_DEFAULTS);
    expect(SPOT_CHECK_DEFAULTS.rate_when_ci_unavailable).toBe(1);
  });

  it("fills unset keys with defaults and keeps the set ones", () => {
    expect(resolveSpotCheckPolicy({ attestation: { spot_check: { rate: 0.2 } } })).toEqual({
      rate: 0.2,
      rate_when_ci_unavailable: 1,
      always_paths: [],
    });
    expect(
      resolveSpotCheckPolicy({ attestation: { spot_check: { rate_when_ci_unavailable: 0.5, always_paths: ["src/auth/**"] } } }),
    ).toEqual({ rate: 0, rate_when_ci_unavailable: 0.5, always_paths: ["src/auth/**"] });
  });

  it("throws on an unknown key, never silently defaulting", () => {
    expect(() => resolveSpotCheckPolicy({ attestation: { spot_check: { sample: 0.2 } } })).toThrow(/unknown key "sample"/);
  });

  it("throws on a rate outside 0 to 1 or not a number", () => {
    for (const bad of [-0.01, 1.01, "0.2", Number.NaN, null, true]) {
      expect(() => resolveSpotCheckPolicy({ attestation: { spot_check: { rate: bad } } })).toThrow(/spot_check\.rate/);
      expect(() => resolveSpotCheckPolicy({ attestation: { spot_check: { rate_when_ci_unavailable: bad } } })).toThrow(
        /rate_when_ci_unavailable/,
      );
    }
  });

  it("throws on a spot_check block or path list of the wrong shape", () => {
    expect(() => resolveSpotCheckPolicy({ attestation: { spot_check: 0.2 } })).toThrow(/spot_check must be an object/);
    expect(() => resolveSpotCheckPolicy({ attestation: { spot_check: [] } })).toThrow(/spot_check must be an object/);
    expect(() => resolveSpotCheckPolicy({ attestation: "on" })).toThrow(/attestation must be an object/);
    expect(() => resolveSpotCheckPolicy({ attestation: { spot_check: { always_paths: "src/**" } } })).toThrow(/always_paths/);
    expect(() => resolveSpotCheckPolicy({ attestation: { spot_check: { always_paths: [""] } } })).toThrow(/always_paths/);
    // A glob dialect the matcher does not speak would silently match nothing.
    expect(() => resolveSpotCheckPolicy({ attestation: { spot_check: { always_paths: ["src/{a,b}/**"] } } })).toThrow(
      /always_paths/,
    );
  });
});

describe("spotCheckRoll", () => {
  it("derives the same roll from the same head and pull request", () => {
    const a = spotCheckRoll({ headSha: HEAD, prNumber: 7 });
    expect(spotCheckRoll({ headSha: HEAD, prNumber: 7 })).toBe(a);
    // Case does not change the commit, so it must not change the roll.
    expect(spotCheckRoll({ headSha: HEAD.toUpperCase(), prNumber: 7 })).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it("changes the roll when the head or the pull request changes", () => {
    const a = spotCheckRoll({ headSha: HEAD, prNumber: 7 });
    expect(spotCheckRoll({ headSha: OTHER, prNumber: 7 })).not.toBe(a);
    expect(spotCheckRoll({ headSha: HEAD, prNumber: 8 })).not.toBe(a);
  });

  it("is the first 32 bits of sha256 of head and pull request", async () => {
    const { createHash } = await import("node:crypto");
    const hex = createHash("sha256").update(`${HEAD}:7`).digest("hex").slice(0, 8);
    expect(spotCheckRoll({ headSha: HEAD, prNumber: 7 })).toBe(parseInt(hex, 16) / 2 ** 32);
  });

  it("refuses a head that is not a full SHA or a bad pull request number", () => {
    expect(() => spotCheckRoll({ headSha: "abc", prNumber: 7 })).toThrow(/head/);
    expect(() => spotCheckRoll({ headSha: HEAD, prNumber: 0 })).toThrow(/pull request/);
  });
});

describe("decideSpotCheck", () => {
  it("never selects when the effective rate is 0 and no always path matches", () => {
    expect(decideSpotCheck({ policy: policy(), changedPaths: ["a.js"], ciAvailable: true, random: 0 })).toEqual({
      selected: false,
      reason: "off",
      rate: 0,
      matched: null,
    });
  });

  it("selects an always path whatever the rate", () => {
    const d = decideSpotCheck({
      policy: policy({ always_paths: ["src/auth/**"] }),
      changedPaths: ["README.md", "src/auth/login.js"],
      ciAvailable: true,
      random: 0.999,
    });
    expect(d).toEqual({ selected: true, reason: "always_path", rate: 1, matched: "src/auth/login.js" });
  });

  it("selects when always paths are set but the changed files are unknown", () => {
    const d = decideSpotCheck({ policy: policy({ always_paths: ["src/auth/**"] }), changedPaths: null, ciAvailable: true, random: 0.999 });
    expect(d.selected).toBe(true);
    expect(d.reason).toBe("always_path");
    expect(d.matched).toBeNull();
  });

  it("selects by rate when the roll is below the rate", () => {
    expect(decideSpotCheck({ policy: policy({ rate: 0.2 }), changedPaths: [], ciAvailable: true, random: 0.19 })).toMatchObject({
      selected: true,
      reason: "rate",
      rate: 0.2,
    });
    expect(decideSpotCheck({ policy: policy({ rate: 0.2 }), changedPaths: [], ciAvailable: true, random: 0.2 })).toMatchObject({
      selected: false,
      reason: "not_selected",
      rate: 0.2,
    });
  });

  it("uses rate_when_ci_unavailable when the default branch CI did not run", () => {
    expect(decideSpotCheck({ policy: policy({ rate: 0.2 }), changedPaths: [], ciAvailable: false, random: 0.999 })).toMatchObject({
      selected: true,
      reason: "ci_unavailable",
      rate: 1,
    });
    expect(
      decideSpotCheck({ policy: policy({ rate: 0.2, rate_when_ci_unavailable: 0 }), changedPaths: [], ciAvailable: false, random: 0 }),
    ).toMatchObject({ selected: false, reason: "off", rate: 0 });
  });

  it("uses the normal rate when CI availability is unknown", () => {
    expect(decideSpotCheck({ policy: policy({ rate: 0.2 }), changedPaths: [], ciAvailable: null, random: 0.5 })).toMatchObject({
      selected: false,
      reason: "not_selected",
      rate: 0.2,
    });
  });

  it("selects at rate 1 even on the highest roll", () => {
    expect(decideSpotCheck({ policy: policy({ rate: 1 }), changedPaths: [], ciAvailable: true, random: 0.999999 }).selected).toBe(true);
  });

  it("refuses a roll outside 0 to 1", () => {
    expect(() => decideSpotCheck({ policy: policy({ rate: 0.5 }), changedPaths: [], ciAvailable: true, random: 1 })).toThrow(/random/);
    expect(() => decideSpotCheck({ policy: policy({ rate: 0.5 }), changedPaths: [], ciAvailable: true, random: -1 })).toThrow(/random/);
  });
});

describe("isSpotCheckOff", () => {
  it("is off only when both rates are 0 and no always path is set", () => {
    expect(isSpotCheckOff(resolveSpotCheckPolicy(undefined))).toBe(true);
    expect(isSpotCheckOff({ rate: 0, rate_when_ci_unavailable: 0, always_paths: [] })).toBe(true);
    expect(isSpotCheckOff(resolveSpotCheckPolicy({ attestation: { spot_check: {} } }))).toBe(false);
    expect(isSpotCheckOff({ rate: 0, rate_when_ci_unavailable: 0, always_paths: ["src/**"] })).toBe(false);
    expect(isSpotCheckOff({ rate: 0.01, rate_when_ci_unavailable: 0, always_paths: [] })).toBe(false);
  });
});

describe("classifyRun", () => {
  it("classifies a billing-blocked run as unverified", () => {
    expect(classifyRun(billingRunFixture())).toBe("unverified");
  });

  it("classifies a job that never started as unverified through the zero-step rule alone", () => {
    const f = billingRunFixture();
    // Zero steps never reads as a real failure, even when a runner was named.
    const withRunner = [{ ...f.jobs[0], runner_name: "GitHub Actions 9" }];
    expect(classifyRun({ ...f, jobs: withRunner })).toBe("unverified");
    for (const conclusion of ["startup_failure", "cancelled"]) {
      expect(classifyRun({ ...f, jobs: [{ ...f.jobs[0], conclusion }] }), conclusion).toBe("unverified");
    }
  });

  it("keeps a red run red when an annotation names billing", () => {
    // A test reporter writes failure messages as annotations, and code under
    // test can print `::error::billing`. Neither may hide a real failure.
    const annotations = [
      { annotation_level: "failure", message: BILLING_MESSAGE },
      { annotation_level: "failure", message: "expected billing total to be 100" },
    ];
    expect(classifyRun({ ...redRunFixture(), annotations })).toBe("red");
  });

  it("classifies a cancelled run as red when a job had already failed after its steps", () => {
    const f = redRunFixture();
    expect(classifyRun({ ...f, run: { ...f.run, conclusion: "cancelled" } })).toBe("red");
  });

  it("classifies a failed job with steps as red even when a dependent job was skipped with zero steps", () => {
    expect(classifyRun(redRunFixture())).toBe("red");
  });

  it("classifies a successful run as green", () => {
    const f = redRunFixture();
    expect(
      classifyRun({
        run: { ...f.run, conclusion: "success" },
        jobs: [{ id: 1, name: "test", status: "completed", conclusion: "success", runner_name: "r", steps: [step(1)] }],
      }),
    ).toBe("green");
    // Jobs are not fetched for a successful run; the run conclusion stands.
    expect(classifyRun({ run: { ...f.run, conclusion: "success" }, jobs: null })).toBe("green");
  });

  it("does not call a success green when no job ran a step", () => {
    const f = redRunFixture();
    const jobs = [{ id: 1, name: "test", status: "completed", conclusion: "skipped", runner_name: null, steps: [] }];
    expect(classifyRun({ run: { ...f.run, conclusion: "success" }, jobs })).toBe("unverified");
  });

  it("classifies startup_failure, cancelled, and skipped runs as unverified", () => {
    for (const conclusion of ["startup_failure", "cancelled", "skipped", "stale", "action_required", "neutral"]) {
      expect(classifyRun({ run: { status: "completed", conclusion }, jobs: [] }), conclusion).toBe("unverified");
    }
  });

  it("classifies a timeout before any job started as unverified and one after as red", () => {
    const before = [{ id: 1, name: "test", status: "completed", conclusion: "timed_out", runner_name: "", steps: [] }];
    expect(classifyRun({ run: { status: "completed", conclusion: "timed_out" }, jobs: before })).toBe("unverified");
    const after = [{ id: 1, name: "test", status: "completed", conclusion: "timed_out", runner_name: "r", steps: [step(1), step(2, "cancelled")] }];
    expect(classifyRun({ run: { status: "completed", conclusion: "timed_out" }, jobs: after })).toBe("red");
  });

  it("classifies a failed run as unknown, never unverified, when its jobs cannot be read", () => {
    expect(classifyRun({ run: { status: "completed", conclusion: "failure" }, jobs: null })).toBe("unknown");
    expect(classifyRun({ run: { status: "completed", conclusion: "cancelled" }, jobs: null })).toBe("unknown");
    expect(classifyRun({ run: { status: "in_progress", conclusion: null } })).toBe("unknown");
  });

  it("classifies a run that cannot be read as unknown", () => {
    expect(classifyRun({ run: null, jobs: null })).toBe("unknown");
    expect(classifyRun(undefined)).toBe("unknown");
    expect(RUN_STATES).toEqual(["green", "red", "unverified", "unknown"]);
  });

  it("classifies a run in progress with no failed job as unverified", () => {
    const jobs = [{ id: 1, name: "test", status: "in_progress", conclusion: null, runner_name: "r", steps: [step(1)] }];
    expect(classifyRun({ run: { status: "in_progress", conclusion: null }, jobs })).toBe("unverified");
  });

  it("classifies a run in progress as red once a job has failed with steps", () => {
    // The contradiction job reads its own run, which is still in progress.
    const f = redRunFixture();
    const jobs = [...f.jobs, { id: 24, name: "contradiction", status: "in_progress", conclusion: null, runner_name: "r", steps: [step(1)] }];
    expect(classifyRun({ run: { ...f.run, status: "in_progress", conclusion: null }, jobs })).toBe("red");
  });
});

describe("ciAvailabilityState", () => {
  const recent = [C1, C2, C3];

  it("accepts the newest completed run only when it tested a recent default-branch commit", () => {
    expect(ciAvailabilityState({ recentShas: recent, runsRead: true, latestRun: { head_sha: C3 }, classification: "green" })).toMatchObject({
      state: "available",
      available: true,
    });
    expect(ciAvailabilityState({ recentShas: recent, runsRead: true, latestRun: { head_sha: C2 }, classification: "red" }).state).toBe("available");
    // An old green run says nothing about recent merges that had no run.
    const old = ciAvailabilityState({ recentShas: recent, runsRead: true, latestRun: { head_sha: C5 }, classification: "green" });
    expect(old).toMatchObject({ state: "unavailable", available: false });
    expect(old.reason).toMatch(/not one of the last 3 commits/);
  });

  it("reports CI unavailable when there is no completed run or the newest one did not run the tests", () => {
    expect(ciAvailabilityState({ recentShas: recent, runsRead: true, latestRun: undefined }).state).toBe("unavailable");
    expect(ciAvailabilityState({ recentShas: recent, runsRead: true, latestRun: { head_sha: C1 }, classification: "unverified" }).state).toBe(
      "unavailable",
    );
  });

  it("reports CI unknown, never available, when the runs, the run or the commits cannot be read", () => {
    expect(ciAvailabilityState({ recentShas: recent, runsRead: false }).state).toBe("unknown");
    expect(ciAvailabilityState({ recentShas: null, runsRead: true, latestRun: { head_sha: C1 }, classification: "green" }).state).toBe("unknown");
    expect(ciAvailabilityState({ recentShas: recent, runsRead: true, latestRun: { head_sha: C1 }, classification: "unknown" })).toMatchObject({
      state: "unknown",
      available: null,
    });
  });
});

describe("installCommandsFor", () => {
  it("installs from the first JavaScript lockfile, then go.sum, then uv.lock", () => {
    expect(installCommandsFor(["yarn.lock", "package-lock.json"])).toEqual([{ lockfile: "package-lock.json", argv: ["npm", "ci"] }]);
    expect(installCommandsFor(["uv.lock", "go.sum", "pnpm-lock.yaml"])).toEqual([
      { lockfile: "pnpm-lock.yaml", argv: ["pnpm", "i", "--frozen-lockfile"] },
      { lockfile: "go.sum", argv: ["go", "mod", "download"] },
      { lockfile: "uv.lock", argv: ["uv", "sync"] },
    ]);
  });

  it("installs nothing without a supported lockfile", () => {
    expect(installCommandsFor([])).toEqual([]);
    expect(installCommandsFor(["Gemfile.lock"])).toEqual([]);
  });

  it("uses the same install table as the explicit path of /merge-pr", () => {
    const merge = readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", "commands", "merge-pr.md"), "utf8");
    const bullet = merge.slice(merge.indexOf("**Install dependencies first.**"), merge.indexOf("**Run the full project test suite.**"));
    const pairs = [...bullet.matchAll(/`([^`]+)` →\s+`([^`]+)`/g)].map((m) => [m[1], m[2]]);
    expect(pairs).toEqual(LOCKFILE_INSTALLS.map(([lockfile, argv]) => [lockfile, argv.join(" ")]));
  });
});

describe("mainVerificationStatus", () => {
  const commits = [
    { sha: C1, pr: 105 },
    { sha: C2, pr: 104 },
    { sha: C3, pr: 103 },
    { sha: C4, pr: 102 },
    { sha: C5, pr: null },
  ];

  it("lets a green run verify its commit and every older commit", () => {
    const s = mainVerificationStatus({
      commits,
      runs: [
        { headSha: C2, state: "red" },
        { headSha: C3, state: "green" },
        { headSha: C4, state: "red" },
      ],
    });
    expect(s.known).toBe(true);
    expect(s.lastGreen).toBe(C3);
    expect(s.verified).toEqual([C3, C4, C5]);
    expect(s.red).toEqual([C2]);
    expect(s.unverified).toEqual([C1]);
    expect(s.unknown).toEqual([]);
    expect(s.commits.map((c) => [c.pr, c.state, c.run])).toEqual([
      [105, "unverified", null],
      [104, "red", "red"],
      [103, "verified", "green"],
      [102, "verified", "red"],
      [null, "verified", null],
    ]);
  });

  it("reports every commit as debt when no run is green", () => {
    const s = mainVerificationStatus({ commits, runs: [{ headSha: C1, state: "unverified" }, { headSha: C4, state: "red" }] });
    expect(s.lastGreen).toBeNull();
    expect(s.verified).toEqual([]);
    expect(s.red).toEqual([C4]);
    expect(s.unverified).toEqual([C1, C2, C3, C5]);
  });

  it("prefers green over red over unverified for two runs of one commit", () => {
    const s = mainVerificationStatus({
      commits: [{ sha: C1, pr: 1 }],
      runs: [
        { headSha: C1, state: "unverified" },
        { headSha: C1, state: "red" },
        { headSha: C1, state: "green" },
      ],
    });
    expect(s.verified).toEqual([C1]);
  });

  it("reports a commit whose run could not be read as unknown debt, never verified", () => {
    const s = mainVerificationStatus({
      commits,
      runs: [
        { headSha: C1, state: "unknown" },
        { headSha: C2, state: "unknown" },
        { headSha: C2, state: "red" },
        { headSha: C3, state: "unknown" },
        { headSha: C3, state: "unverified" },
        { headSha: C4, state: "green" },
      ],
    });
    expect(s.lastGreen).toBe(C4);
    expect(s.unknown).toEqual([C1, C3]);
    expect(s.red).toEqual([C2]);
    expect(s.verified).toEqual([C4, C5]);
    expect(s.commits.map((c) => c.run)).toEqual(["unknown", "red", "unknown", "green", null]);
  });

  it("reports unknown, never verified, when the runs could not be read", () => {
    const s = mainVerificationStatus({ commits, runs: null });
    expect(s.known).toBe(false);
    expect(s.lastGreen).toBeNull();
    expect(s.verified).toEqual([]);
    expect(s.unknown).toEqual([C1, C2, C3, C4, C5]);
    expect(s.commits.every((c) => c.state === "unknown")).toBe(true);
  });
});

describe("isContradiction", () => {
  const passing = renderAttestationHeader(
    buildAttestationPayload({ headSha: HEAD, legs: [{ name: "test", mode: "hard", status: "pass" }], now: new Date(0) }),
  );
  const owner = (body, extra = {}) => ({ body, authorAssociation: "OWNER", lastEditedAt: null, ...extra });

  it("is a contradiction when a real failure meets a current trusted passing attestation", () => {
    expect(isContradiction({ testResult: "red", attestation: { comments: [owner(passing)], headSha: HEAD } })).toBe(true);
  });

  it("is not a contradiction when the run did not verify anything", () => {
    expect(isContradiction({ testResult: "unverified", attestation: { comments: [owner(passing)], headSha: HEAD } })).toBe(false);
    expect(isContradiction({ testResult: "unknown", attestation: { comments: [owner(passing)], headSha: HEAD } })).toBe(false);
    expect(isContradiction({ testResult: "green", attestation: { comments: [owner(passing)], headSha: HEAD } })).toBe(false);
  });

  it("counts a trusted attestation that was edited after it was posted, and says so", () => {
    const edited = owner(passing, { lastEditedAt: "2026-01-01T00:00:00Z" });
    expect(isContradiction({ testResult: "red", attestation: { comments: [edited], headSha: HEAD } })).toBe(true);
    expect(attestationMatch({ comments: [edited], headSha: HEAD })).toEqual({ found: true, edited: true });
    expect(attestationMatch({ comments: [edited, owner(passing)], headSha: HEAD })).toEqual({ found: true, edited: false });
    // An edit that removed the attestation, or a deleted comment, leaves nothing to find.
    expect(attestationMatch({ comments: [owner("edited away", { lastEditedAt: "2026-01-01T00:00:00Z" })], headSha: HEAD })).toEqual({
      found: false,
      edited: false,
    });
    expect(attestationMatch(null)).toEqual({ found: false, edited: false });
  });

  it("is not a contradiction without a current trusted passing attestation for the head", () => {
    expect(isContradiction({ testResult: "red", attestation: { comments: [owner(passing)], headSha: OTHER } })).toBe(false);
    expect(isContradiction({ testResult: "red", attestation: { comments: [owner(passing, { authorAssociation: "CONTRIBUTOR" })], headSha: HEAD } })).toBe(
      false,
    );
    expect(isContradiction({ testResult: "red", attestation: { comments: [], headSha: HEAD } })).toBe(false);
    expect(isContradiction({ testResult: "red", attestation: null })).toBe(false);
  });

  it("honors the trusted associations it is given", () => {
    const member = owner(passing, { authorAssociation: "MEMBER" });
    expect(isContradiction({ testResult: "red", attestation: { comments: [member], headSha: HEAD } })).toBe(false);
    expect(
      isContradiction({ testResult: "red", attestation: { comments: [member], headSha: HEAD, trustedAssociations: ["OWNER", "MEMBER"] } }),
    ).toBe(true);
  });
});

describe("contradictionRange", () => {
  const history = [C1, C2, C3, C4, C5].map((sha) => ({ sha }));

  it("walks back from the failing commit to the last green commit, not including it", () => {
    expect(contradictionRange({ commits: history, greenShas: new Set([C4]) })).toEqual({
      commits: [{ sha: C1 }, { sha: C2 }, { sha: C3 }],
      lastGreen: C4,
      bounded: false,
    });
  });

  it("keeps the failing commit even when an older run of it was green", () => {
    expect(contradictionRange({ commits: history, greenShas: new Set([C1, C2]) })).toEqual({ commits: [{ sha: C1 }], lastGreen: C2, bounded: false });
  });

  it("stops at the bound when no green run is found, and says it stopped", () => {
    expect(contradictionRange({ commits: history, greenShas: new Set(), limit: 3 })).toEqual({
      commits: [{ sha: C1 }, { sha: C2 }, { sha: C3 }],
      lastGreen: null,
      bounded: true,
    });
    // A green commit right after the bound still closes the range.
    expect(contradictionRange({ commits: history, greenShas: new Set([C4]), limit: 3 }).bounded).toBe(false);
  });

  it("covers the whole history when it ends before a green run or the bound", () => {
    expect(contradictionRange({ commits: history.slice(0, 2), greenShas: new Set() })).toEqual({
      commits: [{ sha: C1 }, { sha: C2 }],
      lastGreen: null,
      bounded: false,
    });
  });
});

describe("contradiction issue helpers", () => {
  it("names the pull request and the attested head in the local marker, and the failing commit in the CI marker", () => {
    expect(contradictionMarker({ pr: 12, sha: HEAD })).toBe(`<!-- dotbabel:attestation-contradicted pr=12 sha=${HEAD} -->`);
    expect(() => contradictionMarker({ pr: 12, sha: "nope" })).toThrow(/sha/);
    expect(failingCommitMarker(OTHER.toUpperCase())).toBe(`<!-- dotbabel:attestation-contradicted commit=${OTHER} -->`);
    expect(() => failingCommitMarker("HEAD")).toThrow(/sha/);
  });

  it("finds an existing issue by its marker only, and says when it is closed", () => {
    const marker = contradictionMarker({ pr: 12, sha: HEAD });
    expect(findContradictionIssue([{ number: 3, body: "other" }, { number: 4, body: `x\n${marker}\n`, state: "OPEN" }], marker)).toEqual({
      number: 4,
      closed: false,
    });
    expect(findContradictionIssue([{ number: 5, body: marker, state: "CLOSED" }], marker)).toEqual({ number: 5, closed: true });
    expect(findContradictionIssue([{ number: 3, body: contradictionMarker({ pr: 13, sha: HEAD }) }], marker)).toBeNull();
    expect(findContradictionIssue(null, marker)).toBeNull();
  });

  it("accepts only an issue the workflow identity opened when asked to", () => {
    const marker = failingCommitMarker(OTHER);
    const planted = { number: 6, body: marker, state: "CLOSED", author: { login: "owner" } };
    const bot = { number: 7, body: marker, state: "OPEN", author: { login: "app/github-actions" } };
    expect(findContradictionIssue([planted, bot], marker, { workflowOnly: true })).toEqual({ number: 7, closed: false });
    expect(findContradictionIssue([planted], marker, { workflowOnly: true })).toBeNull();
    expect(findContradictionIssue([planted], marker)).toEqual({ number: 6, closed: true });
    expect(isWorkflowAuthor({ login: "github-actions[bot]" })).toBe(true);
    expect(isWorkflowAuthor({ login: "github-actions" })).toBe(false);
    expect(isWorkflowAuthor(null)).toBe(false);
  });

  it("renders one issue for the failing commit with the range and every suspect", () => {
    const issue = renderContradictionIssue({
      failingSha: C1,
      runUrl: "https://example.test/runs/9",
      range: { commits: [{ sha: C1 }, { sha: C2 }], lastGreen: C3, bounded: false },
      suspects: [
        { pr: 12, attestedSha: HEAD, mergeSha: C1, edited: false },
        { pr: 11, attestedSha: OTHER, mergeSha: C2, edited: true },
      ],
    });
    expect(issue.title).toBe(`Attestation contradicted: ${C1.slice(0, 8)} (#12, #11)`);
    expect(issue.labels).toEqual([CONTRADICTION_LABEL]);
    expect(issue.body.startsWith(failingCommitMarker(C1))).toBe(true);
    for (const text of ["#12", "#11", HEAD, OTHER, C1, C2, C3, "https://example.test/runs/9"]) expect(issue.body).toContain(text);
    expect(issue.body).toMatch(/#11: .*edited after it was posted/);
    expect(issue.body).not.toMatch(/#12: .*edited/);
  });

  it("lists the possible causes in short sentences, the merged tree among them", () => {
    const issue = renderContradictionIssue({
      failingSha: C1,
      range: { commits: [{ sha: C1 }], lastGreen: null, bounded: true },
      suspects: [{ pr: 12, attestedSha: HEAD, mergeSha: C1, edited: false }],
    });
    expect(issue.body).toMatch(/forged or wrong/);
    expect(issue.body).toMatch(/flaky/);
    expect(issue.body).toMatch(/merged tree differs from the attested head/);
    expect(issue.body).toMatch(/walk stops at 1 commit\(s\)\./);
    for (const sentence of issue.body.replace(/`[^`]*`/g, "x").split(/(?<=[.:])\s+/)) {
      expect(sentence.split(/\s+/).filter(Boolean).length, sentence).toBeLessThanOrEqual(25);
    }
  });

  it("labels a local failure as weaker than CI", () => {
    const issue = renderLocalContradictionIssue({ pr: 12, attestedSha: HEAD, edited: true });
    expect(issue.title).toBe("Attestation contradicted: #12");
    expect(issue.body).toContain(contradictionMarker({ pr: 12, sha: HEAD }));
    expect(issue.body).toMatch(/same machine as the agent/);
    expect(issue.body).toMatch(/edited after it was posted/);
    expect(issue.body).not.toContain("undefined");
  });
});

describe("mergeSubjectPr", () => {
  it("reads the pull request number a squash merge appends to its subject", () => {
    expect(mergeSubjectPr("feat(x): add a thing (#453)")).toBe(453);
    expect(mergeSubjectPr("chore: no number")).toBeNull();
    expect(mergeSubjectPr("fix: refs #12 in the middle")).toBeNull();
  });
});

describe("module purity", () => {
  it("merge-verification performs no I/O", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "..", "src", "merge-verification.mjs"), "utf8");
    expect(src).not.toMatch(/node:child_process|node:fs|node:os|node:process/);
  });
});
