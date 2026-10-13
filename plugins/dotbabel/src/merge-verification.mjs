/**
 * merge-verification — detect a forged attestation after the fact.
 *
 * `/merge-pr` skips its own test run when a trusted, SHA-pinned local-attest
 * comment covers the head (docs/attestation.md). An agent that drives `gh`
 * with the user's token can post that comment itself. Signatures would stop
 * it, and they are parked as an opt-in design (docs/specs/unforgeable-evidence)
 * because a generic open-source tool cannot require a hardware key. This
 * module is the soft path: it does not prevent a forgery, it makes one likely
 * to be seen.
 *
 * Three decisions live here:
 *
 *  - The SPOT CHECK. A share of attested pull requests is verified explicitly
 *    anyway. The roll comes from the head SHA, so asking again on the same
 *    head gives the same answer; a new roll needs a new head, and a new head
 *    already invalidates the attestation.
 *  - The CUMULATIVE RULE. The default branch is squash-merged and linear, so a
 *    green CI run on commit X verifies X and every older commit. Commits newer
 *    than the last green run are debt.
 *  - The CONTRADICTION. A real test failure on code whose attestation said
 *    pass is the one fact a forgery cannot hide, and it is raised as an alarm.
 *
 * A run that did not run is never a failure and never a pass. Private
 * repositories hit the GitHub Actions spending limit, and then the run fails
 * with no step executed. That run is `unverified`: it proves nothing either
 * way, so it can neither verify a commit nor contradict an attestation.
 *
 * Pure apart from `node:crypto`: no I/O and no clock. The bin reads GitHub and
 * git and passes the facts in.
 */
import { createHash } from "node:crypto";

import { hasCurrentAttestation } from "./attestation.mjs";
import { globToRegExp } from "./pr-gates.mjs";

/**
 * The values a `spot_check` block gets for the keys it leaves unset. Without a
 * block, spot checks are off (`SPOT_CHECK_OFF`): the control is opt-in.
 */
export const SPOT_CHECK_DEFAULTS = Object.freeze({
  rate: 0,
  rate_when_ci_unavailable: 1,
  always_paths: Object.freeze([]),
});

/** The policy when the base `.dotbabel.json` has no `spot_check` block: no spot checks at all. */
export const SPOT_CHECK_OFF = Object.freeze({
  rate: 0,
  rate_when_ci_unavailable: 0,
  always_paths: Object.freeze([]),
});

/** Why `decideSpotCheck` decided what it did. */
export const SPOT_CHECK_REASONS = Object.freeze(["off", "always_path", "ci_unavailable", "rate", "not_selected"]);

/** What one CI run proves about its commit. */
export const RUN_STATES = Object.freeze(["green", "red", "unverified"]);

/** The label put on a pull request whose attestation a real failure contradicted. */
export const CONTRADICTION_LABEL = "attestation-contradicted";

