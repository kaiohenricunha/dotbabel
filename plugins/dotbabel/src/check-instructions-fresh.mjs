import { generateInstructions } from "./generate-instructions.mjs";
import {
  pathExists,
  readText,
} from "./spec-harness-lib.mjs";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

/**
 * Verify generated cross-CLI instruction outputs match a fresh render from
 * CLAUDE.md.
 *
 * @param {object} ctx  Harness context from createHarnessContext().
 * @param {ReturnType<typeof generateInstructions>} [precomputed]
 *   Optional generator output to reuse — pass when the caller has already
 *   rendered the targets to avoid a second full render.
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function checkInstructionsFresh(ctx, precomputed) {
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
    if (!pathExists(ctx, file.path)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.DRIFT_GENERATED_STALE,
        category: "drift",
        file: file.path,
        message: `generated instruction file is missing -> ${file.path}`,
        hint: "run `npx dotbabel-generate-instructions` and commit the generated output",
      }));
      continue;
    }

    const current = readText(ctx, file.path);
    if (current !== file.content) {
      errors.push(new ValidationError({
        code: ERROR_CODES.DRIFT_GENERATED_STALE,
        category: "drift",
        file: file.path,
        message: `generated instruction file is stale -> ${file.path}`,
        hint: "run `npx dotbabel-generate-instructions` and commit the generated output",
      }));
    }
  }

  return { ok: errors.length === 0, errors };
}

export { ERROR_CODES };
