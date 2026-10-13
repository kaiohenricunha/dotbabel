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
 *    anyway. The roll comes from the head SHA, so it is fixed for a head; a
 *    new roll needs a new head, and a new head already invalidates the
 *    attestation. The rate can still change with the CI state and the base
 *    policy, so the bin keeps a selection sticky for its head.
 *  - The CUMULATIVE RULE. The default branch is squash-merged and linear, so a
 *    green CI run on commit X verifies X and every older commit. Commits newer
 *    than the last green run are debt.
 *  - The CONTRADICTION. A real test failure on code whose attestation said
 *    pass is the evidence this layer detects, and it is raised as an alarm.
 *    It is not proof of a forgery, and a forgery can avoid it: see the limits
 *    in docs/attestation.md.
 *
 * A run that did not run is never a failure and never a pass. Private
 * repositories hit the GitHub Actions spending limit, and then the run fails
 * with no step executed. That run is `unverified`: it proves nothing either
 * way, so it can neither verify a commit nor contradict an attestation. A run
 * that could not be READ is `unknown`, which is different: the caller must
 * report it, and never read it as "did not run".
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

/**
 * What one CI run proves about its commit. `unknown` is "could not be read"
 * (a rate limit, a 5xx, a token without `actions: read`), never "did not run".
 */
export const RUN_STATES = Object.freeze(["green", "red", "unverified", "unknown"]);

/** The label put on a pull request whose attestation a real failure contradicted. */
export const CONTRADICTION_LABEL = "attestation-contradicted";

/** How many recent first-parent default-branch commits a CI sample must fall in. */
export const RECENT_TRUNK_COMMITS = 10;

/** How many first-parent commits the contradiction walks back, at most. */
export const CONTRADICTION_RANGE_LIMIT = 20;

/**
 * The frozen dependency install for each lockfile, in the order they are
 * tried. The same table as the explicit path of /merge-pr step 6, which a
 * test keeps in step.
 */
export const LOCKFILE_INSTALLS = Object.freeze([
  Object.freeze(["package-lock.json", Object.freeze(["npm", "ci"])]),
  Object.freeze(["pnpm-lock.yaml", Object.freeze(["pnpm", "i", "--frozen-lockfile"])]),
  Object.freeze(["yarn.lock", Object.freeze(["yarn", "--immutable"])]),
  Object.freeze(["go.sum", Object.freeze(["go", "mod", "download"])]),
  Object.freeze(["uv.lock", Object.freeze(["uv", "sync"])]),
]);

// The logins GitHub gives the workflow identity: REST, then `gh --json author`.
const WORKFLOW_LOGINS = new Set(["github-actions[bot]", "app/github-actions"]);
const JS_LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
const SPOT_CHECK_KEYS = new Set(Object.keys(SPOT_CHECK_DEFAULTS));
const SHA_RE = /^[0-9a-f]{40}$/i;
// The glob dialect `globToRegExp` reads literally. A pattern written for a
// richer dialect would silently match nothing, so it is refused instead.
const UNSUPPORTED_GLOB_CHARS = /[!{}[\]]/;
// A readable red beats an unreadable run; an unreadable run beats one that
// proves nothing, because it may hide a red.
const RUN_RANK = { green: 4, red: 3, unknown: 2, unverified: 1 };

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
  const off = { ...SPOT_CHECK_OFF, always_paths: [] };
  if (!isPlainObject(config) || !("attestation" in config)) return off;
  const attestation = config.attestation;
  if (!isPlainObject(attestation)) throw new Error("attestation must be an object");
  if (!("spot_check" in attestation)) return off;
  const block = attestation.spot_check;
  if (!isPlainObject(block)) throw new Error("attestation.spot_check must be an object");
  const unknown = Object.keys(block).find((k) => !SPOT_CHECK_KEYS.has(k));
  if (unknown !== undefined) throw new Error(`attestation.spot_check has unknown key ${JSON.stringify(unknown)}`);
  const out = { ...SPOT_CHECK_DEFAULTS, always_paths: [] };
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
 * True when a policy can never select anything: both rates are 0 and no
 * `always_paths` is set. The bin then decides `off` before it reads the
 * changed files or the CI runs, and records nothing.
 *
 * @param {{ rate: number, rate_when_ci_unavailable: number, always_paths: string[] }} policy
 * @returns {boolean}
 */
