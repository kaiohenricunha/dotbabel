import {
  extractHeadings,
  generateInstructions,
} from "./generate-instructions.mjs";
import {
  pathExists,
  readText,
} from "./spec-harness-lib.mjs";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

/**
 * Verify generated cross-CLI instruction outputs preserve every heading that
 * should apply to that CLI target.
 *
 * @param {object} ctx  Harness context from createHarnessContext().
 * @param {ReturnType<typeof generateInstructions>} [precomputed]
 *   Optional generator output to reuse — pass when the caller has already
 *   rendered the targets to avoid a second full render.
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function checkInstructionParity(ctx, precomputed) {
  const errors = [];
  let generated = precomputed;

  if (!generated) {
    try {
      generated = generateInstructions(ctx, { dryRun: true });
    } catch (err) {
      if (err instanceof ValidationError) {
        errors.push(err);
        return { ok: false, errors };
      }
      throw err;
    }
  }

  for (const file of generated.files) {
    if (file.path.endsWith(".manifest.json")) continue;

    if (!pathExists(ctx, file.path)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.DRIFT_INSTRUCTION_FILE_MISSING,
        category: "drift",
        file: file.path,
        message: `instruction parity target is missing -> ${file.path}`,
        hint: "run `npx dotbabel-generate-instructions` and commit the generated output",
      }));
      continue;
    }

    const currentSet = new Set(
      extractHeadings(readText(ctx, file.path)).map(normalizeHeading),
    );
    for (const heading of extractHeadings(file.content)) {
      if (currentSet.has(normalizeHeading(heading))) continue;
      errors.push(new ValidationError({
        code: ERROR_CODES.DRIFT_PARITY_MISSING_HEADING,
        category: "drift",
        file: file.path,
        expected: heading,
        message: `instruction parity heading missing in ${file.path}: ${heading}`,
        hint: "restore the generated heading or run `npx dotbabel-generate-instructions`",
      }));
    }
  }

  return { ok: errors.length === 0, errors };
}

function normalizeHeading(heading) {
  return heading.trim().replace(/\s+/g, " ");
}

export { ERROR_CODES };
