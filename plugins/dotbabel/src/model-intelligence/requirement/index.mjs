/**
 * model-intelligence/requirement — parse and validate the canonical
 * `dotbabel.compute` declaration of an artifact and normalise it for the
 * resolver (docs/specs/model-intelligence, §5 "Artifact Declaration").
 *
 * The module works over frontmatter that a caller has already parsed with the
 * shared YAML path (`parseFrontmatter` in `build-index.mjs`). It owns no
 * filesystem access (ARCH-56), and it never extends the hand-written line
 * parser of `validate-skills-inventory.mjs`, which flattens a nested mapping
 * into one string and therefore cannot read this declaration.
 *
 * Validation is conditional on `mode`, and `dotbabel.compute` is strict: a
 * misspelled key is an error rather than inert policy.
 */

import {
  BINDINGS,
  RESOLUTION_MODES,
  RUNTIME_IDS,
  WORKLOAD_CLASSES,
  makeProvenance,
} from "../domain/index.mjs";

/** `$id` of the shipped JSON Schema for the `dotbabel` namespace. */
export const COMPUTE_SCHEMA_ID = "https://dotbabel.dev/schemas/dotbabel.compute.schema.json";

/** Error code for every invalid canonical declaration. Stable within a release line (OPS-3). */
export const MI_COMPUTE_INVALID = "MI_COMPUTE_INVALID";

/** Keys that `dotbabel.compute` accepts in v1. */
const COMPUTE_KEYS = Object.freeze(["requirement", "binding", "mode", "pin", "rationale"]);

/** Keys that `pin` accepts. */
const PIN_KEYS = Object.freeze(["runtime", "config"]);

/**
 * @typedef {object} ComputeParseError
 * @property {string} code Always `MI_COMPUTE_INVALID`.
 * @property {string} pointer JSON pointer inside the frontmatter, e.g. `/dotbabel/compute/mode`.
 * @property {string} message
 * @property {string} [expected] Permitted values, when the field is an enum.
 * @property {string} [got]
 */

/**
 * @typedef {object} ComputeParseResult
 * @property {boolean} declared Whether the artifact declares `dotbabel.compute` at all.
 * @property {import("../domain/index.mjs").NormalizedComputeRequirement | null} requirement
 *   The normalised requirement, or `null` when absent or invalid.
 * @property {ComputeParseError[]} errors
 */

/**
 * Build one parse error.
 * @param {string} pointer
 * @param {string} message
 * @param {{expected?: readonly string[], got?: unknown}} [extra]
 * @returns {ComputeParseError}
 */
function invalid(pointer, message, extra = {}) {
  /** @type {ComputeParseError} */
  const error = { code: MI_COMPUTE_INVALID, pointer, message };
  if (extra.expected) error.expected = extra.expected.join(", ");
  if (extra.got !== undefined) error.got = typeof extra.got === "string" ? extra.got : JSON.stringify(extra.got);
  return error;
}

/**
 * Tell whether a value is a plain object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the `pin` object of a declaration.
 * @param {unknown} pin
 * @param {ComputeParseError[]} errors Collected in place.
 * @returns {{runtime: string, config: Record<string, unknown>} | null}
 */
function readPin(pin, errors) {
  const base = "/dotbabel/compute/pin";
  if (!isPlainObject(pin)) {
    errors.push(invalid(base, "pin must be an object", { got: pin }));
    return null;
  }
  for (const key of Object.keys(pin)) {
    if (!PIN_KEYS.includes(key)) errors.push(invalid(`${base}/${key}`, `pin has unknown key "${key}"`, { expected: PIN_KEYS }));
  }
  const runtime = /** @type {Record<string, unknown>} */ (pin).runtime;
  const config = /** @type {Record<string, unknown>} */ (pin).config;
  let ok = true;
  if (typeof runtime !== "string" || !RUNTIME_IDS.includes(runtime)) {
    errors.push(invalid(`${base}/runtime`, "pin.runtime must be a runtime id of the dotbabel runtime registry", { expected: RUNTIME_IDS, got: runtime }));
    ok = false;
  }
  if (!isPlainObject(config) || Object.keys(/** @type {object} */ (config)).length === 0) {
    errors.push(invalid(`${base}/config`, "pin.config must be a non-empty object of runtime-native values", { got: config }));
    ok = false;
  }
  if (!ok) return null;
  return {
    runtime: /** @type {string} */ (runtime),
    config: Object.freeze({ .../** @type {Record<string, unknown>} */ (config) }),
  };
}