export function isSpotCheckOff(policy) {
  const always = Array.isArray(policy?.always_paths) ? policy.always_paths : [];
  return policy?.rate === 0 && policy?.rate_when_ci_unavailable === 0 && always.length === 0;
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
 * A job that never started is not one: a failed, `startup_failure` or
 * `cancelled` conclusion with zero steps and no runner. That is the
 * billing-blocked shape. A `skipped` job downstream of a real failure also has
 * zero steps and no runner; its run is red because of the upstream job.
 *
 * @param {any} job
 * @returns {boolean}
 */
function failedAfterStart(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return (job?.conclusion === "failure" || job?.conclusion === "timed_out") && steps.length > 0;
}

/**
 * @param {any} job
 * @returns {boolean}
 */
function ranAStep(job) {
  return Array.isArray(job?.steps) && job.steps.length > 0;
}

/**
 * What one GitHub Actions workflow run proves about its commit.
 *
 *  - `red`: a job failed after it ran at least one step. A real failure,
 *    whatever the run conclusion says (a run cancelled after a job failed is
 *    still red).
 *  - `green`: the run succeeded.
 *  - `unverified`: the run proves nothing. No failed job ran a step: the
 *    billing-blocked shape (a failed job with zero steps and no runner, under
 *    a plain `failure` run conclusion), a startup failure, a cancelled or
 *    skipped run, or a run still in progress with no failed job yet.
 *  - `unknown`: the run or its jobs could not be read.
 *
 * Annotations are not read. A billing annotation said nothing that the zero
 * steps did not, and a test reporter can write the word "billing" into an
 * annotation of a real failure.
 *
 * A run in progress is classified from its jobs: the contradiction job reads
 * its own run, which has not finished when it runs.
 *
 * @param {{ run: any, jobs?: any[]|null }|null|undefined} input
 *   `run` is a `GET .../actions/runs/{id}` object, and `jobs` its `.../jobs`
 *   list, or null when it was not read (a successful run) or could not be.
 * @returns {"green"|"red"|"unverified"|"unknown"}
 */
export function classifyRun(input) {
  const run = input?.run;
  if (!isPlainObject(run)) return "unknown";
  const jobs = Array.isArray(input?.jobs) ? input.jobs : null;
  if (run.status === "completed" && run.conclusion === "success") {
    // Jobs are only fetched for a run that did not succeed. When they are
    // known, a success where no job ran a single step proved nothing.
    return jobs !== null && !jobs.some(ranAStep) ? "unverified" : "green";
  }
  if (jobs === null) return "unknown";
  return jobs.some(failedAfterStart) ? "red" : "unverified";
}

/**
 * Whether the default branch's CI checks recent merges, from its newest
 * COMPLETED run of the test workflow.
 *
 * That run counts only when it tested one of the last `RECENT_TRUNK_COMMITS`
 * first-parent commits. An old green run says nothing about recent merges that
 * had no push run (a CI-skip marker, a path filter, a billing limit), so then
 * CI is `unavailable`: nothing off the machine checked them. "Could not read"
 * is `unknown`, never `available`.
 *
 * @param {{ recentShas: string[]|null, runsRead: boolean, latestRun?: any, classification?: string|null }} input
 *   `recentShas`: the recent first-parent commits, or null when unread.
 *   `runsRead`: false when the runs list could not be read. `latestRun`: the
 *   newest completed run, or undefined when there is none. `classification`:
 *   `classifyRun` of that run, needed only when it is in range.
 * @returns {{ state: "available"|"unavailable"|"unknown", available: boolean|null, reason: string }}
 */
export function ciAvailabilityState({ recentShas, runsRead, latestRun, classification = null }) {
  const unknown = (reason) => ({ state: /** @type {const} */ ("unknown"), available: null, reason });
  const unavailable = (reason) => ({ state: /** @type {const} */ ("unavailable"), available: false, reason });
  if (!Array.isArray(recentShas) || recentShas.length === 0) return unknown("the recent default-branch commits could not be read");
  if (!runsRead) return unknown("the workflow runs could not be read");
  if (!isPlainObject(latestRun)) return unavailable("no completed run on the default branch");
  const recent = new Set(recentShas.map((sha) => String(sha).toLowerCase()));
  const tested = String(latestRun.head_sha ?? "").toLowerCase();
  if (!recent.has(tested)) {
    return unavailable(`the newest completed run tested ${tested.slice(0, 8) || "no commit"}, not one of the last ${recentShas.length} commits`);
  }
  if (classification === "unknown" || !RUN_STATES.includes(/** @type {any} */ (classification))) {
    return unknown("the newest completed run could not be read");
  }
  if (classification === "unverified") return unavailable("the newest completed run did not run the tests");
  return { state: "available", available: true, reason: `the newest completed run is ${classification}` };
}

/**
 * The frozen installs for the lockfiles present in a checkout: the first
 * JavaScript lockfile found, then `go.sum`, then `uv.lock`. Empty when none is
 * present; the caller then installs nothing and says so.
 *
 * @param {Iterable<string>} lockfiles The lockfile names present.
 * @returns {Array<{ lockfile: string, argv: string[] }>}
 */
export function installCommandsFor(lockfiles) {
  const present = new Set(lockfiles);
  const out = [];
  let js = false;
  for (const [lockfile, argv] of LOCKFILE_INSTALLS) {
    if (!present.has(lockfile)) continue;
    if (JS_LOCKFILES.has(lockfile)) {
      if (js) continue;
      js = true;
    }
    out.push({ lockfile, argv: [...argv] });
  }
  return out;
}

/**
 * @typedef {object} MainStatus
 * @property {boolean} known False when the CI runs could not be read.
 * @property {string|null} lastGreen The newest commit with a green run.
 * @property {string[]} verified The last green commit and every older one.
 * @property {string[]} red Newer than the last green commit, with a red run.
 * @property {string[]} unverified Newer than the last green commit, with no
 *   green, red or unreadable run: no run, or only unverified runs.
 * @property {string[]} unknown Newer than the last green commit, with a run
 *   that could not be read and no green or red run; every commit when the
 *   runs list itself could not be read.
 * @property {Array<{sha: string, pr: number|null, state: "verified"|"red"|"unverified"|"unknown",
 *                   run: "green"|"red"|"unverified"|"unknown"|null}>} commits
 */

/**
 * The strongest state each commit's runs show: green, then red, then
 * unknown, then unverified. A readable red beats an unreadable run, and an
 * unreadable run beats one that proves nothing, because it may hide a red.
 *
 * @param {Array<{headSha: string, state: string}>} runs
 * @returns {Map<string, "green"|"red"|"unverified"|"unknown">} Keyed by lowercase SHA.
 */
export function bestRunStates(runs) {
  /** @type {Map<string, "green"|"red"|"unverified"|"unknown">} */
  const best = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    const sha = String(r?.headSha ?? "").toLowerCase();
    const state = RUN_STATES.includes(/** @type {any} */ (r?.state)) ? /** @type {any} */ (r.state) : "unverified";
    const prior = best.get(sha);
    if (prior === undefined || RUN_RANK[state] > RUN_RANK[prior]) best.set(sha, state);
  }
  return best;
}

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
 * One run that could not be read makes its commit `unknown` unless the commit
 * also has a readable green or red run. Unknown commits newer than the last
 * green run are debt, like red and unverified ones.
 *
 * @param {{ commits: Array<{sha: string, pr: number|null}>,
 *           runs: Array<{headSha: string, state: "green"|"red"|"unverified"|"unknown"}>|null }} input
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
  const best = bestRunStates(runs);
  const greenIndex = list.findIndex((c) => best.get(String(c.sha).toLowerCase()) === "green");
  const out = { known: true, lastGreen: greenIndex === -1 ? null : list[greenIndex].sha, verified: [], red: [], unverified: [], unknown: [], commits: [] };
  list.forEach((c, i) => {
    const run = best.get(String(c.sha).toLowerCase()) ?? null;
    let state;
    if (greenIndex !== -1 && i >= greenIndex) state = "verified";
    else if (run === "red" || run === "unknown") state = run;
    else state = "unverified";
    out[state].push(c.sha);
    out.commits.push({ sha: c.sha, pr: c.pr ?? null, state, run });
  });
  return out;
}

