/**
 * model-intelligence/domain — the stable vocabulary and data shapes that every
 * Model Intelligence module shares (docs/specs/model-intelligence, §5).
 *
 * This module is pure (ARCH-56): it performs no filesystem, process, network,
 * clock, or environment I/O. It holds no provider model name and no
 * runtime-native identifier as policy (ARCH-15). Runtime ids come from the
 * `RUNTIMES` registry and are never redeclared here (ARCH-58).
 *
 * Three dimensions stay separate on purpose (§5, "Invariant"): static support
 * (`SUPPORT_STATES`), the outcome of one adapter operation
 * (`ADAPTER_RESULT_STATUSES`), and freshness/refresh (`FRESHNESS_STATES`,
 * `REFRESH_STATES`). Their words overlap; their meanings do not.
 */

import { RUNTIMES } from "../../agents.mjs";

/** Semantic workload classes, ordered by required reasoning capability. Not a model score. */
export const WORKLOAD_CLASSES = Object.freeze(["mechanical", "routine", "deep", "frontier", "exceptional"]);

/** Where a requirement applies, independent of the artifact's file type. */
export const BINDINGS = Object.freeze(["self", "session", "consumer"]);

/** Resolution modes of a `dotbabel.compute` declaration. */
export const RESOLUTION_MODES = Object.freeze(["dynamic", "floor", "pin", "inherit"]);

/** Static capability of an adapter. `unverified` is never treated as `supported` (ARCH-44). */
export const SUPPORT_STATES = Object.freeze(["supported", "unsupported", "unverified"]);

/** Outcome of one adapter operation. A successful exit code alone does not imply `ok`. */
export const ADAPTER_RESULT_STATUSES = Object.freeze(["ok", "unsupported", "unavailable", "unknown"]);

/** Freshness that `catalog/` derives from `observedAt`; never an adapter status. */
export const FRESHNESS_STATES = Object.freeze(["fresh", "stale", "expired", "unknown"]);

/** Refresh coordination state that the cache layer exposes (ARCH-61). */
export const REFRESH_STATES = Object.freeze(["idle", "in_progress"]);

/** Local availability of a catalog fact, separate from global existence (ARCH-14). */
export const AVAILABILITY_STATES = Object.freeze(["available", "unavailable", "unknown"]);

/** Resolver result statuses. */
export const RESOLVER_STATUSES = Object.freeze(["resolved", "unresolved", "conflict", "invalid"]);

/** The four enforcement states of ARCH-48. `unknown` is never upgraded to satisfaction. */
export const ENFORCEMENT_STATES = Object.freeze(["enforced", "satisfied-not-enforced", "unsatisfied", "unknown"]);

/** What an enforcement state rests on. */
export const ENFORCEMENT_BASES = Object.freeze(["artifact-binding", "session-observation", "invocation", "none"]);

/** How a resolved value is represented; the adapter decides which is safe (ARCH-54). */
export const REPRESENTATION_KINDS = Object.freeze(["stable-alias", "native-id", "opaque-selector"]);

/** Canonical artifact kinds that a binding contract is keyed by. */
export const ARTIFACT_KINDS = Object.freeze(["agent", "command", "skill", "workflow"]);

/**
 * Kinds of evidence source. `runtime` and `knowledge-source` are the two adapter
 * classes of §5. `artifact` is the canonical declaration itself: the artifact
 * stated the requirement, and no adapter observed it. Consumers that mean "an
 * adapter observed this from a harness" test for `runtime`, so a declaration must
 * not borrow that kind.
 */
export const SOURCE_KINDS = Object.freeze(["runtime", "knowledge-source", "artifact"]);

/** `$id` of the shipped JSON Schema for the `dotbabel` frontmatter namespace. */
export const COMPUTE_SCHEMA_ID = "https://dotbabel.dev/schemas/dotbabel.compute.schema.json";

