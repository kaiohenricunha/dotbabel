/**
 * SEC-1's second clause: for a `--pr` run, exit 2 when an author outside
 * `criteria.trusted_associations` changed an active criterion's `argv`
 * between the PR's base and head, unless `--allow-project-commands` is set.
 *
 * Design, since nothing in this repository already does this:
 *
 * - Attribution is per COMMIT via GitHub's own `.author.login` on
 *   `GET /repos/{repo}/commits/{sha}` (which resolves the commit's email to
 *   a GitHub account, or null if none matches), not the PR-level
 *   `authorAssociation` local-attest and the merge gate use elsewhere. A pull
 *   request has exactly one author association, but its commits do not all
 *   have to be authored by that person — a maintainer can push a commit
 *   authored by someone else into a PR they opened, or the PR's own commits
 *   can be rebased/amended by a collaborator with push access to the branch.
 *   The threat this check exists for is "who actually wrote this argv",
 *   which is a per-commit fact, not a per-PR one.
 * - A commit whose email GitHub cannot map to an account resolves
 *   `.author.login` to `null`. This fails CLOSED (treated as untrusted)
 *   rather than skipped: an unattributable change to a criterion's argv is
 *   exactly the case this check must not wave through silently.
 * - Only `docs/specs/**\/spec.json` files are inspected, and within them only
 *   criteria whose `status` is `"active"` at the head ref — a `"planned"`
 *   criterion's argv is inert until it is promoted, so a change to it carries
 *   no execution risk yet.
 */
import { PERM_TO_ASSOC } from "../lib/perm-to-assoc.mjs";

/**
 * @typedef {object} TrustCheckDeps
 * @property {(cmd: string) => string} capture Run a command, return trimmed stdout. Throws on non-zero exit.
 */

/**
 * @param {TrustCheckDeps} deps
 * @param {{ baseSha: string, headSha: string, repo: string, trustedAssociations: string[] }} args
 * @returns {{ commit: string, specPath: string, criterionId: string, login: string|null, association: string|null } | null}
 *   A description of the first untrusted argv change found, or null when every change is trusted.
 */
export function findUntrustedArgvChange(deps, { baseSha, headSha, repo, trustedAssociations }) {
  const changedFiles = deps
    .capture(`git log ${baseSha}..${headSha} --format= --name-only -- 'docs/specs/**/spec.json'`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const specPaths = [...new Set(changedFiles)];
  if (specPaths.length === 0) return null;

  const commits = deps
    .capture(`git log ${baseSha}..${headSha} --format=%H -- ${specPaths.map((p) => `'${p}'`).join(" ")}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (commits.length === 0) return null;

  const trusted = new Set(trustedAssociations);
  const loginAssociationCache = new Map();

  for (const specPath of specPaths) {
    let activeIds;
    try {
      activeIds = new Set(
        JSON.parse(deps.capture(`git show ${headSha}:${specPath}`)).acceptance_criteria
          .filter((c) => (c.status ?? "active") === "active")
          .map((c) => c.id),
      );
    } catch {
      // The spec file may not exist at head (deleted mid-PR) or may not
      // parse — either way there is no active criterion left to protect.
      continue;
    }
    if (activeIds.size === 0) continue;

    for (const commit of commits) {
      let before;
      let after;
      try {
        before = JSON.parse(deps.capture(`git show ${commit}^:${specPath}`)).acceptance_criteria ?? [];
      } catch {
        before = [];
      }
      try {
        after = JSON.parse(deps.capture(`git show ${commit}:${specPath}`)).acceptance_criteria ?? [];
      } catch {
        continue;
      }
      const beforeById = new Map(before.map((c) => [c.id, c]));

      for (const criterion of after) {
        if (!activeIds.has(criterion.id)) continue;
        const prior = beforeById.get(criterion.id);
        const priorArgv = JSON.stringify(prior?.argv ?? null);
        const nextArgv = JSON.stringify(criterion.argv ?? null);
        if (priorArgv === nextArgv) continue;

        let login = null;
        try {
          const raw = deps.capture(`gh api repos/${repo}/commits/${commit} --jq .author.login`).trim();
          login = raw === "" || raw === "null" ? null : raw;
        } catch {
          login = null;
        }

        let association = null;
        if (login !== null) {
          if (loginAssociationCache.has(login)) {
            association = loginAssociationCache.get(login);
          } else {
            try {
              const perm = deps.capture(`gh api repos/${repo}/collaborators/${login}/permission --jq .permission`).trim().toUpperCase();
              association = PERM_TO_ASSOC[perm] ?? perm;
            } catch {
              association = null;
            }
            loginAssociationCache.set(login, association);
          }
        }

        if (association === null || !trusted.has(association)) {
          return { commit, specPath, criterionId: criterion.id, login, association };
        }
      }
    }
  }

  return null;
}
