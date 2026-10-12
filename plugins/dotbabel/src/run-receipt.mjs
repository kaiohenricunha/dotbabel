/**
 * run-receipt — the append-only record of one pull request's conductor runs.
 *
 * The SHA-pinned evidence comments say WHAT passed. They do not say how the
 * pull request got there: which phases ran, how often each one failed before
 * it passed, on which heads, with which skill model, and where to roll back
 * to. The receipt keeps that history outside the conversation, so a resumed
 * session, a later audit, or a comparison of two models can read it.
 *
 * It is SELF-REPORTED: the conductor records each outcome it observed, and
 * nothing here checks that outcome against the evidence comments. It is a log,
 * never evidence. The merge gate does not read it, and it must not.
 *
 * Every export is pure. The bin reads and writes the file; this module only
 * builds, extends, validates, and summarizes the value. A field nobody can
 * know stays null — the receipt never invents a model route, a cost, or a
 * token count it did not observe.
 *
 * @typedef {"pass"|"fail"|"blocked"|"skipped"} ReceiptOutcome
 *
 * @typedef {object} ReceiptAttempt
 * @property {string} phase One of `CONDUCTOR_PHASES[].id`.
 * @property {number} n 1-based attempt number within the phase.
 * @property {string} at ISO time the attempt was recorded.
 * @property {string} head_sha The pull request head the attempt ran on.
 * @property {string|null} base_ref
 * @property {string|null} merge_base The rollback point at that time.
 * @property {ReceiptOutcome} outcome
 * @property {string|null} reason_code
 * @property {string[]} evidence Links to the evidence the phase produced.
 * @property {string|null} requested_model The phase artifact's frontmatter `model`.
 * @property {string|null} tool_version
 *
 * @typedef {object} RunReceipt
 * @property {1} schema_version
 * @property {"dotbabel-pr-stack"} tool
 * @property {number} pr
 * @property {string} created_at
 * @property {string} updated_at
 * @property {ReceiptAttempt[]} attempts
 *
 * @typedef {object} PhaseSummary
 * @property {number} attempts
 * @property {ReceiptOutcome} last_outcome
 * @property {number} consecutive_failures Failed or blocked attempts since the
 *   phase last passed. A skipped attempt neither counts nor resets the run.
 */

import path from "node:path";

import { CONDUCTOR_PHASES } from "./pr-gates.mjs";

/** The outcomes an attempt may record. */
export const RECEIPT_OUTCOMES = Object.freeze(["pass", "fail", "blocked", "skipped"]);

/** Where receipts live, relative to the git common directory. */
export const RECEIPT_DIR = path.join("dotbabel", "receipts");

const PHASE_IDS = CONDUCTOR_PHASES.map((p) => p.id);
// Input SHAs may be any case; stored ones are lowercase, as the schema says.
const SHA_RE = /^[0-9a-f]{40}$/i;
const STORED_SHA_RE = /^[0-9a-f]{40}$/;
const REASON_RE = /^[A-Z][A-Z0-9_]*$/;
// The strings the receipt prints back into a session's context carry no
// whitespace or control characters, so a planted value cannot pose as output.
const BASE_REF_RE = /^[A-Za-z0-9._/-]+$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;
const EVIDENCE_RE = /^\S+$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const FAILED = new Set(["fail", "blocked"]);
const RECEIPT_KEYS = new Set(["schema_version", "tool", "pr", "created_at", "updated_at", "attempts"]);
const ATTEMPT_KEYS = new Set([
  "phase",
  "n",
  "at",
  "head_sha",
  "base_ref",
  "merge_base",
  "outcome",
  "reason_code",
  "evidence",
  "requested_model",
  "tool_version",
]);

/**
 * @param {unknown} value
 * @param {RegExp} re
 * @returns {boolean}
 */
