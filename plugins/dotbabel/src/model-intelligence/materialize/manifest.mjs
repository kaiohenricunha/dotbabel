/** Deterministic projection provenance. This module performs no I/O. */
import { createHash } from "node:crypto";

const OPERATIONAL_FIELDS = new Set(["observedAt", "generatedAt", "refreshedAt", "pid", "mtimeMs", "temporaryPath", "lockOwner", "refresh", "refreshState"]);

/**
 * Canonicalize explicit JSON data for stable projection identities.
 * @param {unknown} value Supplied semantic inputs.
 * @param {boolean} [omitOperational] Exclude operational envelope fields.
 * @returns {string} Stable JSON, rejecting non-JSON or cyclic values.
 */
export function canonicalJson(value, omitOperational = false) {
  const seen = new Set();
  const normalize = (item, depth = 0) => {
    if (depth > 64) throw new TypeError("projection input exceeds nesting limit");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || seen.has(item)) throw new TypeError("projection inputs must be acyclic JSON data");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError("projection inputs must be plain JSON data");
    seen.add(item);
    const result = Array.isArray(item) ? item.map(value => normalize(value, depth + 1)) : Object.fromEntries(Object.keys(item).sort().filter(key => !(omitOperational && OPERATIONAL_FIELDS.has(key))).map(key => [key, normalize(item[key], depth + 1)]));
    seen.delete(item);
    return result;
  };
  return JSON.stringify(normalize(value));
}

/** @param {string} bytes UTF-8 content. @returns {string} Versioned content digest. */
export const hashContent = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");

/**
 * Build the deterministic manifest for a complete pure materialization batch.
 * @param {string} toolVersion Dotbabel version that produces the files.
 * @param {object[]} projections Files carrying their provenance entries.
 * @returns {object} A manifest with target paths in lexical order.
 */
export function makeManifest(toolVersion, projections) {
  return { schemaVersion: 1, toolVersion, entries: Object.fromEntries(projections.map(item => [item.path, item.entry])) };
}