/** Runtime ids, taken from the `RUNTIMES` registry. A runtime is a harness, not a model vendor (ARCH-2). */
export const RUNTIME_IDS = Object.freeze(Object.keys(RUNTIMES));

/**
 * Tell whether a value is a runtime id of the registry.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRuntimeId(value) {
  return typeof value === "string" && RUNTIME_IDS.includes(value);
}

/**
 * Position of a workload class in the ordering. Internal: the position is an
 * ordering key, never a published model score (§2, "Universal model scoring").
 * @param {string} workloadClass
 * @returns {number}
 */
function rankOf(workloadClass) {
  const rank = WORKLOAD_CLASSES.indexOf(workloadClass);
  if (rank === -1) throw new TypeError(`unknown workload class "${workloadClass}"`);
  return rank;
}

/**
 * Compare two workload classes by rank.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when `a` is weaker, zero when equal, positive when `a` is stronger.
 */
export function compareWorkloadClass(a, b) {
  return rankOf(a) - rankOf(b);
}

/**
 * Tell whether a candidate class satisfies a required class (equal or stronger).
 * @param {string} candidate
 * @param {string} required
 * @returns {boolean}
 */
export function satisfiesWorkloadClass(candidate, required) {
  return compareWorkloadClass(candidate, required) >= 0;
}

/**
 * Reject a plain object that carries a field outside the allowed set.
 * @param {string} shape Shape name for the error message.
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @returns {Record<string, unknown>}
 */