/**
 * Whether a pull request carries a trusted, passing attestation for `headSha`,
 * and whether every such comment was edited after it was posted.
 *
 * The merge gate refuses an edited comment, because edited text is not what
 * the tool wrote. This check counts one anyway. The gate accepted the comment
 * at merge time, so an edit after the merge is itself a warning sign, and one
 * edit must not silence the alarm. A deleted comment, or an edit that removes
 * the attestation, still silences it: that is a stated limit.
 *
 * @param {{ comments: object[]|null, headSha: string, trustedAssociations?: string[] }|null|undefined} attestation
 * @returns {{ found: boolean, edited: boolean }}
 */
export function attestationMatch(attestation) {
  if (!isPlainObject(attestation) || !Array.isArray(attestation.comments)) return { found: false, edited: false };
  const hits = attestation.comments.filter(
    (c) =>
      isPlainObject(c) &&
      hasCurrentAttestation({
        comments: /** @type {any} */ ([{ ...c, lastEditedAt: null }]),
        headSha: attestation.headSha,
        trustedAssociations: /** @type {any} */ (attestation.trustedAssociations),
      }),
  );
  if (hits.length === 0) return { found: false, edited: false };
  return { found: true, edited: hits.every((c) => (/** @type {any} */ (c).lastEditedAt ?? null) !== null) };
}

