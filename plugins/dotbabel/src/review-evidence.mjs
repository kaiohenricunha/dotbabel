/**
 * review-evidence — SHA-pinned proof that the review stage finished on a commit.
 *
 * `/pr-conductor` re-enters an open pull request at some phase. Until this
 * existed it could only re-enter at the start, because nothing SHA-pinned said
 * "the review already ran on this head": an attestation proves a commit passed
 * the matrix and says nothing about review, and `post-pr-review` markers are
 * not tied to a commit at all. Re-entering at the start re-dispatches the whole
 * review fleet, the most expensive and least deterministic work in the pipeline.
 *
 * The marker rides on a comment the same way the other two evidence families do
 * (`<!-- review-complete verified-sha=<40-hex> -->` on line 1, a base64url
 * payload on line 2), and is judged by the same rule: trusted author, never
 * edited, naming the exact head.
 *
 * What it proves is narrow and stated in the comment itself: a `post-pr-review`
 * receipt exists for an ancestor of the head, every finding that stage posted is
 * resolved, and the criteria half of the merge gate has no blocking reason. It
 * does not prove the review found everything. It is a skip signal for the
 * conductor, not a merge authorization, and `/merge-pr` does not read it.
 *
 * Pure: no I/O, no clock. Callers gather comments, reviews and threads and pass
 * them in, including the ancestry test, so every branch is testable directly.
 */

import { createMarker } from "./lib/attest-marker.mjs";
import { decodePayloadLine, encodePayloadLine } from "./lib/evidence-payload.mjs";

/** Line 1 of a review-complete comment. Byte-exact; the guard hook matches it. */
export const REVIEW_MARKER_PREFIX = "<!-- review-complete verified-sha=";

/** Line 2 of a review-complete comment. */
export const REVIEW_PAYLOAD_LINE_PREFIX = "<!-- review-complete-payload ";

/**
 * Line 1 of the review `post-pr-review` posts at the end of every run, findings
 * or none. It is what makes "the review ran" observable: a run that finds
 * nothing otherwise leaves no trace on the pull request at all.
 */
export const POST_PR_REVIEW_RECEIPT_MARKER = "<!-- post-pr-review:v1:receipt -->";

/** A finding comment's idempotency marker (`skills/post-pr-review/SKILL.md`). */
export const POST_PR_REVIEW_FINDING_RE = /<!--\s*post-pr-review:v1:[0-9a-f]{16}\s*-->/;

const marker = createMarker(REVIEW_MARKER_PREFIX);
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_TRUSTED = Object.freeze(["OWNER"]);

const isCount = (n) => Number.isInteger(n) && n >= 0;
const short = (sha) => String(sha).slice(0, 8);

/**
 * Build the payload for one review-complete comment.
 *
 * @param {{ headSha: string, reviewedSha: string, findings: {posted: number, unresolved: number},
 *           otherOpenThreads?: number, toolVersion?: string, now?: Date }} input
 * @returns {object}
 */
export function buildReviewPayload({ headSha, reviewedSha, findings, otherOpenThreads, toolVersion, now }) {
  return {
    schema_version: 1,
    tool: { name: "dotbabel", ...(toolVersion ? { version: toolVersion } : {}) },
    head_sha: headSha,
    reviewed_sha: reviewedSha,
    generated_at: (now ?? new Date()).toISOString(),
    findings: { posted: findings.posted, unresolved: findings.unresolved },
    other_open_threads: otherOpenThreads ?? 0,
  };
}

/**
 * Render the whole comment body: marker, payload, then text a person can read.
 *
 * @param {object} payload
 * @returns {string}
 */
export function renderReviewComment(payload) {
  const p = /** @type {any} */ (payload);
  return [
    marker.build(p.head_sha),
    encodePayloadLine(REVIEW_PAYLOAD_LINE_PREFIX, payload),
    "## Review complete",
    "",
    `The review stage finished on \`${short(p.head_sha)}\`. A \`post-pr-review\` receipt exists for \`${short(p.reviewed_sha)}\`, ` +
      `${p.findings.posted} finding(s) were posted and none is unresolved, and the criteria check has no blocking reason.`,
    "",
    "This marks the review stage as finished for this exact commit. It does not prove the review found everything, " +
      "and it stops counting as soon as the head moves. `/merge-pr` does not read it.",
  ].join("\n");
}

/**
 * @typedef {object} ParsedReview
 * @property {"ok"|"not-review"|"no-payload"|"undecodable"|"sha-mismatch"} state
 * @property {string|null} sha
 * @property {object|null} payload
 * @property {string|null} detail
 */

/**
 * Parse one comment body into its marker SHA and payload.
 *
 * @param {unknown} body
 * @returns {ParsedReview}
 */