function assertKnownFields(shape, value, allowed) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${shape} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${shape} has unknown field "${key}"`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * How a requirement came to exist.
 *
 * `sourceKind` cannot carry this: an authored `dotbabel.compute` and a requirement
 * inferred from legacy `model:`/`effort:` are both `artifact`, and a consumer that
 * must not treat an inference as an authored decision needs its own discriminator
 * rather than a sentinel smuggled through a version field (ARCH-18).
 */
export const DERIVATIONS = Object.freeze(["declared", "legacy-inferred"]);

const PROVENANCE_FIELDS = Object.freeze(["sourceId", "sourceKind", "sourceVersion", "adapterVersion", "derivation"]);

/**
 * @typedef {object} Provenance
 * @property {string} sourceId Runtime id, knowledge-source id, or — for `sourceKind: "artifact"` —
 *   the declaring artifact path. Never a credential or an account id (OPS-4).
 * @property {"runtime"|"knowledge-source"|"artifact"} sourceKind
 * @property {string} [sourceVersion]
 * @property {string} [adapterVersion]
 * @property {"declared"|"legacy-inferred"} [derivation] Defaults to `declared` when absent.
 */

/**
 * Build a frozen provenance record. Unknown fields are rejected so that no
 * identity or credential can travel in provenance by accident (OPS-4).
 * @param {Provenance} input
 * @returns {Readonly<Provenance>}
 */
export function makeProvenance(input) {
  const fields = assertKnownFields("Provenance", input, PROVENANCE_FIELDS);
  if (typeof fields.sourceId !== "string" || fields.sourceId.trim() === "") {
    throw new TypeError("Provenance.sourceId must be a non-empty string");
  }
  if (!SOURCE_KINDS.includes(/** @type {string} */ (fields.sourceKind))) {
    throw new TypeError(`Provenance.sourceKind must be one of ${SOURCE_KINDS.join(", ")}`);
  }
  for (const key of ["sourceVersion", "adapterVersion"]) {
    if (fields[key] !== undefined && typeof fields[key] !== "string") {
      throw new TypeError(`Provenance.${key} must be a string when present`);
    }
  }
  if (fields.derivation !== undefined && !DERIVATIONS.includes(/** @type {string} */ (fields.derivation))) {
    throw new TypeError(`Provenance.derivation must be one of ${DERIVATIONS.join(", ")}`);
  }
  return Object.freeze({ ...fields });
}

const RESOLVED_CONFIGURATION_FIELDS = Object.freeze(["runtimeId", "axes", "representation"]);
const REPRESENTATION_FIELDS = Object.freeze(["kind", "provenance"]);

/**
 * @typedef {object} ResolvedRuntimeConfiguration
 * @property {string} runtimeId A `RUNTIMES` id.
 * @property {Record<string, unknown>} axes Runtime-native values, opaque to every module but the adapter (ARCH-17).
 * @property {{kind: "stable-alias"|"native-id"|"opaque-selector", provenance: Provenance}} representation
 */

/**
 * Build a frozen resolved configuration. Axis names and values are opaque: no
 * universal axis enum exists, and nothing here parses an identifier (ARCH-1, ARCH-17).
 * @param {ResolvedRuntimeConfiguration} input
 * @returns {Readonly<ResolvedRuntimeConfiguration>}
 */
export function makeResolvedRuntimeConfiguration(input) {
  const fields = assertKnownFields("ResolvedRuntimeConfiguration", input, RESOLVED_CONFIGURATION_FIELDS);
  if (!isRuntimeId(fields.runtimeId)) {
    throw new TypeError(`ResolvedRuntimeConfiguration.runtimeId must be one of ${RUNTIME_IDS.join(", ")}`);
  }
  const axes = fields.axes;
  if (typeof axes !== "object" || axes === null || Array.isArray(axes) || Object.keys(axes).length === 0) {
    throw new TypeError("ResolvedRuntimeConfiguration.axes must be a non-empty object");
  }
  const representation = assertKnownFields("ResolvedRuntimeConfiguration.representation", fields.representation, REPRESENTATION_FIELDS);
  if (!REPRESENTATION_KINDS.includes(/** @type {string} */ (representation.kind))) {
    throw new TypeError(`ResolvedRuntimeConfiguration.representation.kind must be one of ${REPRESENTATION_KINDS.join(", ")}`);
  }
  return Object.freeze({
    runtimeId: fields.runtimeId,
    axes: Object.freeze({ ...axes }),
    representation: Object.freeze({
      kind: representation.kind,
      provenance: makeProvenance(/** @type {Provenance} */ (representation.provenance)),
    }),
  });
}

/**
 * @typedef {object} NormalizedComputeRequirement
 * @property {string} [requirement] A `WORKLOAD_CLASSES` value; absent for `inherit`.
 * @property {"self"|"session"|"consumer"} binding
 * @property {"dynamic"|"floor"|"pin"|"inherit"} mode
 * @property {{runtime: string, config: Record<string, unknown>}} [pin]
 * @property {string} [rationale]
 * @property {Provenance} provenance
 */

/**
 * @typedef {object} AdapterDiagnostic
 * @property {string} code Machine-readable, stable within a release line (OPS-3).
 * @property {string} message
 * @property {boolean} [retryable]
 */

/**
 * @template T
 * @typedef {object} AdapterResult
 * @property {"ok"|"unsupported"|"unavailable"|"unknown"} status
 * @property {T} [evidence]
 * @property {Provenance} provenance
 * @property {string} [observedAt] ISO 8601 time of the observation.
 * @property {AdapterDiagnostic} [diagnostic]
 */

/**
 * @template T
 * @typedef {object} CatalogEvidence
 * @property {T} value
 * @property {Provenance} provenance
 * @property {string} [observedAt]
 * @property {"fresh"|"stale"|"expired"|"unknown"} freshness
 * @property {string} confidence
 * @property {"available"|"unavailable"|"unknown"} availability
 * @property {"idle"|"in_progress"} refresh
 */

/**
 * @typedef {object} ResolutionReason
 * @property {string} code
 * @property {string} message
 * @property {Provenance} [provenance]
 */

/**
 * @typedef {object} ResolverResult
 * @property {"resolved"|"unresolved"|"conflict"|"invalid"} status
 * @property {ResolvedRuntimeConfiguration} [configuration]
 * @property {{state: string, basis: string}} enforcement
 * @property {string} confidence
 * @property {ResolutionReason[]} explanation
 * @property {AdapterDiagnostic[]} diagnostics
 */
