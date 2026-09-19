/**
 * review-complete — the sanctioned writer of the review-complete evidence
 * comment.
 *
 * Like `dotbabel criteria verify --post` and `dotbabel local-attest`, this is
 * the only thing meant to put its marker on a pull request, and it derives what
 * the marker claims from observable state instead of taking it on trust. It
 * posts only when the review stage has demonstrably finished on the current
 * head (see `evaluateReviewCompletion`), and it re-reads the head immediately
 * before posting, because a comment pinned to a commit that is no longer the
 * head would attest something nobody reviewed.
 *
 * All I/O comes in through `deps`, so every refusal is testable without `gh`.
 *
 * @typedef {object} Deps
 * @property {(argv: string[]) => {status: number, stdout: string, stderr: string}} run
 * @property {(argv: string[]) => string} capture Throws on a non-zero exit.
 * @property {(argv: string[], jsonBody: object) => void} ghApiWithInput
 * @property {(msg: string) => void} [log]
 */

import { postEvidenceComment } from "./criteria/comment.mjs";
import {
  REVIEW_MARKER_PREFIX,
  buildReviewPayload,
  checkReviewReceipt,
  evaluateReviewCompletion,
  renderReviewComment,
} from "./review-evidence.mjs";
import { commitIsAncestor, prReviewThreads, prReviews } from "./review-gate-inputs.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * @param {Deps} deps
 * @param {number} prNumber
 * @returns {{ headRefOid: string, state: string }}
 */
function readView(deps, prNumber) {
  const view = JSON.parse(deps.capture(["gh", "pr", "view", String(prNumber), "--json", "headRefOid,state"]));
  if (typeof view?.headRefOid !== "string" || !FULL_SHA_RE.test(view.headRefOid)) {
    throw new Error("the pull request head SHA could not be read");
  }
  return { headRefOid: view.headRefOid, state: String(view.state ?? "") };
}

/**
 * Post a review-complete comment for `prNumber` if, and only if, the review
 * stage is demonstrably finished on its current head.
 *
 * @param {Deps} deps
 * @param {{ prNumber: number,
 *           criteriaReasons: (prNumber: number, headSha: string) => Array<{code: string, message?: string}>,
 *           dryRun?: boolean, toolVersion?: string, now?: Date }} opts
 * @returns {{ ok: boolean, posted: boolean, env?: boolean, message?: string, headSha?: string,
 *             reviewedSha?: string, body?: string,
 *             reasons?: Array<{code: string, message: string}>,
 *             counts?: {findingsPosted: number, findingsUnresolved: number, otherOpenThreads: number} }}
 */
export function postReviewComplete(deps, { prNumber, criteriaReasons, dryRun = false, toolVersion, now }) {
  const env = (err) => ({ ok: false, posted: false, env: true, message: err instanceof Error ? err.message : String(err) });

  let view;
  let criteria;
  try {
    view = readView(deps, prNumber);
  } catch (err) {
    return env(err);
  }
  if (view.state !== "OPEN") {
    return {
      ok: false,
      posted: false,
      reasons: [{ code: "REVIEW_PR_NOT_OPEN", message: `the pull request is ${view.state || "not open"}` }],
    };
  }
  const headSha = view.headRefOid;

  const reviews = prReviews(deps, prNumber);
  const threads = prReviewThreads(deps, prNumber);
  try {
    criteria = criteriaReasons(prNumber, headSha);
  } catch (err) {
    return env(err);
  }

  const receipt = checkReviewReceipt({
    reviews,
    headSha,
    isAncestor: (oid, head) => commitIsAncestor(deps, oid, head),
  });
  const verdict = evaluateReviewCompletion({ receipt, threads, criteriaReasons: criteria });
  if (!verdict.ok) return { ok: false, posted: false, headSha, reasons: verdict.reasons, counts: verdict.counts };

  const payload = buildReviewPayload({
    headSha,
    reviewedSha: /** @type {string} */ (receipt.reviewedSha),
    findings: { posted: verdict.counts.findingsPosted, unresolved: verdict.counts.findingsUnresolved },
    otherOpenThreads: verdict.counts.otherOpenThreads,
    toolVersion,
    now,
  });
  const body = renderReviewComment(payload);
  const done = { ok: true, headSha, reviewedSha: payload.reviewed_sha, counts: verdict.counts, body };
  if (dryRun) return { ...done, posted: false };

  try {
    const again = readView(deps, prNumber).headRefOid;
    if (again.toLowerCase() !== headSha.toLowerCase()) {
      return {
        ok: false,
        posted: false,
        headSha,
        reasons: [
          {
            code: "REVIEW_HEAD_MOVED",
            message: `the head moved from ${headSha.slice(0, 8)} to ${again.slice(0, 8)} while the review was being checked`,
          },
        ],
      };
    }
    const repo = deps.capture(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
    postEvidenceComment(deps, { repo, pr: prNumber, body, markerPrefix: REVIEW_MARKER_PREFIX });
  } catch (err) {
    return env(err);
  }
  return { ...done, posted: true };
}
