/**
 * The GitHub and git half of merge verification: every read that feeds
 * `spot-check`, `main-status` and `contradiction`, and the two writes of the
 * alarm (the label and the issue).
 *
 * Lives here rather than in the bin, behind a `deps.run` seam, for the same
 * reason `attestation-gate-inputs.mjs` does: the gather can then be tested
 * without a repository, a network, or a `gh` token. The decisions stay pure in
 * `merge-verification.mjs`; this file only reads facts and hands them over.
 *
 * One rule runs through it: data that could not be read is reported as
 * unknown (null, or the run state `unknown`), never as an empty answer and
 * never as "did not run". A function that cannot go on throws an
 * `InputError`; its `code` tells the bin which exit to use.
 *
 * Every command is an argv array, never a shell string.
 *
 * @typedef {{status: number, stdout: string, stderr: string}} RunResult
 * @typedef {{run: (argv: string[]) => RunResult}} InputDeps
 * @typedef {InputDeps & {post: (argv: string[], body: object) => any}} WriteDeps
 *   `post` sends `body` as JSON on stdin (`gh api --input -`), returns the
 *   parsed response, and throws on a non-zero exit.
 */

import { baseConfigAtRev } from "./attestation-gate-inputs.mjs";
import {
  CONTRADICTION_LABEL,
  ciAvailabilityState,
  classifyRun,
  findContradictionIssue,
  mergeSubjectPr,
} from "./merge-verification.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const WORKFLOW_FILE_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