export function parseReviewComment(body) {
  const sha = marker.parseSha(body);
  if (sha === null) return { state: "not-review", sha: null, payload: null, detail: null };

  const decoded = decodePayloadLine(REVIEW_PAYLOAD_LINE_PREFIX, body);
  if (decoded.state === "absent") return { state: "no-payload", sha, payload: null, detail: decoded.detail };
  if (decoded.state !== "ok") return { state: "undecodable", sha, payload: null, detail: decoded.detail };

  const payload = /** @type {any} */ (decoded.payload);
  if (payload.head_sha !== sha) {
    return {
      state: "sha-mismatch",
      sha,
      payload,
      detail: `payload head_sha ${payload.head_sha} does not match marker ${sha}`,
    };
  }
  return { state: "ok", sha, payload, detail: null };
}

/**
 * Shape-check a decoded payload against what the reader relies on.
 *
 * @param {unknown} payload
 * @returns {string|null} A reason it is unusable, or null.
 */
export function reviewPayloadProblem(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "payload is not an object";
  const p = /** @type {any} */ (payload);
  if (p.schema_version !== 1) return `unsupported schema_version: ${JSON.stringify(p.schema_version)}`;
  if (typeof p.head_sha !== "string" || !FULL_SHA_RE.test(p.head_sha)) return "head_sha is missing or malformed";
  if (typeof p.reviewed_sha !== "string" || !FULL_SHA_RE.test(p.reviewed_sha)) return "reviewed_sha is missing or malformed";
  const f = p.findings;
  if (f === null || typeof f !== "object" || !isCount(f.posted) || !isCount(f.unresolved)) {
    return "findings must carry non-negative integer posted and unresolved counts";
  }
  if (f.unresolved !== 0) return `payload records ${f.unresolved} unresolved finding(s); the producer never posts one`;
  return null;
}

/**
 * @typedef {object} Comment
 * @property {string} body
 * @property {string} authorAssociation
 * @property {string|null} [lastEditedAt]
 */

/**
 * @typedef {object} ReviewEvidence
 * @property {"reviewed"|"not-reviewed"} state
 * @property {"REVIEW_MISSING"|"REVIEW_UNTRUSTED"|"REVIEW_STALE"|"REVIEW_INVALID"|null} code
 * @property {string|null} sha
 * @property {string|null} detail
 * @property {object|null} [payload]
 */

/**
 * Decide whether a comment list proves the review stage finished on `headSha`.
 *
 * The ladder mirrors the attestation one and stops at the first rung that
 * fails, so the reported code is the one thing to fix next.
 *
 * @param {{ comments: Comment[]|null|undefined, headSha: unknown, trustedAssociations?: string[] }} input
 * @returns {ReviewEvidence}
 */
export function evaluateReviewEvidence({ comments, headSha, trustedAssociations }) {
  const no = (code, detail, sha = null) => ({ state: "not-reviewed", code, sha, detail, payload: null });
  if (!Array.isArray(comments)) return no("REVIEW_INVALID", "the comment list could not be read");
  if (typeof headSha !== "string" || !FULL_SHA_RE.test(headSha)) {
    return no("REVIEW_INVALID", "the pull request head SHA could not be read");
  }

  const candidates = comments
    .filter((c) => c && typeof c === "object")
    .map((c) => ({ c, parsed: parseReviewComment(c.body) }))
    .filter((x) => x.parsed.sha !== null);
  if (candidates.length === 0) return no("REVIEW_MISSING", "no review-complete comment exists for this pull request");

  const trusted = new Set(trustedAssociations ?? DEFAULT_TRUSTED);
  const believed = candidates.filter((x) => trusted.has(x.c.authorAssociation) && (x.c.lastEditedAt ?? null) === null);
  if (believed.length === 0) {
    return no("REVIEW_UNTRUSTED", "no review-complete comment has both a trusted author association and no edit");
  }

  const current = believed.filter((x) => x.parsed.sha.toLowerCase() === headSha.toLowerCase());
  if (current.length === 0) {
    const seen = believed[believed.length - 1].parsed.sha;
    return no("REVIEW_STALE", `reviewed ${short(seen)}; current ${short(headSha)}`, seen);
  }

  let firstProblem = null;
  for (let i = current.length - 1; i >= 0; i -= 1) {
    const { parsed } = current[i];
    const problem = parsed.state !== "ok" ? (parsed.detail ?? parsed.state) : reviewPayloadProblem(parsed.payload);
    if (problem === null) {
      return { state: "reviewed", code: null, sha: parsed.sha, detail: null, payload: parsed.payload };
    }
    firstProblem ??= problem;
  }
  return no("REVIEW_INVALID", firstProblem, headSha);
}

