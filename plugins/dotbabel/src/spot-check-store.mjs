/**
 * spot-check-store — the merge-time spot-check log of one pull request.
 *
 * `dotbabel pr-stack spot-check` records each decision here, and
 * `--record-explicit` records the result of the explicit run that a selection
 * caused. After the merge, `spot-check --show` and `main-status` read it to
 * answer "was this pull request selected, and was it actually verified?".
 *
 * A SIBLING of the conductor run receipt, never part of it. The receipt
 * (`run-receipt.mjs`) is strict: an older CLI refuses an unknown key and then
 * cannot record a phase for that pull request. Every worktree and every
 * installed CLI version on the machine share the receipt directory, so the
 * spot-check entries live in their own file with their own lock and schema
 * (`schemas/dotbabel.spot-checks.schema.json`), and the receipt keeps its v1
 * shape.
 *
 * SELF-REPORTED, like the receipt: it logs what the tool decided and what the
 * session said it ran. It is never evidence, and the merge gate never reads it.
 *
 * Every export is pure. The bin reads, locks and writes the file.
 *
 * @typedef {object} SpotCheckEntry
 * @property {"spot-check"} kind
 * @property {string} at ISO time the decision was recorded.
 * @property {string} head_sha The pull request head the decision is about.
 * @property {boolean} selected Whether the explicit path was chosen.
 * @property {string} reason One of `SPOT_CHECK_REASONS`.
 * @property {number} rate The rate the roll was compared against.
 * @property {number} roll The roll, in [0, 1).
 * @property {"available"|"unavailable"|"unknown"} ci The default-branch CI state.
 * @property {string} workflow The test workflow file that was read.
 * @property {string} trunk The default branch that was read.
 * @property {boolean} sticky True when the entry repeats an earlier selection of the head.
 * @property {string|null} tool_version
 *
 * @typedef {object} ExplicitRunEntry
 * @property {"explicit-run"} kind
 * @property {string} at
 * @property {string} head_sha
 * @property {"pass"|"fail"} outcome The result of the explicit verification.
 * @property {string|null} tool_version
 *
 * @typedef {object} SpotCheckStore
 * @property {1} schema_version
 * @property {"dotbabel-pr-stack"} tool
 * @property {number} pr
 * @property {string} created_at
 * @property {string} updated_at
 * @property {Array<SpotCheckEntry|ExplicitRunEntry>} entries
 *
 * @typedef {object} SpotCheckSummary
 * @property {string} head_sha
 * @property {boolean|null} selected Null when only an explicit run was recorded.
 * @property {string|null} reason
 * @property {number|null} rate
 * @property {boolean} sticky True when the head was asked again after a selection.
 * @property {"pass"|"fail"|null} explicit The latest explicit-run result.
 */

import path from "node:path";

import { SPOT_CHECK_REASONS } from "./merge-verification.mjs";
import { RECEIPT_DIR } from "./run-receipt.mjs";

/** The CI states a spot-check entry may record. */
export const CI_STATES = Object.freeze(["available", "unavailable", "unknown"]);

/** The results an explicit run may record. */
export const EXPLICIT_OUTCOMES = Object.freeze(["pass", "fail"]);

const SHA_RE = /^[0-9a-f]{40}$/i;
const STORED_SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const TRUNK_RE = /^[A-Za-z0-9._/-]+$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const STORE_KEYS = new Set(["schema_version", "tool", "pr", "created_at", "updated_at", "entries"]);
const SPOT_CHECK_KEYS = new Set(["kind", "at", "head_sha", "selected", "reason", "rate", "roll", "ci", "workflow", "trunk", "sticky", "tool_version"]);
const EXPLICIT_RUN_KEYS = new Set(["kind", "at", "head_sha", "outcome", "tool_version"]);

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
 * @param {unknown} value
 * @returns {boolean}
 */
