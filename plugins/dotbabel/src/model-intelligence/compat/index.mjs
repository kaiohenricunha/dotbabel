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

/** An ambiguous legacy declaration that a human must resolve. */
export const MI_LEGACY_AMBIGUOUS = "MI_LEGACY_AMBIGUOUS";

/** A canonical declaration and a legacy value whose known meanings disagree. */
export const MI_DUAL_DECLARATION_CONFLICT = "MI_DUAL_DECLARATION_CONFLICT";

/** What the compat layer concluded about one artifact. */
export const LEGACY_DISPOSITIONS = Object.freeze(["mapped", "inherit", "ambiguous", "conflict", "absent"]);

/**
 * The only legacy model aliases whose meaning is known.
 *
 * These four are the entire enum the shipped gate accepted
 * (`validate-skills-inventory.mjs`), so anything else was never valid and is
 * ambiguous rather than translatable. The mapping is to a workload class, not to
 * a model: `opus` meant "the strongest tier available", which is what `frontier`
 * states without naming a vendor's product.
 */
const ALIAS_CLASS = Object.freeze({
  haiku: "mechanical",
  sonnet: "routine",
  opus: "frontier",
});

/**
 * Where a legacy declaration bound compute, per artifact kind.
 *
 * DOC-2 measured all three: an agent `model:` binds that subagent, a command
 * `model:` moves the whole session, and a skill `model:` is inert. The skill row
 * is `consumer` because the requirement still describes the work (ARCH-37) even
 * though it never bound anything.
 */
const KIND_BINDING = Object.freeze({
  agent: "self",
  command: "session",
  skill: "consumer",
  workflow: "session",
});

/**
 * Legacy effort values that were legal in the shipped schema.
 * They refine nothing on their own: no workload class follows from an effort.
 */
const KNOWN_EFFORTS = Object.freeze(["low", "medium", "max"]);

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

  /** @type {{model?: string, effort?: string}} */
  const legacyValues = {};
  if (model !== undefined) legacyValues.model = model;
  if (effort !== undefined) legacyValues.effort = effort;

  /** @type {string[]} */
  const codes = [];
  /** @type {string[]} */
  const notes = [];

  if (model === undefined && effort === undefined) {
    return { disposition: "absent", requirement: null, legacy: legacyValues, codes, notes };
  }

  const binding = KIND_BINDING[artifactKind] ?? "consumer";
  const provenance = makeProvenance({
    sourceId: sourcePath,
    sourceKind: "artifact",
    // Marks the requirement as derived from legacy metadata rather than declared,
    // so a later reader can tell an inferred requirement from an authored one.
    adapterVersion: "legacy",
  });

  if (artifactKind === "skill") {
    notes.push("a skill model/effort value is inert at runtime and is not a native binding; the requirement describes the enclosing compute context");
  }

  if (model === "inherit") {
    if (effort !== undefined) {
      notes.push(`effort "${effort}" accompanies model inherit and states no requirement of its own`);
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
    codes.push(MI_LEGACY_AMBIGUOUS);
    notes.push(`effort "${effort}" alone states no workload class; no requirement can be derived from it`);
    return { disposition: "ambiguous", requirement: null, legacy: legacyValues, codes, notes };
  }

  const workloadClass = ALIAS_CLASS[model];
  if (workloadClass === undefined) {
    codes.push(MI_LEGACY_AMBIGUOUS);
    notes.push(`model "${model}" is not one of the aliases the shipped gate accepted, so its intended capability level is unknown`);
    return { disposition: "ambiguous", requirement: null, legacy: legacyValues, codes, notes };
  }

  if (effort !== undefined && !KNOWN_EFFORTS.includes(effort)) {
    codes.push(MI_LEGACY_AMBIGUOUS);
    notes.push(`effort "${effort}" is outside the shipped enum, so the declaration cannot be read as a whole`);
    return { disposition: "ambiguous", requirement: null, legacy: legacyValues, codes, notes };
  }

  if (effort !== undefined) {
    notes.push(`effort "${effort}" is preserved as authoring intent; no workload class follows from an effort value`);
  }

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
 * @param {{parseComputeDeclaration?: Function}} [deps] Injected for testing; defaults to the canonical parser.
 * @returns {{artifacts: object[], totals: Record<string, number>}}
 */
export function analyzeMigration(inputs, deps = {}) {
  const parse = deps.parseComputeDeclaration ?? parseComputeDeclaration;
  /** @type {object[]} */
  const artifacts = [];
  /** @type {Record<string, number>} */
  const totals = Object.fromEntries(LEGACY_DISPOSITIONS.map((disposition) => [disposition, 0]));

  for (const input of inputs) {
    const { sourcePath, artifactKind, frontmatter } = input;
    const canonical = parse(frontmatter, { sourcePath });
    const reading = interpretLegacy(frontmatter, { sourcePath, artifactKind });
    const conflict = detectDualDeclarationConflict(canonical.requirement, reading);

    let disposition = reading.disposition;
    if (conflict) disposition = "conflict";

    /** @type {object} */
    const entry = {
      sourcePath,
      artifactKind,
      disposition,
      legacy: reading.legacy,
      codes: conflict ? [...reading.codes, conflict.code] : reading.codes,
      notes: reading.notes,
    };
    if (conflict) entry.conflict = conflict;
    if (canonical.declared) entry.declared = true;
    if (!conflict && (disposition === "mapped" || disposition === "inherit")) {
      entry.proposed = toDeclaration(reading.requirement);
    }
    artifacts.push(entry);
    totals[disposition] += 1;
  }

  return { artifacts, totals };
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
