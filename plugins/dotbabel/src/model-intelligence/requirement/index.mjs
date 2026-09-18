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
 * Field validation is unconditional; the mode-dependent rules of §5 are
 * conditional and run only once `mode` is a known resolution mode. Both this
 * module and the shipped JSON Schema read their rules from the one `MODE_RULES`
 * table in `./schema.mjs`, so the two enforcement paths cannot drift.
 *
 * `dotbabel.compute` is strict: a misspelled key is an error rather than inert
 * policy.
 */

import {
  BINDINGS,
  RESOLUTION_MODES,
  RUNTIME_IDS,
  WORKLOAD_CLASSES,
  makeProvenance,
} from "../domain/index.mjs";
import { COMPUTE_KEYS, MODE_RULES, PIN_KEYS } from "./schema.mjs";

export { COMPUTE_SCHEMA_ID } from "../domain/index.mjs";
export { MODE_RULES, buildComputeSchema } from "./schema.mjs";

/** Error code for every invalid canonical declaration. Stable within a release line (OPS-3). */
export const MI_COMPUTE_INVALID = "MI_COMPUTE_INVALID";

/**
 * Why a declaration was rejected. `code` stays one stable family value, so this
 * is the field a consumer branches on — a fixer that suggests a spelling for an
 * `unknown-key`, a report that groups by class — rather than matching on the
 * prose message, which is presentation and may be reworded (OPS-3).
 */
export const COMPUTE_ERROR_REASONS = Object.freeze(["shape", "unknown-key", "required", "forbidden", "enum", "type"]);

/**
 * @typedef {object} ComputeParseError
 * @property {string} code Always `MI_COMPUTE_INVALID`.
 * @property {string} reason One of `COMPUTE_ERROR_REASONS`.
 * @property {string} pointer JSON pointer inside the frontmatter, e.g. `/dotbabel/compute/mode`.
 * @property {string} message
 * @property {string} [expected] Permitted values, when the field is an enum.
 * @property {string} [got] The offending value, for an enum field only.
 * @property {string} [gotType] The offending value's type, for a structural fault.
 */

/**
 * @typedef {object} ComputeParseResult
 * @property {boolean} declared Whether the artifact declares `dotbabel.compute` at all.
 * @property {import("../domain/index.mjs").NormalizedComputeRequirement | null} requirement
 *   The normalised requirement, or `null` when absent or invalid.
 * @property {ComputeParseError[]} errors
 */

/**
 * Describe a value's type without echoing the value.
 *
 * A structural fault carries a whole sub-object — the `dotbabel` namespace, the
 * `compute` block, `pin`, or `pin.config` — and `pin.config` is opaque
 * runtime-native configuration that may legitimately hold an endpoint or a
 * credential. Reporting the type keeps the diagnostic useful without copying an
 * author's value into a log or a PR comment (OPS-4).
 * @param {unknown} value
 * @returns {string}
 */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Build one parse error.
 *
 * `got` is reserved for a bounded field: an enum's value set is already known,
 * so echoing it is safe and useful. A structural fault reports `gotType`.
 * @param {string} reason One of `COMPUTE_ERROR_REASONS`.
 * @param {string} pointer
 * @param {string} message
 * @param {{expected?: readonly string[], got?: unknown, gotType?: unknown}} [extra]
 * @returns {ComputeParseError}
 */
