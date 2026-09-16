import { loadFacts } from "./spec-harness-lib.mjs";

/**
 * Warn a consumer repo whose `docs/repo-facts.json` still gives a value to
 * either key removed by P-C5 (KD-9):
 *
 *  - `regression_paths` — superseded by the quality system's `critical_paths`
 *    (KD-6), which escalates the full test suite for a matching change
 *    instead of only diffing the changed file at merge time.
 *  - `verification_commands` — never had a consumer.
 *
 * Never fails: a repository that kept one of these keys around is carrying
 * dead configuration, not broken configuration, so `dotbabel doctor` warns
 * and names the replacement rather than reddening.
 *
 * @param {import('./spec-harness-lib.mjs').HarnessContext} ctx
 * @returns {{ ok: boolean, warnings: string[] }}
 */
export function checkRemovedRepoFactsKeys(ctx) {
  const facts = loadFacts(ctx);
  const warnings = [];

  if (isNonEmpty(facts.regression_paths)) {
    warnings.push(
      "docs/repo-facts.json sets regression_paths, which was removed — the quality system's " +
        "critical_paths (.dotbabel.json quality.critical_paths) now escalates the full test " +
        "suite for a matching change, and merge-pr's step 5 runs the PR quality profile in " +
        "its place. Remove the key.",
    );
  }
  if (isNonEmpty(facts.verification_commands)) {
    warnings.push("docs/repo-facts.json sets verification_commands, which was removed and never had a consumer. Remove the key.");
  }

  return { ok: warnings.length === 0, warnings };
}

/** @param {unknown} value @returns {boolean} */
function isNonEmpty(value) {
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