const SPOT_CHECK_KEYS = new Set(Object.keys(SPOT_CHECK_DEFAULTS));
const SHA_RE = /^[0-9a-f]{40}$/i;
// The glob dialect `globToRegExp` reads literally. A pattern written for a
// richer dialect would silently match nothing, so it is refused instead.
const UNSUPPORTED_GLOB_CHARS = /[!{}[\]]/;
// The GitHub Actions message for a job that never started because of billing.
const BILLING_RE = /spending limit|recent account payments|billing/i;
// Run conclusions that say nothing about the code.
const NOT_RUN_CONCLUSIONS = new Set(["startup_failure", "cancelled", "skipped", "stale", "action_required", "neutral"]);
const RUN_RANK = { green: 3, red: 2, unverified: 1 };

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function assertRate(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`attestation.spot_check.${name} must be a number from 0 to 1, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The spot-check policy from a parsed `.dotbabel.json`, with defaults.
 *
 * The caller reads the file from the BASE ref, as the rest of the attestation
 * policy is read: a pull request must not lower its own chance of a check.
 * Strict on purpose, like `resolveMaxAttempts`: a typo must not silently turn
 * spot checks off, so an unknown key or an out-of-range value throws.
 *
 * @param {unknown} config The whole parsed `.dotbabel.json`, or undefined when absent.
 * @returns {{ rate: number, rate_when_ci_unavailable: number, always_paths: string[] }}
 */
export function resolveSpotCheckPolicy(config) {
  const off = { rate: SPOT_CHECK_OFF.rate, rate_when_ci_unavailable: SPOT_CHECK_OFF.rate_when_ci_unavailable, always_paths: [] };
  if (!isPlainObject(config) || !("attestation" in config)) return off;
  const attestation = config.attestation;
  if (!isPlainObject(attestation)) throw new Error("attestation must be an object");
  if (!("spot_check" in attestation)) return off;
  const block = attestation.spot_check;
  if (!isPlainObject(block)) throw new Error("attestation.spot_check must be an object");
  const unknown = Object.keys(block).find((k) => !SPOT_CHECK_KEYS.has(k));
  if (unknown !== undefined) throw new Error(`attestation.spot_check has unknown key ${JSON.stringify(unknown)}`);
  const out = { rate: SPOT_CHECK_DEFAULTS.rate, rate_when_ci_unavailable: SPOT_CHECK_DEFAULTS.rate_when_ci_unavailable, always_paths: [] };
  if (block.rate !== undefined) out.rate = assertRate(block.rate, "rate");
  if (block.rate_when_ci_unavailable !== undefined) {
    out.rate_when_ci_unavailable = assertRate(block.rate_when_ci_unavailable, "rate_when_ci_unavailable");
  }
  if (block.always_paths !== undefined) {
    const paths = block.always_paths;
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p !== "" && !UNSUPPORTED_GLOB_CHARS.test(p))) {
      throw new Error("attestation.spot_check.always_paths must be a list of non-empty globs using only **, * and ?");
    }
    out.always_paths = [...paths];
  }
  return out;
}

/**
 * The spot-check roll for one head of one pull request, in [0, 1).
 *
 * The first 32 bits of sha256(`<head>:<pr>`). Derived, not drawn: running the
 * check again on the same head cannot produce a different answer, so the only
 * way to re-roll is a new head — and a new head needs a new attestation
 * anyway. The roll is predictable, so an agent can compute it in advance and
 * craft a head that is not selected; that is a stated limit of the soft path.
 *
 * @param {{ headSha: string, prNumber: number }} input
 * @returns {number}
 */
export function spotCheckRoll({ headSha, prNumber }) {
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) throw new Error("head must be a full 40-character SHA");
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error("pull request number must be a positive integer");
  const hex = createHash("sha256").update(`${headSha.toLowerCase()}:${prNumber}`).digest("hex").slice(0, 8);
  return parseInt(hex, 16) / 2 ** 32;
}

/**
 * @typedef {object} SpotCheckDecision
 * @property {boolean} selected True when /merge-pr must verify explicitly.
 * @property {"off"|"always_path"|"ci_unavailable"|"rate"|"not_selected"} reason
 * @property {number} rate The rate the roll was compared against.
 * @property {string|null} matched The changed path an always path matched.
 */

/**
 * Decide whether to verify one attested pull request explicitly.
 *
 * An `always_paths` match selects first, whatever the rate. A changed-file
 * list that could not be read selects too when `always_paths` is set: an
 * unknown list must not read as "touches nothing sensitive". Then the rate
 * applies: `rate_when_ci_unavailable` when the default branch CI did not run,
 * because then nothing off the machine checks the attestation later, and
 * `rate` otherwise, including when availability is unknown.
 *
 * @param {{ policy: { rate: number, rate_when_ci_unavailable: number, always_paths: string[] },
 *           changedPaths: string[]|null, ciAvailable: boolean|null, random: number }} input
 *   `random` is the roll in [0, 1), from `spotCheckRoll` in production.
 * @returns {SpotCheckDecision}
 */
export function decideSpotCheck({ policy, changedPaths, ciAvailable, random }) {
  if (typeof random !== "number" || !Number.isFinite(random) || random < 0 || random >= 1) {
    throw new Error(`random must be a number in [0, 1), got ${JSON.stringify(random)}`);
  }
  const always = Array.isArray(policy?.always_paths) ? policy.always_paths : [];
  if (always.length > 0) {
    if (!Array.isArray(changedPaths)) return { selected: true, reason: "always_path", rate: 1, matched: null };
    const res = always.map(globToRegExp);
    const matched = changedPaths.find((p) => res.some((re) => re.test(p)));
    if (matched !== undefined) return { selected: true, reason: "always_path", rate: 1, matched };
  }
  const rate = ciAvailable === false ? policy.rate_when_ci_unavailable : policy.rate;
  if (rate === 0) return { selected: false, reason: "off", rate: 0, matched: null };
  if (random < rate) return { selected: true, reason: ciAvailable === false ? "ci_unavailable" : "rate", rate, matched: null };
  return { selected: false, reason: "not_selected", rate, matched: null };
}

/**
 * True when a job failed after it ran at least one step: a real failure.
 *
 * A job that never started (the billing-blocked shape: a failed conclusion,
 * zero steps, no runner) is not one. Neither is a `skipped` job downstream of
 * a real failure, which also has zero steps and no runner; its run is red
 * because of the upstream job, not because of it.
 *
 * @param {any} job
 * @returns {boolean}
 */
function failedAfterStart(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return (job?.conclusion === "failure" || job?.conclusion === "timed_out") && steps.length > 0;
}

/**
 * What one GitHub Actions workflow run proves about its commit.
 *
 *  - `green`: the run succeeded.
 *  - `red`: a job failed after it ran steps. A real failure.
 *  - `unverified`: the run proves nothing. The billing annotation is present
 *    on any job, the run conclusion is `startup_failure`, `cancelled`,
 *    `skipped`, `stale`, `action_required` or `neutral`, no failed job ran a
 *    step (the billing-blocked shape is a failed job with zero steps and no
 *    runner, under a run conclusion of plain `failure`), the jobs could not
 *    be read, or the run is missing or still running with no failed job yet.
 *
 * A run in progress is classified from its jobs: the contradiction job reads
 * its own run, which has not finished when it runs.
 *
 * @param {{ run: any, jobs?: any[]|null, annotations?: any[]|null }|null|undefined} input
 *   `run` is a `GET .../actions/runs/{id}` object, `jobs` its `.../jobs` list
 *   (null when unread), and `annotations` the check-run annotations of its
 *   jobs (null when unread).
 * @returns {"green"|"red"|"unverified"}
 */
export function classifyRun(input) {
  const run = input?.run;
  if (!isPlainObject(run)) return "unverified";
  const annotations = Array.isArray(input?.annotations) ? input.annotations : [];
  if (annotations.some((a) => BILLING_RE.test(String(a?.message ?? "")))) return "unverified";
  const jobs = Array.isArray(input?.jobs) ? input.jobs : null;

  if (run.status === "completed") {
    if (NOT_RUN_CONCLUSIONS.has(run.conclusion)) return "unverified";
    if (run.conclusion === "success") {
      // Jobs are only fetched for a run that did not succeed. When they are
      // known, a success where no job ran a single step proved nothing.
      if (jobs !== null && !jobs.some((j) => Array.isArray(j?.steps) && j.steps.length > 0)) return "unverified";
      return "green";
    }
  }
  if (jobs === null) return "unverified";
  if (jobs.some(failedAfterStart)) return "red";
  return "unverified";
}

/**
 * @typedef {object} MainStatus
 * @property {boolean} known False when the CI runs could not be read.
 * @property {string|null} lastGreen The newest commit with a green run.
 * @property {string[]} verified The last green commit and every older one.
 * @property {string[]} red Newer than the last green commit, with a red run.
 * @property {string[]} unverified Newer than the last green commit, with no
 *   green or red run: no run, or only unverified runs.
 * @property {string[]} unknown Every commit, when the runs could not be read.
 * @property {Array<{sha: string, pr: number|null, state: "verified"|"red"|"unverified"|"unknown",
 *                   run: "green"|"red"|"unverified"|null}>} commits
 */

/**
 * The verification state of recent default-branch commits.
 *
 * The cumulative rule: the branch is squash-merged and linear, so the tree at
 * a green commit contains every older commit, and the green run tested them
 * all. An older commit whose own run was red is therefore verified once a
 * newer commit is green; `commits[].run` still shows its own red run.
 *
 * `runs: null` means the runs could not be read (a rate limit, a missing
 * workflow, no Actions data). Then every commit is `unknown`, never verified.
 *
 * @param {{ commits: Array<{sha: string, pr: number|null}>,
 *           runs: Array<{headSha: string, state: "green"|"red"|"unverified"}>|null }} input
 *   `commits` newest first.
 * @returns {MainStatus}
 */
export function mainVerificationStatus({ commits, runs }) {
  const list = Array.isArray(commits) ? commits : [];
  if (!Array.isArray(runs)) {
    return {
      known: false,
      lastGreen: null,
      verified: [],
      red: [],
      unverified: [],
      unknown: list.map((c) => c.sha),
      commits: list.map((c) => ({ sha: c.sha, pr: c.pr ?? null, state: "unknown", run: null })),
    };
  }
  /** @type {Map<string, "green"|"red"|"unverified">} */
  const best = new Map();
  for (const r of runs) {
    const sha = String(r?.headSha ?? "").toLowerCase();
    const state = RUN_STATES.includes(r?.state) ? r.state : "unverified";
    const prior = best.get(sha);
    if (prior === undefined || RUN_RANK[state] > RUN_RANK[prior]) best.set(sha, state);
  }
  const greenIndex = list.findIndex((c) => best.get(String(c.sha).toLowerCase()) === "green");
  const out = { known: true, lastGreen: greenIndex === -1 ? null : list[greenIndex].sha, verified: [], red: [], unverified: [], unknown: [], commits: [] };
  list.forEach((c, i) => {
    const run = best.get(String(c.sha).toLowerCase()) ?? null;
    let state;
    if (greenIndex !== -1 && i >= greenIndex) state = "verified";
    else if (run === "red") state = "red";
    else state = "unverified";
    out[state].push(c.sha);
    out.commits.push({ sha: c.sha, pr: c.pr ?? null, state, run });
  });
  return out;
}

/**
 * True when a real failure contradicts a passing attestation.
 *
 * The attestation half is `hasCurrentAttestation`: a trusted, never-edited
 * comment carrying a valid, passing attestation for exactly this head. An
 * unverified run is never a contradiction, because it tested nothing.
 *
 * @param {{ testResult: "green"|"red"|"unverified",
 *           attestation: { comments: object[]|null, headSha: string, trustedAssociations?: string[] }|null }} input
 * @returns {boolean}
 */
export function isContradiction({ testResult, attestation }) {
  if (testResult !== "red" || !isPlainObject(attestation)) return false;
  return hasCurrentAttestation({
    comments: /** @type {any} */ (attestation.comments),
    headSha: attestation.headSha,
    trustedAssociations: /** @type {any} */ (attestation.trustedAssociations),
  });
}

/**
 * The hidden marker that makes the contradiction issue idempotent: one issue
 * per pull request and attested head.
 *
 * @param {{ pr: number, sha: string }} input
 * @returns {string}
 */
export function contradictionMarker({ pr, sha }) {
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("pull request number must be a positive integer");
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("sha must be a full 40-character SHA");
  return `<!-- dotbabel:attestation-contradicted pr=${pr} sha=${sha.toLowerCase()} -->`;
}

/**
 * The number of an existing issue that carries `marker`, or null.
 *
 * @param {Array<{number: number, body?: string|null}>|null|undefined} issues
 * @param {string} marker
 * @returns {number|null}
 */
export function findContradictionIssue(issues, marker) {
  if (!Array.isArray(issues)) return null;
  const hit = issues.find((i) => typeof i?.body === "string" && i.body.includes(marker));
  return hit ? hit.number : null;
}

/**
 * The issue that reports a contradicted attestation.
 *
 * @param {{ pr: number, attestedSha: string, mergeSha?: string|null, runUrl?: string|null, local?: boolean }} input
 * @returns {{ title: string, body: string, labels: string[] }}
 */
export function renderContradictionIssue({ pr, attestedSha, mergeSha = null, runUrl = null, local = false }) {
  const marker = contradictionMarker({ pr, sha: attestedSha });
  const failure = local
    ? "An explicit verification run of the pull request head failed. The run was local (same machine as the agent; weaker than CI)."
    : `The \`test\` workflow failed on the default branch${mergeSha ? ` at the merge commit \`${mergeSha}\`` : ""}.`;
  const lines = [
    marker,
    "",
    `A trusted, current attestation said the test matrix passed for #${pr}, but a real test run failed.`,
    "",
    `- Pull request: #${pr}`,
    `- Attested head: \`${attestedSha.toLowerCase()}\``,
    ...(mergeSha ? [`- Merge commit: \`${mergeSha}\``] : []),
    ...(runUrl ? [`- Failed run: ${runUrl}`] : []),
    "",
    failure,
    "",
    "One of two things is true: the attestation was not produced by a real run (a forged or hand-written comment), " +
      "or the tests behave differently between the attesting machine and this run (a flaky test or an environment " +
      "difference). Find out which before you trust another attestation from the same source.",
    "",
    "See docs/attestation.md, section \"Spot checks and the contradiction alarm\".",
  ];
  return { title: `Attestation contradicted: #${pr}`, body: `${lines.join("\n")}\n`, labels: [CONTRADICTION_LABEL] };
}

/**
 * The pull request number a squash merge appends to its subject, `(#N)`.
 *
 * @param {unknown} subject
 * @returns {number|null}
 */
export function mergeSubjectPr(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(String(subject ?? ""));
  return m ? Number(m[1]) : null;
}
