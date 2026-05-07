import {
  loadFacts,
  pathExists,
  readText,
} from "./spec-harness-lib.mjs";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";
import {
  MANIFEST_RELATIVE_PATH,
} from "./generate-instructions.mjs";
import { checkInstructionsFresh } from "./check-instructions-fresh.mjs";

/**
 * Cross-reference docs/repo-facts.json against instruction files
 * (CLAUDE.md, README.md, AGENTS.md, GEMINI.md, generated user-scope rule-floor
 * templates, etc.).
 *
 * Checks performed:
 *  - instruction_files is a non-empty array in repo-facts.json
 *  - each instruction file listed in repo-facts.json exists on disk
 *  - each instruction file mentions the team_count value (stale-number detection)
 *  - each entry in protected_paths appears literally in every **rule-floor**
 *    file (so cross-CLI rule-floor copies do not drift from the facts).
 *    `rule_floor_files` is optional and defaults to `instruction_files` for
 *    back-compat; set it explicitly when some instruction files (e.g. a
 *    user-facing README) should be team-count-checked but NOT held to the
 *    protected_paths cross-CLI parity invariant.
 *  - protected_paths entries are non-empty strings
 *  - generated rule-floor outputs are fresh when the generator manifest exists
 *
 * The harness treats repo-facts.json as the authoritative source and checks that every
 * instruction file stays in sync with it. Validating protected_paths against every
 * rule-floor file is what makes cross-CLI parity enforceable: a protected_path that
 * lands in CLAUDE.md but not in AGENTS.md/GEMINI.md is detected here.
 *
 * @param {object} ctx  Harness context from createHarnessContext().
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function checkInstructionDrift(ctx) {
  const errors = [];
  const facts = loadFacts(ctx);

  // instruction_files must be a non-empty array.
  if (!Array.isArray(facts.instruction_files) || facts.instruction_files.length === 0) {
    errors.push(new ValidationError({
      code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
      category: "drift",
      file: "docs/repo-facts.json",
      pointer: "instruction_files",
      message: "instruction_files must be a non-empty array of file paths",
    }));
    // Can't proceed without knowing which files to check.
    return { ok: false, errors };
  }

  // protected_paths entries must be non-empty strings.
  for (const protectedPath of facts.protected_paths ?? []) {
    if (typeof protectedPath !== "string" || !protectedPath.trim()) {
      errors.push(new ValidationError({
        code: ERROR_CODES.DRIFT_PROTECTED_PATH,
        category: "drift",
        file: "docs/repo-facts.json",
        pointer: "protected_paths[]",
        got: JSON.stringify(protectedPath),
        message: `protected_paths entries must be non-empty strings (got ${JSON.stringify(protectedPath)})`,
      }));
    }
  }

  const teamCount = facts.team_count;

  // Check each instruction file.
  for (const instructionFile of facts.instruction_files) {
    if (typeof instructionFile !== "string" || !instructionFile.trim()) {
      errors.push(new ValidationError({
        code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
        category: "drift",
        file: "docs/repo-facts.json",
        pointer: "instruction_files[]",
        message: "instruction_files entries must be non-empty strings",
      }));
      continue;
    }

    if (!pathExists(ctx, instructionFile)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.DRIFT_INSTRUCTION_FILE_MISSING,
        category: "drift",
        file: "docs/repo-facts.json",
        pointer: "instruction_files[]",
        got: instructionFile,
        message: `instruction file does not exist -> ${instructionFile}`,
        hint: "create the file on disk or remove it from repo-facts.json",
      }));
      continue;
    }

    const text = readText(ctx, instructionFile);

    // team_count drift: if any "N team(s)" phrase exists in the file with N != team_count, flag it.
    if (typeof teamCount === "number") {
      const teamPhrasePattern = /(\d+)\s+teams?/gi;
      for (const match of text.matchAll(teamPhrasePattern)) {
        const mentioned = parseInt(match[1], 10);
        if (mentioned !== teamCount) {
          errors.push(new ValidationError({
            code: ERROR_CODES.DRIFT_TEAM_COUNT,
            category: "drift",
            file: instructionFile,
            expected: String(teamCount),
            got: match[0],
            message: `stale team_count claim — file mentions "${match[0]}" but docs/repo-facts.json has team_count=${teamCount}`,
          }));
        }
      }
    }
  }

  const ruleFloorFiles = resolveRuleFloorFiles(facts, errors);

  // protected_paths drift: every protected path in repo-facts must appear literally in EVERY
  // rule-floor file (CLAUDE.md, AGENTS.md, GEMINI.md, generated rule-floor templates, etc.).
  // Iterating every file is what makes cross-CLI parity enforceable — a path that lands in
  // CLAUDE.md but not in AGENTS.md is detected as drift here.
  if (Array.isArray(facts.protected_paths)) {
    for (const ruleFloorFile of ruleFloorFiles) {
      if (typeof ruleFloorFile !== "string" || !ruleFloorFile.trim()) continue;
      if (!pathExists(ctx, ruleFloorFile)) {
        errors.push(new ValidationError({
          code: ERROR_CODES.DRIFT_INSTRUCTION_FILE_MISSING,
          category: "drift",
          file: "docs/repo-facts.json",
          pointer: "rule_floor_files[]",
          got: ruleFloorFile,
          message: `rule-floor file does not exist -> ${ruleFloorFile}`,
          hint: "create the file on disk or remove it from repo-facts.json",
        }));
        continue;
      }
      const text = readText(ctx, ruleFloorFile);
      for (const protectedPath of facts.protected_paths) {
        if (typeof protectedPath !== "string" || !protectedPath.trim()) continue;
        if (!text.includes(protectedPath)) {
          errors.push(new ValidationError({
            code: ERROR_CODES.DRIFT_PROTECTED_PATH,
            category: "drift",
            file: ruleFloorFile,
            expected: protectedPath,
            message: `protected path "${protectedPath}" from docs/repo-facts.json is not documented in ${ruleFloorFile}`,
            hint: "add the protected path entry to the file or remove it from repo-facts.json (regenerate cross-CLI templates with `npx dotbabel-generate-instructions` after updating CLAUDE.md)",
          }));
        }
      }
    }
  }

  if (pathExists(ctx, MANIFEST_RELATIVE_PATH)) {
    errors.push(...checkInstructionsFresh(ctx).errors);
  }

  return { ok: errors.length === 0, errors };
}

function resolveRuleFloorFiles(facts, errors) {
  if (facts.rule_floor_files === undefined) return facts.instruction_files;

  if (!Array.isArray(facts.rule_floor_files) || facts.rule_floor_files.length === 0) {
    errors.push(new ValidationError({
      code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
      category: "drift",
      file: "docs/repo-facts.json",
      pointer: "rule_floor_files",
      message: "rule_floor_files must be a non-empty array of file paths when present",
    }));
    return [];
  }

  for (const ruleFloorFile of facts.rule_floor_files) {
    if (typeof ruleFloorFile !== "string" || !ruleFloorFile.trim()) {
      errors.push(new ValidationError({
        code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
        category: "drift",
        file: "docs/repo-facts.json",
        pointer: "rule_floor_files[]",
        message: "rule_floor_files entries must be non-empty strings",
      }));
    }
  }

  return facts.rule_floor_files;
}
