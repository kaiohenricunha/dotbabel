/**
 * model-intelligence/compat — read the legacy `model:` / `effort:` frontmatter
 * that Dotbabel shipped before `dotbabel.compute`, and report what it means
 * (docs/specs/model-intelligence, §4 KD-1 and §6.5).
 *
 * This layer is transitional (ARCH-19). It interprets a legacy declaration only
 * where the meaning is known, and it marks every other case explicitly rather
 * than guessing (ARCH-18): a migration that quietly invents a requirement is the
 * failure mode §6.5 exists to prevent, and PB-1 through PB-13 depend on it not
 * happening.
 *
 * Pure: it is handed already-parsed frontmatter and returns a report. It reads
 * no file and writes none (ARCH-56).
 */

import { WORKLOAD_CLASSES, compareWorkloadClass, makeProvenance } from "../domain/index.mjs";
import { parseComputeDeclaration } from "../requirement/index.mjs";

/**
 * Why a legacy declaration could not be read. Three distinct causes, because
 * `migrate --write` in P-18 must treat them differently: an effort with no model
 * is safe to drop, an unknown alias is an owner decision, and a known alias with
 * an unknown effort is an author typo. One code would force a consumer to parse
 * the prose note, which is presentation and not a contract.
 */
export const MI_LEGACY_EFFORT_WITHOUT_MODEL = "MI_LEGACY_EFFORT_WITHOUT_MODEL";

/** The `model:` value is outside the four aliases the shipped gate accepted. */
export const MI_LEGACY_MODEL_UNKNOWN = "MI_LEGACY_MODEL_UNKNOWN";

/** The `effort:` value is outside the shipped enum, so the pair cannot be read. */
export const MI_LEGACY_EFFORT_UNKNOWN = "MI_LEGACY_EFFORT_UNKNOWN";

/** The artifact's canonical `dotbabel.compute` does not parse. */
export const MI_DECLARATION_INVALID = "MI_DECLARATION_INVALID";

/**
 * The workload class or the mode in a proposal was defaulted from the alias alone,
 * not taken from an owner decision. DOC-1 assigns a class per artifact from its
 * authored rationale — `opus` is Deep on one agent, Frontier on another, and
 * Exceptional on a third — and it keeps six entries pinned and thirteen
 * undecided. A proposal carrying this code is report-only: `--write` must refuse
 * it until IMPL-7 resolves the artifact.
 */
export const MI_PROPOSAL_DEFAULTED = "MI_PROPOSAL_DEFAULTED";

/** A canonical declaration and a legacy value whose known meanings disagree. */
export const MI_DUAL_DECLARATION_CONFLICT = "MI_DUAL_DECLARATION_CONFLICT";

/** What the compat layer concluded about one artifact. */
export const LEGACY_DISPOSITIONS = Object.freeze([
  "mapped",
  "inherit",
  "ambiguous",
  "conflict",
  "invalid-declaration",
  "absent",
]);

/**
 * Artifact kinds that can carry a compute declaration.
 *
 * Derived from `KIND_BINDING` so the library holds one answer: a caller that
 * filters a tree and a caller that interprets one artifact cannot disagree about
 * whether a kind is in scope (IMPL-4).
 */
export const MIGRATABLE_ARTIFACT_KINDS = Object.freeze(["agent", "command", "skill", "workflow"]);

/**
 * Tell whether an artifact kind can carry a compute declaration.
 * @param {string} artifactKind
 * @returns {boolean}
 */
export function canCarryComputeDeclaration(artifactKind) {
  return MIGRATABLE_ARTIFACT_KINDS.includes(artifactKind);
}

/**
 * The only legacy model aliases whose meaning is known.
 *
 * These four are the entire enum the shipped gate accepted
 * (`validate-skills-inventory.mjs`), so anything else was never valid and is
 * ambiguous rather than translatable. The mapping is to a workload class, not to
 * a model: `opus` meant "the strongest tier available", which is what `frontier`
 * states without naming a vendor's product.
 */
const ALIAS_CLASS = Object.freeze(
  Object.assign(Object.create(null), {
    haiku: "mechanical",
    sonnet: "routine",
    opus: "frontier",
  }),
);

/**
 * Where a legacy declaration bound compute, per artifact kind.
 *
 * DOC-2 measured all three: an agent `model:` binds that subagent, a command
 * `model:` moves the whole session, and a skill `model:` is inert. The skill row
 * is `consumer` because the requirement still describes the work (ARCH-37) even
 * though it never bound anything.
 */
const KIND_BINDING = Object.freeze(
  Object.assign(Object.create(null), {
    agent: "self",
    command: "session",
    skill: "consumer",
    workflow: "session",
  }),
);

/**
 * Legacy effort values that were legal in the shipped schema.
 * They refine nothing on their own: no workload class follows from an effort.
 */
const KNOWN_EFFORTS = Object.freeze(["low", "medium", "max"]);