function isDateTime(value) {
  return typeof value === "string" && DATE_TIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isUnitRate(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isRoll(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isVersionOrNull(value) {
  return value === null || (typeof value === "string" && VERSION_RE.test(value));
}

/**
 * Absolute path of the spot-check log for one pull request: next to the run
 * receipt, under the git COMMON directory, so every worktree shares it and it
 * can never dirty a working tree.
 *
 * @param {string} gitCommonDir Absolute `git rev-parse --git-common-dir`.
 * @param {number} pr
 * @returns {string}
 */
export function spotCheckStorePath(gitCommonDir, pr) {
  return path.join(gitCommonDir, RECEIPT_DIR, `pr-${assertPr(pr)}.spot-checks.json`);
}

/**
 * Start an empty spot-check log for one pull request.
 *
 * @param {{ pr: number, now?: Date }} input
 * @returns {SpotCheckStore}
 */
export function createSpotCheckStore({ pr, now }) {
  const at = (now ?? new Date()).toISOString();
  return { schema_version: 1, tool: "dotbabel-pr-stack", pr: assertPr(pr), created_at: at, updated_at: at, entries: [] };
}

/**
 * Return a copy of `store` with one entry appended. Append-only: an earlier
 * decision is never rewritten.
 *
 * @param {SpotCheckStore} store
 * @param {{ kind: "spot-check"|"explicit-run", headSha: string, selected?: boolean, reason?: string,
 *           rate?: number, roll?: number, ci?: string, workflow?: string, trunk?: string, sticky?: boolean,
 *           outcome?: string, toolVersion?: string|null, now?: Date }} entry
 * @returns {SpotCheckStore}
 */
export function appendSpotCheck(store, entry) {
  const { kind, headSha } = entry;
  if (kind !== "spot-check" && kind !== "explicit-run") {
    throw new Error(`kind must be spot-check or explicit-run, got ${JSON.stringify(kind)}`);
  }
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) throw new Error("head must be a full 40-character SHA");
  const toolVersion = entry.toolVersion ?? null;
  if (!isVersionOrNull(toolVersion)) throw new Error(`tool version is not a version: ${JSON.stringify(toolVersion)}`);
  const at = (entry.now ?? new Date()).toISOString();
  /** @type {SpotCheckEntry|ExplicitRunEntry} */
  let stored;
  if (kind === "spot-check") {
    if (typeof entry.selected !== "boolean") throw new Error("selected must be a boolean");
    if (!SPOT_CHECK_REASONS.includes(/** @type {any} */ (entry.reason))) {
      throw new Error(`reason must be one of ${SPOT_CHECK_REASONS.join(", ")}, got ${JSON.stringify(entry.reason)}`);
    }
    if (!isUnitRate(entry.rate)) throw new Error(`rate must be a number from 0 to 1, got ${JSON.stringify(entry.rate)}`);
    if (!isRoll(entry.roll)) throw new Error(`roll must be a number in [0, 1), got ${JSON.stringify(entry.roll)}`);
    if (!CI_STATES.includes(/** @type {any} */ (entry.ci))) {
      throw new Error(`ci must be one of ${CI_STATES.join(", ")}, got ${JSON.stringify(entry.ci)}`);
    }
    if (typeof entry.workflow !== "string" || !WORKFLOW_RE.test(entry.workflow)) {
      throw new Error(`workflow must be a workflow file name, got ${JSON.stringify(entry.workflow)}`);
    }
    if (typeof entry.trunk !== "string" || !TRUNK_RE.test(entry.trunk)) {
      throw new Error(`trunk must be a plain branch name, got ${JSON.stringify(entry.trunk)}`);
    }
    const sticky = entry.sticky ?? false;
    if (typeof sticky !== "boolean") throw new Error("sticky must be a boolean");
    stored = {
      kind,
      at,
      head_sha: headSha.toLowerCase(),
      selected: entry.selected,
      reason: /** @type {string} */ (entry.reason),
      rate: /** @type {number} */ (entry.rate),
      roll: /** @type {number} */ (entry.roll),
      ci: /** @type {any} */ (entry.ci),
      workflow: entry.workflow,
      trunk: entry.trunk,
      sticky,
      tool_version: toolVersion,
    };
  } else {
    if (!EXPLICIT_OUTCOMES.includes(/** @type {any} */ (entry.outcome))) {
      throw new Error(`outcome must be one of ${EXPLICIT_OUTCOMES.join(", ")}, got ${JSON.stringify(entry.outcome)}`);
    }
    stored = { kind, at, head_sha: headSha.toLowerCase(), outcome: /** @type {any} */ (entry.outcome), tool_version: toolVersion };
  }
  return { ...store, updated_at: at, entries: [...store.entries, stored] };
}

/**
 * The first decision that selected `headSha`, or null.
 *
 * A selection is sticky: once a head was selected, asking again on that head
 * reports it selected, whatever the CI state or the base policy is now. The
 * roll is already fixed for a head; this keeps a later green run or a lowered
 * rate from turning a selection into "not selected". A non-selection is not
 * sticky, so it can still become a selection.
 *
 * @param {SpotCheckStore|null} store
 * @param {string} headSha
 * @returns {SpotCheckEntry|null}
 */
export function firstSelection(store, headSha) {
  if (!store || typeof headSha !== "string") return null;
  const head = headSha.toLowerCase();
  const hit = store.entries.find((e) => e.kind === "spot-check" && e.head_sha === head && e.selected === true);
  return /** @type {SpotCheckEntry|undefined} */ (hit) ?? null;
}

/**
 * Per head, in the order first seen: the decision that stands and the latest
 * explicit-run result.
 *
 * The decision that stands is the first selection when there is one, because
 * a selection is sticky; otherwise it is the latest decision.
 *
 * @param {SpotCheckStore} store
 * @returns {SpotCheckSummary[]}
 */
export function summarizeSpotChecks(store) {
  /** @type {Map<string, SpotCheckSummary>} */
  const byHead = new Map();
  for (const e of store.entries) {
    const row = byHead.get(e.head_sha) ?? { head_sha: e.head_sha, selected: null, reason: null, rate: null, sticky: false, explicit: null };
    if (e.kind === "explicit-run") {
      row.explicit = /** @type {ExplicitRunEntry} */ (e).outcome;
    } else if (row.selected === true) {
      // A selection stands; a later entry on the same head only marks it asked again.
      row.sticky = true;
    } else {
      const d = /** @type {SpotCheckEntry} */ (e);
      row.selected = d.selected;
      row.reason = d.reason;
      row.rate = d.rate;
    }
    byHead.set(e.head_sha, row);
  }
  return [...byHead.values()];
}

/**
 * Why one entry is not valid, or null.
 *
 * @param {unknown} e
 * @param {string} at
 * @returns {string|null}
 */
function entryProblem(e, at) {
  if (e === null || typeof e !== "object" || Array.isArray(e)) return `${at} must be an object`;
  const entry = /** @type {Record<string, unknown>} */ (e);
  const keys = entry.kind === "spot-check" ? SPOT_CHECK_KEYS : entry.kind === "explicit-run" ? EXPLICIT_RUN_KEYS : null;
  if (keys === null) return `${at}.kind must be spot-check or explicit-run`;
  const missing = [...keys].find((k) => !(k in entry));
  if (missing !== undefined) return `${at}.${missing} is missing`;
  const unknown = Object.keys(entry).find((k) => !keys.has(k));
  if (unknown !== undefined) return `${at} has unknown key ${JSON.stringify(unknown)}`;
  if (!isDateTime(entry.at)) return `${at}.at must be an ISO date-time`;
  if (typeof entry.head_sha !== "string" || !STORED_SHA_RE.test(entry.head_sha)) return `${at}.head_sha must be a lowercase full SHA`;
  if (!isVersionOrNull(entry.tool_version)) return `${at}.tool_version must be null or a version`;
  if (entry.kind === "explicit-run") {
    return EXPLICIT_OUTCOMES.includes(/** @type {any} */ (entry.outcome)) ? null : `${at}.outcome must be pass or fail`;
  }
  if (typeof entry.selected !== "boolean") return `${at}.selected must be a boolean`;
  if (!SPOT_CHECK_REASONS.includes(/** @type {any} */ (entry.reason))) return `${at}.reason is not a spot-check reason`;
  if (!isUnitRate(entry.rate)) return `${at}.rate must be a number from 0 to 1`;
  if (!isRoll(entry.roll)) return `${at}.roll must be a number in [0, 1)`;
  if (!CI_STATES.includes(/** @type {any} */ (entry.ci))) return `${at}.ci must be available, unavailable or unknown`;
  if (typeof entry.workflow !== "string" || !WORKFLOW_RE.test(entry.workflow)) return `${at}.workflow must be a workflow file name`;
  if (typeof entry.trunk !== "string" || !TRUNK_RE.test(entry.trunk)) return `${at}.trunk must be a plain branch name`;
  if (typeof entry.sticky !== "boolean") return `${at}.sticky must be a boolean`;
  return null;
}

/**
 * Why `value` is not a valid spot-check log, or null when it is. The same
 * rules as `schemas/dotbabel.spot-checks.schema.json`.
 *
 * @param {unknown} value
 * @param {number} [expectedPr] When given, the log must belong to this pull request.
 * @returns {string|null}
 */
export function spotCheckStoreProblem(value, expectedPr) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "the spot-check log must be a JSON object";
  const s = /** @type {Record<string, unknown>} */ (value);
  const unknown = Object.keys(s).find((k) => !STORE_KEYS.has(k));
  if (unknown !== undefined) return `unknown key ${JSON.stringify(unknown)}`;
  if (s.schema_version !== 1) return `schema_version must be 1, got ${JSON.stringify(s.schema_version)}`;
  if (s.tool !== "dotbabel-pr-stack") return "tool must be dotbabel-pr-stack";
  if (!Number.isInteger(s.pr) || /** @type {number} */ (s.pr) <= 0) return "pr must be a positive integer";
  if (expectedPr !== undefined && s.pr !== expectedPr) return `pr is ${s.pr}, expected ${expectedPr}`;
  if (!isDateTime(s.created_at)) return "created_at must be an ISO date-time";
  if (!isDateTime(s.updated_at)) return "updated_at must be an ISO date-time";
  if (!Array.isArray(s.entries)) return "entries must be an array";
  for (const [i, e] of s.entries.entries()) {
    const problem = entryProblem(e, `entries[${i}]`);
    if (problem !== null) return problem;
  }
  return null;
}
