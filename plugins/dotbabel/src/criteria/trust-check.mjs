/**
 * SEC-1's second clause: compare each linked spec at the pull request base and
 * head. An untrusted pull request author cannot add executable criteria,
 * promote planned criteria, or change an active criterion's `argv`.
 *
 * Git commands always use argument arrays. No repository-controlled path or
 * identifier reaches a shell. Pull request association is used instead of
 * commit email attribution because a committer can select any author email.
 */
import { isActiveCriterion } from "./load.mjs";

/**
 * @typedef {object} TrustCheckDeps
 * @property {(argv: string[]) => string} capture Run a command without a shell and return trimmed stdout.
 */

function readCriteriaAt(deps, sha, specPath) {
  const parsed = JSON.parse(deps.capture(["git", "show", `${sha}:${specPath}`]));
  return Array.isArray(parsed?.acceptance_criteria) ? parsed.acceptance_criteria : [];
}

/**
 * @param {TrustCheckDeps} deps
 * @param {{ baseSha: string, headSha: string, specIds: string[], prAssociation: string|null, trustedAssociations: string[] }} args
 * @returns {{ specId: string, specPath: string, criterionId: string|null, reason: string } | null}
 *   A description of the first untrusted executable change, or null.
 */
export function findUntrustedArgvChange(deps, { baseSha, headSha, specIds, prAssociation, trustedAssociations }) {
  if (prAssociation !== null && new Set(trustedAssociations).has(prAssociation)) return null;

  for (const specId of specIds) {
    const specPath = `docs/specs/${specId}/spec.json`;
    let headCriteria;
    try {
      headCriteria = readCriteriaAt(deps, headSha, specPath);
    } catch {
      return { specId, specPath, criterionId: null, reason: "spec.json does not parse at head" };
    }

    let baseCriteria;
    try {
      baseCriteria = readCriteriaAt(deps, baseSha, specPath);
    } catch {
      baseCriteria = [];
    }
    const baseActiveById = new Map(baseCriteria.filter(isActiveCriterion).map((criterion) => [criterion.id, criterion]));

    for (const criterion of headCriteria.filter(isActiveCriterion)) {
      const prior = baseActiveById.get(criterion.id);
      if (!prior) return { specId, specPath, criterionId: criterion.id, reason: "new active criterion" };
      if (JSON.stringify(prior.argv ?? null) !== JSON.stringify(criterion.argv ?? null)) {
        return { specId, specPath, criterionId: criterion.id, reason: "argv changed" };
      }
    }
  }

  return null;
}
