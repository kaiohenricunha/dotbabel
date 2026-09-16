/**
 * `--pr` preconditions for `dotbabel criteria verify` (§5, SEC-1). Mirrors
 * `local-attest-runner.mjs`'s `checkPreconditions` dependency-injection
 * pattern (a `deps` object exposing `run`) so this can be unit-tested without
 * a real repository or a real `gh` call.
 */
import { isRepoTrusted } from "../trust-allowlist.mjs";
import { findUntrustedArgvChange } from "./trust-check.mjs";
import { loadCriteriaConfigText } from "./config.mjs";
import { listSpecDirs } from "../spec-harness-lib.mjs";
import { parseSpecIds } from "../lib/spec-ids.mjs";
import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";

function criteriaError(code, message) {
  return new ValidationError({ code, category: "criteria", message });
}

/**
 * @param {{ capture: (argv: string[]) => string }} deps
 * @param {{
 *   ctx: import("../spec-harness-lib.mjs").HarnessContext,
 *   pr: string|number,
 *   repo: string,
 *   allowProjectCommands: boolean,
 *   env?: NodeJS.ProcessEnv,
 * }} args
 * @returns {{ headSha: string, baseSha: string, isCrossRepository: boolean, specIds: string[], config: object }}
 * @throws {ValidationError} with a CRITERIA_* code on any failed precondition.
 */
export function checkPrPreconditions(deps, { ctx, pr, repo, allowProjectCommands, env }) {
  if (!allowProjectCommands && !isRepoTrusted({ repoRoot: ctx.repoRoot, env }).trusted) {
    throw criteriaError(ERROR_CODES.CRITERIA_TRUST_REQUIRED, "project-command trust is required to verify criteria (pass --allow-project-commands to override for this run)");
  }

  // Clean except .dotbabel/: that directory holds this command's own scratch
  // state (deleted-then-rewritten JUnit reports), so a run that just wrote
  // there is not "dirty" in the sense this check cares about.
  const dirty = deps
    .capture(["git", "status", "--porcelain"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.replace(/^\S+\s+/, "").startsWith(".dotbabel/"));
  if (dirty.length > 0) {
    throw criteriaError(ERROR_CODES.CRITERIA_WORKTREE_DIRTY, `worktree has uncommitted changes outside .dotbabel/:\n${dirty.join("\n")}`);
  }

  const headSha = deps.capture(["git", "rev-parse", "HEAD"]).trim();
  const prJson = JSON.parse(deps.capture(["gh", "pr", "view", String(pr), "--json", "headRefOid,baseRefOid,isCrossRepository,body"]));
  const prHeadSha = String(prJson.headRefOid);
  const baseSha = String(prJson.baseRefOid);
  if (headSha !== prHeadSha) {
    throw criteriaError(ERROR_CODES.CRITERIA_HEAD_MISMATCH, `local HEAD (${headSha.slice(0, 8)}) differs from PR #${pr} head (${prHeadSha.slice(0, 8)})`);
  }

  if (prJson.isCrossRepository && !allowProjectCommands) {
    throw criteriaError(ERROR_CODES.CRITERIA_FORK_PR, `pull request #${pr} comes from a fork (pass --allow-project-commands to override for this run)`);
  }

  const specIds = parseSpecIds(String(prJson.body ?? ""));
  const knownSpecIds = new Set(listSpecDirs(ctx));
  const unknownSpecId = specIds.find((id) => !knownSpecIds.has(id));
  if (unknownSpecId) throw criteriaError(ERROR_CODES.CRITERIA_UNKNOWN_SPEC, `unknown spec: ${unknownSpecId}`);

  let baseConfigText = null;
  const baseFiles = deps.capture(["git", "ls-tree", "-r", "--name-only", baseSha, "--", ".dotbabel.json"]);
  if (baseFiles.split("\n").some((file) => file.trim() === ".dotbabel.json")) {
    baseConfigText = deps.capture(["git", "show", `${baseSha}:.dotbabel.json`]);
  }
  const config = loadCriteriaConfigText(baseConfigText, `${baseSha}:.dotbabel.json`);

  if (!allowProjectCommands) {
    let prAssociation = null;
    try {
      const raw = deps.capture(["gh", "api", `repos/${repo}/pulls/${pr}`, "--jq", ".author_association"]).trim();
      prAssociation = raw === "" || raw === "null" ? null : raw.toUpperCase();
    } catch {
      prAssociation = null;
    }
    const untrusted = findUntrustedArgvChange(deps, {
      baseSha,
      headSha,
      specIds,
      prAssociation,
      trustedAssociations: config.trusted_associations,
    });
    if (untrusted) {
      const subject = untrusted.criterionId === null ? "executable criteria" : `${untrusted.criterionId}'s argv`;
      throw criteriaError(
        ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE,
        `pull request association ${prAssociation ?? "(unavailable)"} is outside ${JSON.stringify(config.trusted_associations)} and changed ${subject} in ${untrusted.specPath} (${untrusted.reason})`,
      );
    }
  }

  return { headSha, baseSha, isCrossRepository: Boolean(prJson.isCrossRepository), specIds, config };
}