/**
 * True when a real failure contradicts a passing attestation: the run is
 * `red`, and `attestationMatch` finds a trusted, passing attestation for the
 * head, edited or not. An unverified or unknown run is never a contradiction,
 * because it tested nothing that anyone saw.
 *
 * @param {{ testResult: "green"|"red"|"unverified"|"unknown",
 *           attestation: { comments: object[]|null, headSha: string, trustedAssociations?: string[] }|null }} input
 * @returns {boolean}
 */
export function isContradiction({ testResult, attestation }) {
  return testResult === "red" && attestationMatch(attestation).found;
}

/**
 * The first-parent range a red run on the default branch can blame.
 *
 * A green run on commit G verifies G and every older commit (the cumulative
 * rule). So a red run on X can come from X or from any commit after G that
 * had no run of its own: a CI-skip marker, a cancelled run, a billing limit.
 * The range is X back to G, not including G, and at most `limit` commits.
 *
 * @param {{ commits: Array<{sha: string}>, greenShas: Set<string>, limit?: number }} input
 *   `commits`: first-parent history newest first, starting at the failing
 *   commit. `greenShas`: lowercase SHAs with a green run.
 * @returns {{ commits: Array<{sha: string}>, lastGreen: string|null, bounded: boolean }}
 *   `bounded` is true when the walk stopped at `limit` with no green run.
 */
export function contradictionRange({ commits, greenShas, limit = CONTRADICTION_RANGE_LIMIT }) {
  const list = Array.isArray(commits) ? commits : [];
  const range = [];
  for (const [i, c] of list.entries()) {
    if (i > 0 && greenShas.has(String(c.sha).toLowerCase())) return { commits: range, lastGreen: c.sha, bounded: false };
    if (range.length === limit) return { commits: range, lastGreen: null, bounded: true };
    range.push(c);
  }
  return { commits: range, lastGreen: null, bounded: false };
}

/**
 * The hidden marker of a local contradiction issue: one issue per pull
 * request and attested head.
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
 * The hidden marker of a default-branch contradiction issue: one issue per
 * failing commit, whatever the number of suspects.
 *
 * @param {string} sha The default-branch commit whose run failed.
 * @returns {string}
 */
export function failingCommitMarker(sha) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new Error("sha must be a full 40-character SHA");
  return `<!-- dotbabel:attestation-contradicted commit=${sha.toLowerCase()} -->`;
}

/**
 * True when an issue author is the GitHub Actions workflow identity.
 *
 * @param {unknown} author `{ login }` from the REST API or `gh --json author`.
 * @returns {boolean}
 */
export function isWorkflowAuthor(author) {
  return isPlainObject(author) && WORKFLOW_LOGINS.has(String(author.login ?? ""));
}

/**
 * The existing issue that carries `marker`, or null.
 *
 * The marker is public and its values are known before the merge, so in CI
 * (`workflowOnly`) only an issue that the workflow identity opened counts.
 * Anyone else could open and close one in advance to silence the alarm.
 *
 * @param {Array<{number: number, body?: string|null, state?: string, author?: unknown}>|null|undefined} issues
 * @param {string} marker
 * @param {{ workflowOnly?: boolean }} [options]
 * @returns {{ number: number, closed: boolean }|null}
 */