/**
 * Parse the canonical `dotbabel.compute` declaration of one artifact.
 *
 * Absence is not an error: an artifact without the key simply has no canonical
 * declaration, and `compat/` may still derive meaning from legacy metadata.
 * @param {Record<string, unknown> | null | undefined} frontmatter Parsed YAML frontmatter.
 * @param {{sourcePath: string}} options `sourcePath` becomes the provenance `sourceId`.
 * @returns {ComputeParseResult}
 */
export function parseComputeDeclaration(frontmatter, options) {
  const sourcePath = options?.sourcePath;
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw new TypeError("parseComputeDeclaration requires options.sourcePath");
  }
  /** @type {ComputeParseError[]} */
  const errors = [];
  const namespace = isPlainObject(frontmatter) ? /** @type {Record<string, unknown>} */ (frontmatter).dotbabel : undefined;
  if (namespace === undefined) return { declared: false, requirement: null, errors };
  if (!isPlainObject(namespace)) {
    errors.push(invalid("/dotbabel", "dotbabel must be an object", { got: namespace }));
    return { declared: true, requirement: null, errors };
  }
  const compute = /** @type {Record<string, unknown>} */ (namespace).compute;
  if (compute === undefined) return { declared: false, requirement: null, errors };
  if (!isPlainObject(compute)) {
    errors.push(invalid("/dotbabel/compute", "dotbabel.compute must be an object", { got: compute }));
    return { declared: true, requirement: null, errors };
  }

  const fields = /** @type {Record<string, unknown>} */ (compute);
  for (const key of Object.keys(fields)) {
    if (!COMPUTE_KEYS.includes(key)) {
      errors.push(invalid(`/dotbabel/compute/${key}`, `dotbabel.compute has unknown key "${key}"`, { expected: COMPUTE_KEYS }));
    }
  }

  const { requirement, binding, mode, pin, rationale } = fields;

  if (typeof binding !== "string" || !BINDINGS.includes(binding)) {
    errors.push(invalid("/dotbabel/compute/binding", "binding is required", { expected: BINDINGS, got: binding }));
  }
  if (typeof mode !== "string" || !RESOLUTION_MODES.includes(mode)) {
    errors.push(invalid("/dotbabel/compute/mode", "mode is required", { expected: RESOLUTION_MODES, got: mode }));
  }
  if (requirement !== undefined && (typeof requirement !== "string" || !WORKLOAD_CLASSES.includes(requirement))) {
    errors.push(invalid("/dotbabel/compute/requirement", "requirement must be a semantic workload class", { expected: WORKLOAD_CLASSES, got: requirement }));
  }
  if (rationale !== undefined && typeof rationale !== "string") {
    errors.push(invalid("/dotbabel/compute/rationale", "rationale must be a string", { got: rationale }));
  }

  // Conditional rules of §5. They depend on a valid `mode`, so they run only then.
  const needsRequirement = mode === "dynamic" || mode === "floor" || mode === "pin";
  if (needsRequirement && requirement === undefined) {
    errors.push(invalid("/dotbabel/compute/requirement", `requirement is required for mode "${mode}"`, { expected: WORKLOAD_CLASSES }));
  }
  if (mode === "inherit" && requirement !== undefined) {
    errors.push(invalid("/dotbabel/compute/requirement", "requirement is forbidden for mode inherit, which introduces no requirement of its own", { got: requirement }));
  }
  if (mode === "pin" && pin === undefined) {
    errors.push(invalid("/dotbabel/compute/pin", "pin is required for mode pin"));
  }
  if (mode !== undefined && mode !== "pin" && pin !== undefined) {
    errors.push(invalid("/dotbabel/compute/pin", `pin is only permitted for mode pin, not "${String(mode)}"`));
  }

  const normalisedPin = pin !== undefined ? readPin(pin, errors) : null;

  if (errors.length > 0) return { declared: true, requirement: null, errors };

  /** @type {Record<string, unknown>} */
  const normalised = {
    binding,
    mode,
    provenance: makeProvenance({ sourceId: sourcePath, sourceKind: "runtime", adapterVersion: "canonical" }),
  };
  if (requirement !== undefined) normalised.requirement = requirement;
  if (normalisedPin !== null) normalised.pin = Object.freeze(normalisedPin);
  if (rationale !== undefined) normalised.rationale = rationale;
  // Field order follows §5 so a serialised requirement reads like the declaration.
  const ordered = {};
  for (const key of ["requirement", "binding", "mode", "pin", "rationale", "provenance"]) {
    if (normalised[key] !== undefined) ordered[key] = normalised[key];
  }
  return { declared: true, requirement: Object.freeze(ordered), errors };
}
