import { generateInstructions } from "./generate-instructions.mjs";
import {
  pathExists,
  readText,
} from "./spec-harness-lib.mjs";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

const HEADING_RE = /^(#{1,2})\s+(.+?)\s*$/;
const FENCE_RE = /^([`~]{3,})/;

/**
 * Verify generated cross-CLI instruction outputs preserve every heading that
 * should apply to that CLI target.
 *
 * @param {object} ctx  Harness context from createHarnessContext().
 * @returns {{ ok: boolean, errors: ValidationError[] }}
 */
export function checkInstructionParity(ctx) {
  const errors = [];
  let generated;

  try {
    generated = generateInstructions(ctx, { dryRun: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      errors.push(err);
      return { ok: false, errors };
    }
    throw err;
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

    const currentHeadings = extractHeadings(readText(ctx, file.path));
    const currentSet = new Set(currentHeadings.map(normalizeHeading));
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

function extractHeadings(markdown) {
  const headings = [];
  let openFence = null;

  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(FENCE_RE);
    if (openFence === null && fenceMatch) {
      openFence = fenceMatch[1];
      continue;
    }
    if (openFence !== null) {
      if (
        fenceMatch &&
        fenceMatch[1].length >= openFence.length &&
        fenceMatch[1][0] === openFence[0]
      ) {
        openFence = null;
      }
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) headings.push(headingMatch[2]);
  }

  return headings;
}

export { ERROR_CODES };