function nullOr(value, re) {
  return value === null || (typeof value === "string" && re.test(value));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDateTime(value) {
  return typeof value === "string" && DATE_TIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * @param {unknown} pr
 * @returns {number}
 */
function assertPr(pr) {
  if (!Number.isInteger(pr) || /** @type {number} */ (pr) <= 0) {
    throw new Error(`pr must be a positive integer, got ${JSON.stringify(pr)}`);
  }
  return /** @type {number} */ (pr);
}

/**
 * Absolute path of the receipt for one pull request.
 *
 * Under the git COMMON directory rather than a worktree's own: the conductor's
 * phases run from more than one worktree (`/review-pr` applies fixes in its
 * own), and every one of them must extend the same history. Nothing under the
 * git directory can appear in `git status`, so the receipt can never dirty
 * the tree that `local-attest` and `criteria verify` require to be clean.
 *
 * @param {string} gitCommonDir Absolute `git rev-parse --git-common-dir`.
 * @param {number} pr
 * @returns {string}
 */
export function receiptPath(gitCommonDir, pr) {
  return path.join(gitCommonDir, RECEIPT_DIR, `pr-${assertPr(pr)}.json`);
}

/**
 * Start an empty receipt for one pull request.
 *
 * @param {{ pr: number, now?: Date }} input
 * @returns {RunReceipt}
 */
export function createReceipt({ pr, now }) {
  const at = (now ?? new Date()).toISOString();
  return { schema_version: 1, tool: "dotbabel-pr-stack", pr: assertPr(pr), created_at: at, updated_at: at, attempts: [] };
}

/**
 * Return a copy of `receipt` with one attempt appended.
 *
 * Append-only by construction: earlier attempts are never rewritten, so a
 * phase that failed twice before it passed still shows both failures.
 *
 * @param {RunReceipt} receipt
 * @param {{ phase: string, outcome: string, headSha: string, baseRef?: string|null,
 *           mergeBase?: string|null, reasonCode?: string|null, evidence?: string[],
 *           requestedModel?: string|null, toolVersion?: string|null, now?: Date }} attempt
 * @returns {RunReceipt}
 */
export function appendAttempt(receipt, attempt) {
  const { phase, outcome, headSha, baseRef = null, mergeBase = null, reasonCode = null } = attempt;
  if (!PHASE_IDS.includes(phase)) throw new Error(`phase must be one of ${PHASE_IDS.join(", ")}, got ${JSON.stringify(phase)}`);
  if (!RECEIPT_OUTCOMES.includes(/** @type {any} */ (outcome))) {
    throw new Error(`outcome must be one of ${RECEIPT_OUTCOMES.join(", ")}, got ${JSON.stringify(outcome)}`);
  }
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) throw new Error("head must be a full 40-character SHA");
  if (mergeBase !== null && !SHA_RE.test(mergeBase)) throw new Error("merge base must be a full 40-character SHA");
  if (reasonCode !== null && !REASON_RE.test(reasonCode)) {
    throw new Error(`reason code must be an UPPER_SNAKE identifier, got ${JSON.stringify(reasonCode)}`);
  }
  if (!nullOr(baseRef, BASE_REF_RE)) throw new Error(`base ref must be a plain ref name, got ${JSON.stringify(baseRef)}`);
  const evidence = attempt.evidence ?? [];
  if (!Array.isArray(evidence) || !evidence.every((e) => typeof e === "string" && EVIDENCE_RE.test(e))) {
    throw new Error("evidence must be a list of non-empty links without whitespace");
  }
  const requestedModel = attempt.requestedModel ?? null;
  if (!nullOr(requestedModel, MODEL_RE)) throw new Error(`requested model is not a model id: ${JSON.stringify(requestedModel)}`);
  const toolVersion = attempt.toolVersion ?? null;
  if (!nullOr(toolVersion, VERSION_RE)) throw new Error(`tool version is not a version: ${JSON.stringify(toolVersion)}`);
  const at = (attempt.now ?? new Date()).toISOString();
  const n = receipt.attempts.filter((a) => a.phase === phase).length + 1;
  return {
    ...receipt,
    updated_at: at,
    attempts: [
      ...receipt.attempts,
      {
        phase,
        n,
        at,
        head_sha: headSha.toLowerCase(),
        base_ref: baseRef,
        merge_base: mergeBase === null ? null : mergeBase.toLowerCase(),
        outcome: /** @type {ReceiptOutcome} */ (outcome),
        reason_code: reasonCode,
        evidence: [...evidence],
        requested_model: requestedModel,
        tool_version: toolVersion,
      },
    ],
  };
}

/**
 * Per-phase counts, in conductor order, for the phases that were attempted.
 *
 * @param {RunReceipt} receipt
 * @returns {Record<string, PhaseSummary>}
 */
export function summarizePhases(receipt) {
  /** @type {Record<string, PhaseSummary>} */
  const out = {};
  for (const id of PHASE_IDS) {
    const attempts = receipt.attempts.filter((a) => a.phase === id);
    if (attempts.length === 0) continue;
    let consecutive = 0;
    for (const a of attempts) {
      if (a.outcome === "pass") consecutive = 0;
      else if (FAILED.has(a.outcome)) consecutive += 1;
    }
    out[id] = { attempts: attempts.length, last_outcome: attempts[attempts.length - 1].outcome, consecutive_failures: consecutive };
  }
  return out;
}

/**
 * One word for where the pull request stands.
 *
 * `ready` needs three things: the `stop` hand-off is the latest attempt and
 * passed; no other phase's latest non-skipped attempt failed or was blocked;
 * and a passing `local-attest` names the same head as that `stop`, because an
 * attestation of an older head says nothing about the one being handed off. A
 * `stop` pass that contradicts an earlier failure reads `blocked`. A skipped
 * phase stands, so a repository without an attest config can still be ready.
 *
 * @param {RunReceipt} receipt
 * @returns {"in-progress"|"blocked"|"ready"}
 */
export function receiptVerdict(receipt) {
  const last = receipt.attempts[receipt.attempts.length - 1];
  if (!last) return "in-progress";
  if (FAILED.has(last.outcome)) return "blocked";
  if (last.phase !== "stop" || last.outcome !== "pass") return "in-progress";
  for (const id of PHASE_IDS) {
    if (id === "stop") continue;
    const decided = receipt.attempts.filter((a) => a.phase === id && a.outcome !== "skipped").at(-1);
    if (!decided) continue;
    if (FAILED.has(decided.outcome)) return "blocked";
    if (id === "local-attest" && decided.head_sha !== last.head_sha) return "in-progress";
  }
  return "ready";
}

/**
 * The base the pull request can be rolled back to, from the latest attempt
 * that knew it.
 *
 * @param {RunReceipt} receipt
 * @returns {{ base_ref: string|null, merge_base: string }|null}
 */
export function rollbackPoint(receipt) {
  for (let i = receipt.attempts.length - 1; i >= 0; i -= 1) {
    const a = receipt.attempts[i];
    if (a.merge_base) return { base_ref: a.base_ref, merge_base: a.merge_base };
  }
  return null;
}

/**
 * The `model:` value of a Markdown artifact's leading frontmatter block, or
 * null when there is no block or it names no model. Only the block counts: a
 * `model:` line in the body is prose, not a request.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function frontmatterModel(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!block) return null;
  const line = /^model:[ \t]*["']?([A-Za-z0-9._:/-]+)["']?[ \t]*$/m.exec(block[1]);
  return line ? line[1] : null;
}

/**
 * Why a parsed receipt file cannot be trusted as one, or null when it can.
 *
 * The file sits in the git directory where anything can write it, so the bin
 * checks every read before it extends or prints one. This mirrors
 * `schemas/dotbabel.run-receipt.schema.json` field for field, extra keys
 * included; a test holds the two in agreement.
 *
 * @param {unknown} value
 * @param {number} [expectedPr] The pull request the file is named for.
 * @returns {string|null}
 */
export function receiptProblem(value, expectedPr) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "a receipt must be a JSON object";
  const r = /** @type {Record<string, unknown>} */ (value);
  const extra = Object.keys(r).find((k) => !RECEIPT_KEYS.has(k));
  if (extra !== undefined) return `unknown key ${JSON.stringify(extra)}`;
  if (r.schema_version !== 1) return `unsupported schema_version ${JSON.stringify(r.schema_version)}`;
  if (r.tool !== "dotbabel-pr-stack") return "tool must be dotbabel-pr-stack";
  if (!Number.isInteger(r.pr) || /** @type {number} */ (r.pr) <= 0) return "pr must be a positive integer";
  if (expectedPr !== undefined && r.pr !== expectedPr) return `pr is ${r.pr}, but the file is for #${expectedPr}`;
  if (!isDateTime(r.created_at) || !isDateTime(r.updated_at)) return "created_at and updated_at must be ISO date-times";
  if (!Array.isArray(r.attempts)) return "attempts must be an array";
  for (const [i, a] of r.attempts.entries()) {
    const at = `attempts[${i}]`;
    if (a === null || typeof a !== "object" || Array.isArray(a)) return `${at} must be an object`;
    const missing = [...ATTEMPT_KEYS].find((k) => !(k in a));
    if (missing !== undefined) return `${at}.${missing} is missing`;
    const unknown = Object.keys(a).find((k) => !ATTEMPT_KEYS.has(k));
    if (unknown !== undefined) return `${at} has unknown key ${JSON.stringify(unknown)}`;
    if (!PHASE_IDS.includes(a.phase)) return `${at}.phase is not a conductor phase`;
    if (!Number.isInteger(a.n) || a.n <= 0) return `${at}.n must be a positive integer`;
    if (!isDateTime(a.at)) return `${at}.at must be an ISO date-time`;
    if (typeof a.head_sha !== "string" || !STORED_SHA_RE.test(a.head_sha)) return `${at}.head_sha must be a lowercase full SHA`;
    if (!nullOr(a.base_ref, BASE_REF_RE)) return `${at}.base_ref must be null or a plain ref name`;
    if (!nullOr(a.merge_base, STORED_SHA_RE)) return `${at}.merge_base must be null or a lowercase full SHA`;
    if (!RECEIPT_OUTCOMES.includes(a.outcome)) return `${at}.outcome is not one of ${RECEIPT_OUTCOMES.join(", ")}`;
    if (!nullOr(a.reason_code, REASON_RE)) return `${at}.reason_code must be null or UPPER_SNAKE`;
    if (!Array.isArray(a.evidence) || !a.evidence.every((e) => typeof e === "string" && EVIDENCE_RE.test(e))) {
      return `${at}.evidence must be a list of non-empty links without whitespace`;
    }
    if (!nullOr(a.requested_model, MODEL_RE)) return `${at}.requested_model must be null or a model id`;
    if (!nullOr(a.tool_version, VERSION_RE)) return `${at}.tool_version must be null or a version`;
  }
  return null;
}
