/**
 * List the `acceptance_criteria` of one spec, or of every spec that declares
 * any, for `dotbabel criteria list` (P-B2). Unlike `verifyCriteria`, this
 * never runs a command and never reads a test file — it only reports what
 * `spec.json` declares, sorted the same way REL-5 sorts a verify payload
 * (specs by id, criteria by number, tests by file then name) so the two
 * outputs stay comparable.
 */
import { readJson, listSpecDirs } from "../spec-harness-lib.mjs";
import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";
import { criterionNumber } from "./verify.mjs";

/**
 * @param {object} ctx Harness context from `createHarnessContext`.
 * @param {{ specId?: string }} [opts]
 * @returns {{ schema_version: 1, specs: Array<{ id: string, criteria: Array<object> }> }}
 */
export function listCriteria(ctx, opts = {}) {
  const { specId } = opts;
  const ids = specId ? [specId] : listSpecDirs(ctx);

  if (specId) {
    try {
      readJson(ctx, `docs/specs/${specId}/spec.json`);
    } catch {
      throw new ValidationError({
        code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC,
        category: "criteria",
        message: `unknown spec: ${specId}`,
      });
    }
  }

  const specs = ids
    .map((id) => ({ id, spec: readJson(ctx, `docs/specs/${id}/spec.json`) }))
    .filter(({ spec }) => Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length > 0)
    .map(({ id, spec }) => ({
      id,
      criteria: [...spec.acceptance_criteria]
        .sort((a, b) => criterionNumber(a.id) - criterionNumber(b.id))
        .map((criterion) => ({
          id: criterion.id,
          status: criterion.status ?? "active",
          given: criterion.given,
          when: criterion.when,
          then: criterion.then,
          tests: [...(criterion.tests ?? [])].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
          argv: criterion.argv,
        })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { schema_version: 1, specs };
}
