/** Exact canonical artifact selectors for monotonic policy floors; no runtime I/O. */
import { ARTIFACT_KINDS, WORKLOAD_CLASSES } from "../domain/index.mjs";
const object = value => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = () => Object.assign(new TypeError("invalid scoped policy floor"), { code: "invalid_scoped_floor" });

/** @param {unknown} value Canonical repository-relative artifact path. @returns {boolean} Whether exact matching is unambiguous. */
export function isArtifactSourcePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[:\\\p{Cc}\p{Cf}]/u.test(value) && !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/**
 * Validate and copy a bounded scoped-floor list without echoing untrusted input.
 * Scopes contain an exact source path and kind, never a glob, model or runtime alias.
 * @param {unknown} value Optional policy declarations.
 * @returns {object[]} Validated declarations independent of caller mutation.
 */
export function normalizeScopedFloors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw fail();
  return value.map(entry => {
    if (!object(entry) || Object.keys(entry).some(key => !["mode", "requirement", "scope", "rationale"].includes(key)) || entry.mode !== "floor" || !WORKLOAD_CLASSES.includes(entry.requirement) || !object(entry.scope)) throw fail();
    if (Object.keys(entry.scope).length !== 2 || !ARTIFACT_KINDS.includes(entry.scope.artifact_kind) || !isArtifactSourcePath(entry.scope.source_path)) throw fail();
    if (entry.rationale !== undefined && (typeof entry.rationale !== "string" || entry.rationale.trim() === "" || entry.rationale.length > 1000)) throw fail();
    return { mode: "floor", requirement: entry.requirement, scope: { artifact_kind: entry.scope.artifact_kind, source_path: entry.scope.source_path }, ...(entry.rationale === undefined ? {} : { rationale: entry.rationale }) };
  });
}
