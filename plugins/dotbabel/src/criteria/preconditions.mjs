/**
 * `--pr` preconditions for `dotbabel criteria verify` (§5, SEC-1). Mirrors
 * `local-attest-runner.mjs`'s `checkPreconditions` dependency-injection
 * pattern (a `deps` object exposing `run`) so this can be unit-tested without
 * a real repository or a real `gh` call.
 */
import { isRepoTrusted } from "../trust-allowlist.mjs";
import { findUntrustedArgvChange } from "./trust-check.mjs";
import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";

function criteriaError(code, message) {
  return new ValidationError({ code, category: "criteria", message });
}

/**
 * @param {{ capture: (cmd: string) => string }} deps
 * @param {{
 *   repoRoot: string,
 *   pr: string|number,
 *   repo: string,
 *   allowProjectCommands: boolean,
 *   trustedAssociations: string[],
 *   env?: NodeJS.ProcessEnv,
 * }} args
 * @returns {{ headSha: string, baseSha: string, prHeadSha: string, isCrossRepository: boolean, body: string }}
 * @throws {ValidationError} with a CRITERIA_* code on any failed precondition.
 */
export function checkPrPreconditions(deps, { repoRoot, pr, repo, allowProjectCommands, trustedAssociations, env }) {
  if (!allowProjectCommands && !isRepoTrusted({ repoRoot, env }).trusted) {
    throw criteriaError(ERROR_CODES.CRITERIA_TRUST_REQUIRED, "project-command trust is required to verify criteria (pass --allow-project-commands to override for this run)");
  }

  // Clean except .dotbabel/: that directory holds this command's own scratch
  // state (deleted-then-rewritten JUnit reports), so a run that just wrote
  // there is not "dirty" in the sense this check cares about.
  const dirty = deps
    .capture("git status --porcelain")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.replace(/^\S+\s+/, "").startsWith(".dotbabel/"));
  if (dirty.length > 0) {
    throw criteriaError(ERROR_CODES.CRITERIA_WORKTREE_DIRTY, `worktree has uncommitted changes outside .dotbabel/:\n${dirty.join("\n")}`);
  }

  const headSha = deps.capture("git rev-parse HEAD").trim();
  const prJson = JSON.parse(deps.capture(`gh pr view ${pr} --json headRefOid,baseRefOid,isCrossRepository,body`));
  const prHeadSha = String(prJson.headRefOid);
  if (headSha !== prHeadSha) {
    throw criteriaError(ERROR_CODES.CRITERIA_HEAD_MISMATCH, `local HEAD (${headSha.slice(0, 8)}) differs from PR #${pr} head (${prHeadSha.slice(0, 8)})`);
  }

  if (prJson.isCrossRepository && !allowProjectCommands) {
    throw criteriaError(ERROR_CODES.CRITERIA_FORK_PR, `pull request #${pr} comes from a fork (pass --allow-project-commands to override for this run)`);
  }

  if (!allowProjectCommands) {
    const untrusted = findUntrustedArgvChange(deps, { baseSha: String(prJson.baseRefOid), headSha, repo, trustedAssociations });
    if (untrusted) {
      throw criteriaError(
        ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE,
        `an author outside ${JSON.stringify(trustedAssociations)} changed ${untrusted.criterionId}'s argv in ${untrusted.specPath} (commit ${untrusted.commit.slice(0, 8)}, author ${untrusted.login ?? "(unattributable)"})`,
      );
    }
  }

  return { headSha, baseSha: String(prJson.baseRefOid), prHeadSha, isCrossRepository: Boolean(prJson.isCrossRepository), body: String(prJson.body ?? "") };
}
