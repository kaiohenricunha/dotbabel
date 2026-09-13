/**
 * Load `acceptance_criteria` for one spec, at verification time (Flow 2 step
 * 6, KD-1, KD-15). Unlike `validate-specs.mjs`'s shape-only check (P-A1),
 * this module reads each named test file and confirms the test name appears
 * in it — the check the shape validator deliberately defers.
 */
import { readJson, readText, pathExists } from "../spec-harness-lib.mjs";

/**
 * @typedef {object} LoadedCriterion
 * @property {string} id
 * @property {"active"} [status] Present only on a planned criterion, as "pending".
 * @property {string} given
 * @property {string} when
 * @property {string} then
 * @property {{file: string, name: string}[]} tests
 * @property {string[]} argv
 * @property {{format: "junit-xml", path: string}} [report]
 * @property {"pending"|"error"} [preStatus] Set when the criterion must not run.
 * @property {string} [errorMessage]
 */

/**
 * Load the criteria of one spec, split into criteria ready to run and
 * criteria that already have a final status without running anything.
 *
 * @param {object} ctx Harness context from `createHarnessContext`.
 * @param {string} specId
 * @returns {{ specId: string, runnable: LoadedCriterion[], resolved: LoadedCriterion[] }}
 */
export function loadCriteria(ctx, specId) {
  const spec = readJson(ctx, `docs/specs/${specId}/spec.json`);
  const all = spec.acceptance_criteria ?? [];
  const runnable = [];
  const resolved = [];

  for (const criterion of all) {
    const status = criterion.status ?? "active";
    if (status === "planned") {
      resolved.push({ ...criterion, preStatus: "pending" });
      continue;
    }
    const error = firstMissingTest(ctx, criterion);
    if (error) {
      resolved.push({ ...criterion, preStatus: "error", errorMessage: error });
      continue;
    }
    runnable.push(criterion);
  }

  return { specId, runnable, resolved };
}

function firstMissingTest(ctx, criterion) {
  for (const test of criterion.tests ?? []) {
    if (!pathExists(ctx, test.file)) {
      return `test file does not exist: ${test.file}`;
    }
    const content = readText(ctx, test.file);
    if (!content.includes(test.name)) {
      return `test name "${test.name}" does not appear in ${test.file}`;
    }
  }
  return null;
}
