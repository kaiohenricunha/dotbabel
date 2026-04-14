import path from "path";
import {
  loadFacts,
  pathExists,
  readText,
} from "./spec-harness-lib.mjs";

/**
 * Cross-reference docs/repo-facts.json against instruction files (CLAUDE.md, README.md, etc.).
 *
 * Checks performed:
 *  - instruction_files is a non-empty array in repo-facts.json
 *  - each instruction file listed in repo-facts.json exists on disk
 *  - each instruction file mentions the team_count value (stale-number detection)
 *  - each entry in protected_paths appears literally in CLAUDE.md (so docs don't drift from facts)
 *  - protected_paths entries are non-empty strings
 *
 * The port omits the loadSourceFacts() cross-check from squadranks (which reads src/data.js
 * and src/i18n.js — project-specific to wc-squad-rankings). The harness treats repo-facts.json
 * itself as the authoritative source and checks that instruction files stay in sync with it.
 *
 * @param {object} ctx  Harness context from createHarnessContext().
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkInstructionDrift(ctx) {
  const errors = [];
  const facts = loadFacts(ctx);

  // instruction_files must be a non-empty array.
  if (!Array.isArray(facts.instruction_files) || facts.instruction_files.length === 0) {
    errors.push(
      "docs/repo-facts.json: instruction_files must be a non-empty array of file paths",
    );
    // Can't proceed without knowing which files to check.
    return { ok: false, errors };
  }

  // protected_paths entries must be non-empty strings.
  for (const protectedPath of facts.protected_paths ?? []) {
    if (typeof protectedPath !== "string" || !protectedPath.trim()) {
      errors.push(
        `docs/repo-facts.json: protected_paths entries must be non-empty strings (got ${JSON.stringify(protectedPath)})`,
      );
    }
  }

  const teamCount = facts.team_count;

  // Check each instruction file.
  for (const instructionFile of facts.instruction_files) {
    if (typeof instructionFile !== "string" || !instructionFile.trim()) {
      errors.push(
        `docs/repo-facts.json: instruction_files entries must be non-empty strings`,
      );
      continue;
    }

    if (!pathExists(ctx, instructionFile)) {
      errors.push(
        `docs/repo-facts.json: instruction file does not exist -> ${instructionFile}`,
      );
      continue;
    }

    const text = readText(ctx, instructionFile);

    // team_count drift: if any "N team(s)" phrase exists in the file with N != team_count, flag it.
    if (typeof teamCount === "number") {
      const teamPhrasePattern = /(\d+)\s+teams?/gi;
      for (const match of text.matchAll(teamPhrasePattern)) {
        const mentioned = parseInt(match[1], 10);
        if (mentioned !== teamCount) {
          errors.push(
            `${instructionFile}: stale team_count claim — file mentions "${match[0]}" but docs/repo-facts.json has team_count=${teamCount}`,
          );
        }
      }
    }
  }

  // protected_paths drift: every protected path in repo-facts must appear literally in CLAUDE.md.
  // This ensures the canonical instruction doc stays in sync when facts change.
  const claudeMdPath = "CLAUDE.md";
  if (pathExists(ctx, claudeMdPath) && Array.isArray(facts.protected_paths)) {
    const claudeText = readText(ctx, claudeMdPath);
    for (const protectedPath of facts.protected_paths) {
      if (typeof protectedPath !== "string" || !protectedPath.trim()) continue;
      if (!claudeText.includes(protectedPath)) {
        errors.push(
          `CLAUDE.md: protected path "${protectedPath}" from docs/repo-facts.json is not documented`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