/**
 * Render an author-controlled value for a human-readable note.
 *
 * The value is an arbitrary YAML scalar: it may carry newlines, terminal escapes,
 * or a secret an author pasted by mistake, and it reaches a terminal and a JSON
 * report verbatim. The sibling canonical parser already caps and type-reports
 * rather than echoing (`../requirement/index.mjs`, OPS-4); this is the same
 * discipline for the layer that handles the less trustworthy input of the two.
 * @param {string} value
 * @returns {string} A quoted, escaped, length-bounded rendering.
 */
function forDisplay(value) {
  return JSON.stringify(value.replace(/[\p{Cc}\p{Cf}]/gu, "\uFFFD").slice(0, 80));
}

/**
 * @typedef {object} LegacyReading
 * @property {"mapped"|"inherit"|"ambiguous"|"conflict"|"absent"} disposition
 * @property {import("../domain/index.mjs").NormalizedComputeRequirement | null} requirement
 *   The interpreted requirement, or `null` when nothing can be stated safely.
 * @property {{model?: string, effort?: string}} legacy The values as authored.
 * @property {string[]} codes Stable codes for the cases a human must resolve.
 * @property {string[]} notes Human-readable observations, never a contract.
 */

/**
 * Interpret one artifact's legacy `model:` / `effort:` frontmatter.
 *
 * A known alias becomes a `floor`, not a `dynamic` requirement: the shipped
 * value was a deliberate choice by the artifact's author, and §6.5 step 8 keeps
 * an intentional pin or floor intact through the migration rather than relaxing
 * it to "whatever satisfies the class today".
 * @param {Record<string, unknown> | null | undefined} frontmatter Parsed frontmatter.
 * @param {{sourcePath: string, artifactKind: string}} options
 * @returns {LegacyReading}
 */
export function interpretLegacy(frontmatter, options) {
  const sourcePath = options?.sourcePath;
  const artifactKind = options?.artifactKind;
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw new TypeError("interpretLegacy requires options.sourcePath");
  }
  if (typeof artifactKind !== "string" || artifactKind.trim() === "") {
    throw new TypeError("interpretLegacy requires options.artifactKind");
  }

  const fields = frontmatter && typeof frontmatter === "object" ? frontmatter : {};
  const model = typeof fields.model === "string" ? fields.model.trim() : undefined;
  const effort = typeof fields.effort === "string" ? fields.effort.trim() : undefined;

  // Bounded and control-character-free, for the same reason as `forDisplay`: this
  // object is echoed into the JSON report and into a terminal.
  const bound = (value) => value.replace(/[\p{Cc}\p{Cf}]/gu, "\uFFFD").slice(0, 80);
  /** @type {{model?: string, effort?: string}} */
  const legacyValues = {};
  if (model !== undefined) legacyValues.model = bound(model);
  if (effort !== undefined) legacyValues.effort = bound(effort);

  /** @type {string[]} */
  const codes = [];
  /** @type {string[]} */
  const notes = [];

  if (model === undefined && effort === undefined) {
    return { disposition: "absent", requirement: null, legacy: legacyValues, codes, notes };
  }

  const binding = Object.hasOwn(KIND_BINDING, artifactKind) ? KIND_BINDING[artifactKind] : "consumer";
  const provenance = makeProvenance({
    sourceId: sourcePath,
    sourceKind: "artifact",
    // An inference, not an authored decision. `sourceKind` cannot carry the
    // difference, because an authored declaration is also `artifact` (ARCH-18).
    derivation: "legacy-inferred",
  });

  if (artifactKind === "skill") {
    notes.push("a skill model/effort value is inert at runtime and is not a native binding; the requirement describes the enclosing compute context");
  }

  if (model === "inherit") {
    if (effort !== undefined) {
      notes.push(`effort ${forDisplay(effort)} accompanies model inherit and states no requirement of its own`);
    }
    return {
      disposition: "inherit",
      requirement: Object.freeze({ binding, mode: "inherit", provenance }),
      legacy: legacyValues,
      codes,
      notes,
    };
  }

  if (model === undefined) {
    codes.push(MI_LEGACY_EFFORT_WITHOUT_MODEL);
    notes.push(`effort ${forDisplay(effort)} alone states no workload class; no requirement can be derived from it`);
    return { disposition: "ambiguous", requirement: null, legacy: legacyValues, codes, notes };
  }

  const workloadClass = Object.hasOwn(ALIAS_CLASS, model) ? ALIAS_CLASS[model] : undefined;
  if (workloadClass === undefined) {
    codes.push(MI_LEGACY_MODEL_UNKNOWN);
    notes.push(`model ${forDisplay(model)} is not one of the aliases the shipped gate accepted, so its intended capability level is unknown`);
    return { disposition: "ambiguous", requirement: null, legacy: legacyValues, codes, notes };
  }

  if (effort !== undefined && !KNOWN_EFFORTS.includes(effort)) {
    codes.push(MI_LEGACY_EFFORT_UNKNOWN);
    notes.push(`effort ${forDisplay(effort)} is outside the shipped enum, so the declaration cannot be read as a whole`);
    return { disposition: "ambiguous", requirement: null, legacy: legacyValues, codes, notes };
  }

  if (effort !== undefined) {
    notes.push(`effort ${forDisplay(effort)} is preserved as authoring intent; no workload class follows from an effort value`);
  }

  // The class comes from the alias alone and the mode is a conservative default,
  // so both are flagged: DOC-1 decides the class per artifact and keeps some
  // entries pinned rather than floored, and only an owner decision settles which.
  codes.push(MI_PROPOSAL_DEFAULTED);
  notes.push(
    `class ${forDisplay(workloadClass)} and mode "floor" are defaulted from the alias; DOC-1 assigns the class per artifact and pins some, so an owner decision is required before this is written`,
  );
  return {
    disposition: "mapped",
    requirement: Object.freeze({ requirement: workloadClass, binding, mode: "floor", provenance }),
    legacy: legacyValues,
    codes,
    notes,
  };
}