export function findContradictionIssue(issues, marker, { workflowOnly = false } = {}) {
  if (!Array.isArray(issues)) return null;
  const hit = issues.find(
    (i) => typeof i?.body === "string" && i.body.includes(marker) && (!workflowOnly || isWorkflowAuthor(i.author)),
  );
  return hit ? { number: hit.number, closed: String(hit.state ?? "").toUpperCase() === "CLOSED" } : null;
}

// Short sentences, no pull request text: only numbers, SHAs and a run URL
// reach the issue, so nothing in it can be injected.
const POSSIBLE_CAUSES = [
  "Possible causes:",
  "",
  "- The attestation is forged or wrong. A real run did not produce it.",
  "- A test is flaky, or the attesting machine and this run differ.",
  "- The merged tree differs from the attested head. A squash merge applies the diff to the base as it was at merge time.",
  "",
  "Find the cause before you trust another attestation from the same source.",
];
const EDITED_NOTE = "The attestation comment was edited after it was posted.";
const SEE_ALSO = 'See "Spot checks and the contradiction alarm" in the dotbabel attestation guide (docs/attestation.md).';

/**
 * The issue that reports a contradiction on the default branch: one failing
 * commit, the range it can blame, and every suspect in that range.
 *
 * @param {{ failingSha: string, runUrl?: string|null,
 *           range: { commits: Array<{sha: string}>, lastGreen: string|null, bounded: boolean },
 *           suspects: Array<{ pr: number, attestedSha: string, mergeSha: string, edited: boolean }> }} input
 * @returns {{ title: string, body: string, labels: string[] }}
 */
export function renderContradictionIssue({ failingSha, runUrl = null, range, suspects }) {
  const failing = failingSha.toLowerCase();
  const count = range.commits.length;
  let span;
  if (range.lastGreen) span = `\`${failing}\` back to the last green commit \`${range.lastGreen.toLowerCase()}\` (not included), ${count} commit(s)`;
  else if (range.bounded) span = `\`${failing}\` and the ${count - 1} commit(s) before it. No green run was found, and the walk stops at ${count} commit(s)`;
  else span = `\`${failing}\` back to the start of the history, ${count} commit(s). No green run was found`;
  const lines = [
    failingCommitMarker(failing),
    "",
    "A real test run failed on the default branch. A pull request in the untested range had a trusted attestation that said the tests passed.",
    "",
    `- Failing commit: \`${failing}\``,
    ...(runUrl ? [`- Failed run: ${runUrl}`] : []),
    `- Range: ${span}.`,
    "",
    "A green run verifies its commit and every older commit, so this range holds every commit that no run tested.",
    "",
    "Suspects:",
    "",
    ...suspects.map(
      (s) =>
        `- #${s.pr}: attested head \`${s.attestedSha.toLowerCase()}\`, merged as \`${s.mergeSha.toLowerCase()}\`.` +
        (s.edited ? ` ${EDITED_NOTE}` : ""),
    ),
    "",
    ...POSSIBLE_CAUSES,
    "",
    SEE_ALSO,
  ];
  const prs = suspects.map((s) => `#${s.pr}`).join(", ");
  return { title: `Attestation contradicted: ${failing.slice(0, 8)} (${prs})`, body: `${lines.join("\n")}\n`, labels: [CONTRADICTION_LABEL] };
}

/**
 * The issue that reports a contradiction found by an explicit run on this
 * machine, before the merge.
 *
 * @param {{ pr: number, attestedSha: string, edited?: boolean }} input
 * @returns {{ title: string, body: string, labels: string[] }}
 */
export function renderLocalContradictionIssue({ pr, attestedSha, edited = false }) {
  const lines = [
    contradictionMarker({ pr, sha: attestedSha }),
    "",
    `A trusted attestation said the test matrix passed for #${pr}, but a real test run failed.`,
    "",
    `- Pull request: #${pr}`,
    `- Attested head: \`${attestedSha.toLowerCase()}\``,
    ...(edited ? [`- ${EDITED_NOTE}`] : []),
    "",
    "An explicit verification run of the pull request head failed. The run was local (same machine as the agent; weaker than CI).",
    "",
    ...POSSIBLE_CAUSES,
    "",
    SEE_ALSO,
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