/** A read that could not go on. `code` is `env` (exit 2) or `usage` (exit 64). */
export class InputError extends Error {
  /**
   * @param {"env"|"usage"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}

/**
 * `gh api <path>` parsed as JSON, or null on any failure. A rate limit, a 404
 * or a token without the scope all read as "unknown", never as an empty answer.
 *
 * @param {InputDeps} deps
 * @param {string} apiPath
 * @returns {any}
 */
export function ghApiJson(deps, apiPath) {
  const r = deps.run(["gh", "api", apiPath]);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * @param {string} workflow
 * @param {string} trunk
 * @returns {void}
 */
function assertWorkflowAndTrunk(workflow, trunk) {
  if (!WORKFLOW_FILE_RE.test(workflow)) throw new InputError("usage", `${JSON.stringify(workflow)} is not a workflow file name`);
  if (!REF_RE.test(trunk)) throw new InputError("usage", `${JSON.stringify(trunk)} is not a plain branch name`);
}

/**
 * `gh pr view <N> --json <fields>` and its head SHA.
 *
 * @param {InputDeps} deps
 * @param {number} prNumber
 * @param {string} fields The `--json` field list; must include `headRefOid`.
 * @returns {{ view: any, headSha: string }}
 */
export function readPrHead(deps, prNumber, fields) {
  const r = deps.run(["gh", "pr", "view", String(prNumber), "--json", fields]);
  if (r.status !== 0) throw new InputError("env", `could not read #${prNumber}:\n${r.stderr.trim()}`);
  let view;
  try {
    view = JSON.parse(r.stdout);
  } catch {
    throw new InputError("env", `could not parse gh pr view output for #${prNumber}`);
  }
  const headSha = String(view?.headRefOid ?? "");
  if (!FULL_SHA_RE.test(headSha)) throw new InputError("env", `#${prNumber} has no readable head SHA`);
  return { view, headSha };
}

/**
 * The repository's default branch, from `gh repo view`. The literal `main`
 * is not assumed: a repository whose default branch is `master` or `develop`
 * would then read no runs at all.
 *
 * @param {InputDeps} deps
 * @returns {string}
 */
export function defaultBranch(deps) {
  const r = deps.run(["gh", "repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  const name = r.stdout.trim();
  if (r.status !== 0 || !REF_RE.test(name)) {
    throw new InputError("env", `could not read the default branch; pass --trunk <branch>\n${r.stderr.trim()}`);
  }
  return name;
}

/**
 * Every path a pull request touches, or null when the list cannot be shown to
 * be complete: each changed file's path, and for a renamed file its old path
 * too. A rename out of an `always_paths` directory must still match it.
 *
 * Two reads. The first is checked against `changedFiles`, so a truncated list
 * cannot look like a small pull request. The second reads only the old paths
 * of renames, so it cannot be checked against that count.
 *
 * @param {InputDeps} deps
 * @param {number} prNumber
 * @param {unknown} declaredCount `changedFiles` from `gh pr view`.
 * @returns {string[]|null}
 */
export function prChangedPaths(deps, prNumber, declaredCount) {
  const filesPath = `repos/{owner}/{repo}/pulls/${prNumber}/files`;
  const lines = (r) =>
    r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const files = deps.run(["gh", "api", filesPath, "--paginate", "--jq", ".[].filename"]);
  if (files.status !== 0) return null;
  const paths = lines(files);
  const declared = Number(declaredCount);
  // GitHub's Files endpoint caps at 3000; at that size neither source is complete.
  if (!Number.isFinite(declared) || declared !== paths.length || declared >= 3000) return null;
  const renames = deps.run(["gh", "api", filesPath, "--paginate", "--jq", ".[] | select(.previous_filename) | .previous_filename"]);
  if (renames.status !== 0) return null;
  return [...new Set([...paths, ...lines(renames)])];
}

/**
 * Classify one workflow run. A successful run is taken at its word; any other
 * run has its jobs read, because only the jobs separate a real failure from a
 * run that never started. Annotations are not read (see `classifyRun`).
 *
 * @param {InputDeps} deps
 * @param {any} runObj A workflow run from the Actions API.
 * @returns {"green"|"red"|"unverified"|"unknown"}
 */
export function classifyWorkflowRun(deps, runObj) {
  if (!runObj || typeof runObj !== "object") return classifyRun(null);
  const succeeded = runObj.status === "completed" && runObj.conclusion === "success";
  if (succeeded || !Number.isInteger(runObj.id) || runObj.id <= 0) return classifyRun({ run: runObj, jobs: null });
  const resp = ghApiJson(deps, `repos/{owner}/{repo}/actions/runs/${runObj.id}/jobs?per_page=100`);
  const jobs = Array.isArray(resp?.jobs) ? resp.jobs : null;
  const state = classifyRun({ run: runObj, jobs });
  // A failed job past the first page could hide a red: an incomplete list
  // that shows no real failure is unread, not "did not run".
  const incomplete = jobs !== null && Number.isInteger(resp?.total_count) && resp.total_count > jobs.length;
  return state === "unverified" && incomplete ? "unknown" : state;
}

/**
 * Recent first-parent commits of `<remote>/<trunk>`, newest first, after a
 * best-effort fetch. Local git, not the API, so a rate limit cannot hide the
 * list; `fetched: false` says it may be stale.
 *
 * @param {InputDeps} deps
 * @param {{ remote: string, trunk: string, limit: number }} input
 * @returns {{ ref: string, fetched: boolean, commits: Array<{sha: string, pr: number|null, subject: string}> }}
 */
export function trunkCommits(deps, { remote, trunk, limit }) {
  const ref = `${remote}/${trunk}`;
  if (!REF_RE.test(ref)) throw new InputError("usage", `${JSON.stringify(ref)} is not a plain ref name`);
  const fetched = deps.run(["git", "fetch", "--quiet", remote, trunk]).status === 0;
  const log = deps.run(["git", "log", "--first-parent", `-n${limit}`, "--format=%H%x09%s", `${ref}^{commit}`, "--"]);
  if (log.status !== 0) throw new InputError("env", `cannot read ${ref}; run \`git fetch ${remote} ${trunk}\` and retry\n${log.stderr.trim()}`);
  return { ref, fetched, commits: parseLog(log.stdout) };
}

/**
 * @param {string} stdout `git log --format=%H%x09%s` output.
 * @returns {Array<{sha: string, pr: number|null, subject: string}>}
 */
function parseLog(stdout) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split("\t");
      const subject = rest.join("\t");
      return { sha: sha.toLowerCase(), pr: mergeSubjectPr(subject), subject };
    });
}

/**
 * First-parent history from `sha`, newest first, `sha` included. Read from
 * the local object store: the caller checks out enough history.
 *
 * @param {InputDeps} deps
 * @param {string} sha
 * @param {number} limit
 * @returns {Array<{sha: string, pr: number|null, subject: string}>}
 */
export function firstParentHistory(deps, sha, limit) {
  if (!FULL_SHA_RE.test(sha)) throw new InputError("usage", "the commit must be a full 40-character SHA");
  const log = deps.run(["git", "log", "--first-parent", `-n${limit}`, "--format=%H%x09%s", `${sha}^{commit}`, "--"]);
  if (log.status !== 0) throw new InputError("env", `cannot read the history of ${sha}; fetch more history and retry\n${log.stderr.trim()}`);
  return parseLog(log.stdout);
}

/**
 * Whether default-branch CI checks recent merges: the newest completed run of
 * the test workflow on `trunk`, accepted only when it tested one of
 * `recentShas`. See `ciAvailabilityState`.
 *
 * @param {InputDeps} deps
 * @param {{ workflow: string, trunk: string, recentShas: string[]|null }} input
 * @returns {{ state: "available"|"unavailable"|"unknown", available: boolean|null, reason: string,
 *             run: { id: number, url: string|null, headSha: string, classification: string }|null }}
 */
export function ciAvailability(deps, { workflow, trunk, recentShas }) {
  assertWorkflowAndTrunk(workflow, trunk);
  const resp = ghApiJson(deps, `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?branch=${trunk}&status=completed&per_page=1`);
  const runsRead = Array.isArray(resp?.workflow_runs);
  const latest = runsRead ? resp.workflow_runs[0] : undefined;
  const recent = new Set((recentShas ?? []).map((s) => s.toLowerCase()));
  const inRange = latest && recent.has(String(latest.head_sha ?? "").toLowerCase());
  const classification = inRange ? classifyWorkflowRun(deps, latest) : null;
  const decided = ciAvailabilityState({ recentShas, runsRead, latestRun: latest, classification });
  const run = latest
    ? { id: latest.id, url: latest.html_url ?? null, headSha: String(latest.head_sha ?? "").toLowerCase(), classification: classification ?? "not read" }
    : null;
  return { ...decided, run };
}

/**
 * The runs of `workflow` on `trunk` for the given commits, each classified, or
 * null when the runs list cannot be read. One page of the newest 100: an
 * older commit with no run in it has no run here.
 *
 * @param {InputDeps} deps
 * @param {{ workflow: string, trunk: string, shas: string[], classify?: (sha: string) => boolean }} input
 *   `classify`: which commits need their non-green runs classified (default
 *   all). A run left unclassified reads `green` when it succeeded, else
 *   `unverified`.
 * @returns {Array<{ headSha: string, state: "green"|"red"|"unverified"|"unknown" }>|null}
 */
export function workflowRunsFor(deps, { workflow, trunk, shas, classify = () => true }) {
  assertWorkflowAndTrunk(workflow, trunk);
  const resp = ghApiJson(deps, `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?branch=${trunk}&per_page=100`);
  if (!Array.isArray(resp?.workflow_runs)) return null;
  const wanted = new Set(shas.map((s) => s.toLowerCase()));
  return resp.workflow_runs
    .filter((r) => wanted.has(String(r?.head_sha ?? "").toLowerCase()))
    .map((r) => {
      const headSha = String(r.head_sha).toLowerCase();
      const succeeded = r.status === "completed" && r.conclusion === "success";
      const state = classify(headSha) ? classifyWorkflowRun(deps, r) : succeeded ? "green" : "unverified";
      return { headSha, state };
    });
}

/**
 * The trust list in force at `rev`: `attestation.trusted_associations` from
 * its `.dotbabel.json`, and where it came from.
 *
 * The contradiction reads it at a merge commit's FIRST PARENT, the base the
 * pull request merged into, and never at the merge commit, which the pull
 * request controls. A first parent with no `.dotbabel.json` uses the default
 * `["OWNER"]`. One that cannot be read or does not parse throws: a trust list
 * that silently became the default could hide the alarm.
 *
 * @param {InputDeps} deps
 * @param {string} rev A revision expression; resolved to a full SHA first.
 * @param {string} label How to name `rev` in `source`, such as "first parent".
 * @returns {{ list: string[], source: string }}
 */
export function trustListAt(deps, rev, label) {
  const resolved = deps.run(["git", "rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  const sha = resolved.stdout.trim();
  if (resolved.status !== 0 || !FULL_SHA_RE.test(sha)) {
    throw new InputError("env", `cannot read the ${label} (${rev}); fetch more history and retry`);
  }
  let cfg;
  try {
    cfg = /** @type {any} */ (baseConfigAtRev(deps, sha));
  } catch (err) {
    throw new InputError("env", `cannot read the trust list at the ${label}: ${err.message}`);
  }
  const at = `${label} ${sha.slice(0, 8)}`;
  if (cfg === undefined) return { list: ["OWNER"], source: `default OWNER (the ${at} has no .dotbabel.json)` };
  const list = cfg?.attestation?.trusted_associations;
  if (Array.isArray(list) && list.length > 0) return { list: list.map(String), source: `.dotbabel.json at the ${at}` };
  return { list: ["OWNER"], source: `default OWNER (.dotbabel.json at the ${at} sets no trusted_associations)` };
}

/**
 * The pull request merged as `sha`, or null when none was.
 *
 * @param {InputDeps} deps
 * @param {string} sha
 * @returns {{ number: number, headSha: string }|null}
 */
export function mergedPullFor(deps, sha) {
  const pulls = ghApiJson(deps, `repos/{owner}/{repo}/commits/${sha}/pulls`);
  if (!Array.isArray(pulls)) throw new InputError("env", `could not read the pull request merged as ${sha}`);
  const pr = pulls.find((p) => String(p?.merge_commit_sha ?? "").toLowerCase() === sha.toLowerCase());
  if (!pr) return null;
  const number = Number(pr.number);
  const headSha = String(pr?.head?.sha ?? "");
  if (!Number.isInteger(number) || number <= 0 || !FULL_SHA_RE.test(headSha)) {
    throw new InputError("env", `the pull request merged as ${sha} has no readable number or head`);
  }
  return { number, headSha: headSha.toLowerCase() };
}

/**
 * Ensure the contradiction label exists, then put it on the pull request.
 *
 * @param {WriteDeps} deps
 * @param {number} prNumber
 * @returns {void}
 */
export function labelContradicted(deps, prNumber) {
  if (deps.run(["gh", "api", `repos/{owner}/{repo}/labels/${CONTRADICTION_LABEL}`]).status !== 0) {
    try {
      deps.post(["gh", "api", "--method", "POST", "repos/{owner}/{repo}/labels", "--input", "-"], {
        name: CONTRADICTION_LABEL,
        color: "b60205",
        description: "A real test failure contradicted this pull request's passing attestation",
      });
    } catch {
      // Another run may have created it in between; the label POST below
      // fails loudly if it really does not exist.
    }
  }
  deps.post(["gh", "api", "--method", "POST", `repos/{owner}/{repo}/issues/${prNumber}/labels`, "--input", "-"], {
    labels: [CONTRADICTION_LABEL],
  });
}

/**
 * Open the contradiction issue unless one already carries its marker; reopen
 * a closed one with a comment.
 *
 * In GitHub Actions (`workflowOnly`), only an issue that the workflow
 * identity opened counts. The marker is public, so anyone with a token could
 * otherwise open and close a matching issue before the merge to silence it.
 *
 * @param {WriteDeps} deps
 * @param {{ issue: { title: string, body: string, labels: string[] }, marker: string, workflowOnly: boolean }} input
 * @returns {{ number: number|null, url: string|null, created: boolean, reopened: boolean }}
 */
export function openContradictionIssue(deps, { issue, marker, workflowOnly }) {
  const list = deps.run(["gh", "issue", "list", "--label", CONTRADICTION_LABEL, "--state", "all", "--limit", "500", "--json", "number,body,state,author"]);
  if (list.status !== 0) throw new Error(`could not list ${CONTRADICTION_LABEL} issues:\n${list.stderr.trim()}`);
  let existing;
  try {
    existing = findContradictionIssue(JSON.parse(list.stdout), marker, { workflowOnly });
  } catch {
    throw new Error(`could not parse the ${CONTRADICTION_LABEL} issue list`);
  }
  if (existing !== null) {
    if (!existing.closed) return { number: existing.number, url: null, created: false, reopened: false };
    const r = deps.run([
      "gh",
      "issue",
      "reopen",
      String(existing.number),
      "--comment",
      "Reopened: `dotbabel pr-stack contradiction` found this contradiction again.",
    ]);
    if (r.status !== 0) throw new Error(`could not reopen issue #${existing.number}:\n${r.stderr.trim()}`);
    return { number: existing.number, url: null, created: false, reopened: true };
  }
  const created = deps.post(["gh", "api", "--method", "POST", "repos/{owner}/{repo}/issues", "--input", "-"], issue);
  return { number: Number.isInteger(created?.number) ? created.number : null, url: created?.html_url ?? null, created: true, reopened: false };
}