function invalid(reason, pointer, message, extra = {}) {
  /** @type {ComputeParseError} */
  const error = { code: MI_COMPUTE_INVALID, reason, pointer, message };
  if (extra.expected) error.expected = extra.expected.join(", ");
  if (extra.got !== undefined) error.got = String(extra.got).slice(0, 80);
  if ("gotType" in extra) error.gotType = typeOf(extra.gotType);
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
 * Check one enum field, distinguishing an absent value from an invalid one.
 *
 * "binding is required" for a present `binding: agent` would misdescribe the
 * fault: the spec names artifact kinds explicitly as wrong binding values, so the
 * author needs to read which values are legal, not that the field is missing.
 * @param {string} field
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {ComputeParseError[]} errors Collected in place.
 * @returns {boolean} Whether the value is usable.
 */
function readRequiredEnum(field, value, allowed, errors) {
  const pointer = `/dotbabel/compute/${field}`;
  if (value === undefined) {
    errors.push(invalid("required", pointer, `${field} is required`, { expected: allowed }));
    return false;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(invalid("enum", pointer, `${field} must be one of ${allowed.join(", ")}`, { expected: allowed, got: value }));
    return false;
  }
  return true;
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
    errors.push(invalid("shape", base, "pin must be an object", { gotType: pin }));
    return null;
  }
  for (const key of Object.keys(pin)) {
    if (!PIN_KEYS.includes(key)) {
      errors.push(invalid("unknown-key", `${base}/${key}`, `pin has unknown key "${key}"`, { expected: PIN_KEYS }));
    }
  }
  const runtime = /** @type {Record<string, unknown>} */ (pin).runtime;
  const config = /** @type {Record<string, unknown>} */ (pin).config;
  let ok = readRequiredEnum("pin/runtime", runtime, RUNTIME_IDS, errors);
  if (!isPlainObject(config) || Object.keys(/** @type {object} */ (config)).length === 0) {
    errors.push(invalid("shape", `${base}/config`, "pin.config must be a non-empty object of runtime-native values", { gotType: config }));
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
    errors.push(invalid("shape", "/dotbabel", "dotbabel must be an object", { gotType: namespace }));
    return { declared: true, requirement: null, errors };
  }
  const compute = /** @type {Record<string, unknown>} */ (namespace).compute;
  if (compute === undefined) return { declared: false, requirement: null, errors };
  if (!isPlainObject(compute)) {
    errors.push(invalid("shape", "/dotbabel/compute", "dotbabel.compute must be an object", { gotType: compute }));
    return { declared: true, requirement: null, errors };
  }

  const fields = /** @type {Record<string, unknown>} */ (compute);
  for (const key of Object.keys(fields)) {
    if (!COMPUTE_KEYS.includes(key)) {
      errors.push(invalid("unknown-key", `/dotbabel/compute/${key}`, `dotbabel.compute has unknown key "${key}"`, { expected: COMPUTE_KEYS }));
    }
  }

  const { requirement, binding, mode, pin, rationale } = fields;

  readRequiredEnum("binding", binding, BINDINGS, errors);
  const modeValid = readRequiredEnum("mode", mode, RESOLUTION_MODES, errors);
  if (requirement !== undefined && (typeof requirement !== "string" || !WORKLOAD_CLASSES.includes(requirement))) {
    errors.push(invalid("enum", "/dotbabel/compute/requirement", `requirement must be one of ${WORKLOAD_CLASSES.join(", ")}`, { expected: WORKLOAD_CLASSES, got: requirement }));
  }
  if (rationale !== undefined && typeof rationale !== "string") {
    errors.push(invalid("type", "/dotbabel/compute/rationale", "rationale must be a string", { gotType: rationale }));
  }

  // The conditional rules of §5, read from the one table that also renders the
  // JSON Schema. They run only for a known mode: reporting "pin is not permitted
  // for mode auto" on top of the real enum error would be noise, not help.
  if (modeValid) {
    const rule = MODE_RULES[/** @type {string} */ (mode)];
    for (const [field, value] of [["requirement", requirement], ["pin", pin]]) {
      const pointer = `/dotbabel/compute/${field}`;
      if (rule[field] && value === undefined) {
        errors.push(invalid("required", pointer, `${field} is required for mode "${mode}"`));
      }
      if (!rule[field] && value !== undefined) {
        errors.push(invalid("forbidden", pointer, `${field} is not permitted for mode "${mode}", which is defined to ${rule.why}`));
      }
    }
  }

  const normalisedPin = pin !== undefined ? readPin(pin, errors) : null;

  if (errors.length > 0) return { declared: true, requirement: null, errors };

  /** @type {Record<string, unknown>} */
  const normalised = {
    binding,
    mode,
    // `sourceKind: "artifact"` records that the artifact declared this itself. A
    // declaration must not borrow `runtime`, which consumers read as "an adapter
    // observed this from a harness".
    provenance: makeProvenance({ sourceId: sourcePath, sourceKind: "artifact" }),
  };
  if (requirement !== undefined) normalised.requirement = requirement;
  if (normalisedPin !== null) normalised.pin = Object.freeze(normalisedPin);
  if (rationale !== undefined) normalised.rationale = rationale;
  // Field order follows §5 so a serialised requirement reads like the declaration.
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const key of ["requirement", "binding", "mode", "pin", "rationale", "provenance"]) {
    if (normalised[key] !== undefined) ordered[key] = normalised[key];
  }
  return { declared: true, requirement: Object.freeze(ordered), errors };
}