/**
 * @typedef {object} ReviewObject
 * @property {string} body
 * @property {string} authorAssociation
 * @property {string|null} [lastEditedAt]
 * @property {string|null} [commitOid]
 */

/**
 * Find the `post-pr-review` receipt that shows the review ran on this pull
 * request: trusted, never edited, first-line marker, and posted against a
 * commit that is an ancestor of (or equal to) the head.
 *
 * Ancestry is injected so this stays pure. A receipt for a commit that is not
 * an ancestor belongs to some other history and proves nothing about this head.
 *
 * @param {{ reviews: ReviewObject[]|null, headSha: string,
 *           isAncestor: ((oid: string, headSha: string) => boolean)|undefined,
 *           trustedAssociations?: string[] }} input
 * @returns {{ ok: boolean, reviewedSha: string|null, code: string|null, detail: string|null }}
 */
export function checkReviewReceipt({ reviews, headSha, isAncestor, trustedAssociations }) {
  const fail = (code, detail) => ({ ok: false, reviewedSha: null, code, detail });
  if (!Array.isArray(reviews)) return fail("REVIEW_UNREADABLE", "the pull request reviews could not be read");
  if (typeof isAncestor !== "function") return fail("REVIEW_UNREADABLE", "commit ancestry could not be checked");

  const trusted = new Set(trustedAssociations ?? DEFAULT_TRUSTED);
  const receipts = reviews.filter(
    (r) =>
      r &&
      typeof r.body === "string" &&
      r.body.split("\n")[0].trimEnd() === POST_PR_REVIEW_RECEIPT_MARKER &&
      trusted.has(r.authorAssociation) &&
      (r.lastEditedAt ?? null) === null,
  );

  let foreign = null;
  for (let i = receipts.length - 1; i >= 0; i -= 1) {
    const oid = receipts[i].commitOid;
    if (typeof oid !== "string" || !FULL_SHA_RE.test(oid)) continue;
    let ancestor;
    try {
      ancestor = isAncestor(oid, headSha);
    } catch (err) {
      return fail("REVIEW_UNREADABLE", `commit ancestry could not be checked: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ancestor) return { ok: true, reviewedSha: oid, code: null, detail: null };
    foreign ??= oid;
  }
  return fail(
    "REVIEW_NO_RECEIPT",
    foreign
      ? `the only post-pr-review receipt is for ${short(foreign)}, which is not an ancestor of the head`
      : "no trusted post-pr-review receipt exists for this pull request",
  );
}

/**
 * Judge whether the review stage is complete, from facts the caller gathered.
 *
 * Only a finding the review stage itself posted can block: those are the
 * threads it owes a fix or a reply. Advisory threads (opened for a human) and
 * human threads are counted and recorded, never blocking, because the review
 * skill leaves the advisory ones open on purpose.
 *
 * @param {{ receipt: {ok: boolean, code: string|null, detail: string|null},
 *           threads: Array<{isResolved: boolean, rootBody: string}>|null,
 *           criteriaReasons: Array<{code: string}> }} input
 * @returns {{ ok: boolean, reasons: Array<{code: string, message: string}>,
 *             counts: {findingsPosted: number, findingsUnresolved: number, otherOpenThreads: number} }}
 */
export function evaluateReviewCompletion({ receipt, threads, criteriaReasons }) {
  /** @type {Array<{code: string, message: string}>} */
  const reasons = [];
  const counts = { findingsPosted: 0, findingsUnresolved: 0, otherOpenThreads: 0 };

  if (!receipt.ok) {
    reasons.push({ code: receipt.code ?? "REVIEW_NO_RECEIPT", message: receipt.detail ?? "no post-pr-review receipt" });
  }

  if (!Array.isArray(threads)) {
    reasons.push({ code: "REVIEW_UNREADABLE", message: "the pull request review threads could not be read" });
  } else {
    for (const t of threads) {
      const isFinding = POST_PR_REVIEW_FINDING_RE.test(String(t?.rootBody ?? ""));
      if (isFinding) counts.findingsPosted += 1;
      if (t?.isResolved) continue;
      if (isFinding) counts.findingsUnresolved += 1;
      else counts.otherOpenThreads += 1;
    }
    if (counts.findingsUnresolved > 0) {
      reasons.push({
        code: "REVIEW_FINDINGS_OPEN",
        message: `${counts.findingsUnresolved} finding thread(s) posted by post-pr-review are still unresolved`,
      });
    }
  }

  if (criteriaReasons.length > 0) {
    reasons.push({
      code: "REVIEW_CRITERIA_BLOCKED",
      message: `the criteria check reports ${criteriaReasons.map((r) => r.code).join(", ")}`,
    });
  }

  return { ok: reasons.length === 0, reasons, counts };
}