/**
 * Compare a canonical declaration with a legacy reading of the same artifact.
 *
 * Only a known meaning can disagree: an ambiguous or absent legacy value is not
 * a conflict, because nothing was concluded from it. Rule 3 of KD-1 forbids
 * choosing a side, so this reports the mismatch and returns no winner.
 * @param {import("../domain/index.mjs").NormalizedComputeRequirement | null} declared
 * @param {LegacyReading | null} reading
 * @returns {{code: string, message: string, declared: string, legacy: string} | null}
 */
export function detectDualDeclarationConflict(declared, reading) {
  if (!declared || !reading || reading.requirement === null) return null;
  const declaredClass = declared.requirement;
  const legacyClass = reading.requirement.requirement;
  if (declaredClass === undefined || legacyClass === undefined) return null;
  if (!WORKLOAD_CLASSES.includes(declaredClass) || !WORKLOAD_CLASSES.includes(legacyClass)) return null;
  if (compareWorkloadClass(declaredClass, legacyClass) === 0) return null;
  return {
    code: MI_DUAL_DECLARATION_CONFLICT,
    message: `the canonical declaration requires "${declaredClass}" while the legacy value reads as "${legacyClass}"; resolve the artifact rather than letting one win`,
    declared: declaredClass,
    legacy: legacyClass,
  };
}

/**
 * @typedef {object} MigrationInput
 * @property {string} sourcePath
 * @property {string} artifactKind
 * @property {Record<string, unknown>} frontmatter
 */

/**
 * Analyse a set of artifacts and report what migrating each one would mean.
 *
 * Reports only. Nothing here writes an artifact: `migrate --write` arrives with
 * P-18, behind the batching and preserved-behaviour gates of IMPL-2.
 * @param {MigrationInput[]} inputs
 * @returns {{envelope: string, version: number, mode: string, artifacts: object[], totals: Record<string, number>}}
 */
export function analyzeMigration(inputs) {
  /** @type {object[]} */
  const artifacts = [];
  /** @type {Record<string, number>} */
  const totals = Object.fromEntries(LEGACY_DISPOSITIONS.map((disposition) => [disposition, 0]));

  for (const input of inputs) {
    const { sourcePath, artifactKind, frontmatter } = input;
    const canonical = parseComputeDeclaration(frontmatter, { sourcePath });
    const reading = interpretLegacy(frontmatter, { sourcePath, artifactKind });
    const conflict = detectDualDeclarationConflict(canonical.requirement, reading);
    // A canonical declaration that does not parse is worse than one that merely
    // disagrees, and it used to read as `mapped` with a proposal: `requirement` is
    // null, so the conflict check found nothing to compare (KD-1 rule 4).
    const declarationInvalid = canonical.errors.length > 0;

    let disposition = reading.disposition;
    if (conflict) disposition = "conflict";
    if (declarationInvalid) disposition = "invalid-declaration";

    /** @type {string[]} */
    const codes = [...reading.codes];
    if (conflict) codes.push(conflict.code);
    if (declarationInvalid) codes.push(MI_DECLARATION_INVALID);

    /** @type {object} */
    const entry = {
      sourcePath,
      artifactKind,
      disposition,
      declared: canonical.declared,
      legacy: reading.legacy,
      codes,
      notes: reading.notes,
    };
    if (conflict) entry.conflict = conflict;
    if (declarationInvalid) entry.declarationErrors = canonical.errors;
    // A proposal is emitted only when nothing is contested. It still carries
    // MI_PROPOSAL_DEFAULTED for a mapped entry, which is what makes it report-only.
    if (!conflict && !declarationInvalid && (disposition === "mapped" || disposition === "inherit")) {
      entry.proposed = toDeclaration(reading.requirement);
    }
    artifacts.push(entry);
    totals[disposition] += 1;
  }

  return { envelope: "MigrationReport", version: 1, mode: "analysis", artifacts, totals };
}

/**
 * Render a normalised requirement back into the frontmatter shape an author
 * would write, dropping the provenance the parser adds.
 * @param {Record<string, unknown>} requirement
 * @returns {Record<string, unknown>}
 */
function toDeclaration(requirement) {
  /** @type {Record<string, unknown>} */
  const declaration = {};
  for (const key of ["requirement", "binding", "mode", "pin", "rationale"]) {
    if (requirement[key] !== undefined) declaration[key] = requirement[key];
  }
  return declaration;
}
