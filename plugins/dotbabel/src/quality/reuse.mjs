/**
 * Decide, per quality plan, whether a passed `local-attest` leg may stand in for
 * running the tool.
 *
 * This is the read half of `attest-run.mjs`. The matrix writes what it learned;
 * this turns that record into an answer for each plan the quality runner is
 * about to execute. It exists because the quality profile re-ran lint, the
 * suite and coverage inside a matrix that had just run all three as legs of its
 * own — measured at about 50s of a 53s leg on this repository.
 *
 * Deciding SOUNDNESS is `decideReuse`'s job and lives with the manifest format.
 * This module only gathers the facts it needs (which commit, is the tree clean,
 * which report files would be parsed) and records every decision, including the
 * refusals, so the result can say what was and was not reused and why.
 *
 * @typedef {object} ReuseDecision
 * @property {string} capability
 * @property {string} leg
 * @property {boolean} reused
 * @property {string} [reason]  Present when `reused` is false.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

import { decideReuse, readRunManifest, sha256File } from "../attest-run.mjs";
import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";
import { QUALITY_CAPABILITIES } from "./types.mjs";

/**
 * Run git with an argv array and no shell, returning trimmed stdout or null on
 * any failure. A failure must read as "unknown", never as a clean answer.
 *
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {string|null}
 */
function git(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Validate a `{ capability: leg }` request. Throws on anything malformed
 * rather than matching nothing: a misspelled capability that silently reused
 * nothing would look exactly like a working configuration that happened to
 * decline, and the cost — a full re-run — would never be traced to the typo.
 *
 * @param {unknown} reuse
 * @returns {Record<string, string>}
 */
export function validateReuse(reuse) {
  if (reuse === null || typeof reuse !== "object" || Array.isArray(reuse)) {
    throw new ValidationError({ code: ERROR_CODES.QUALITY_CONFIG_INVALID, category: "quality", message: "reuse must map a capability to a leg name" });
  }
  for (const [capability, leg] of Object.entries(reuse)) {
    if (!QUALITY_CAPABILITIES.includes(capability)) {
      throw new ValidationError({
        code: ERROR_CODES.QUALITY_CONFIG_INVALID,
        category: "quality",
        message: `unknown quality capability for reuse: ${JSON.stringify(capability)}`,
        hint: `capabilities: ${QUALITY_CAPABILITIES.join(", ")}`,
      });
    }
    if (typeof leg !== "string" || leg.trim() === "") {
      throw new ValidationError({ code: ERROR_CODES.QUALITY_CONFIG_INVALID, category: "quality", message: `reuse for ${capability} needs a non-empty leg name` });
    }
  }
  return /** @type {Record<string, string>} */ (reuse);
}

/**
 * The repository-relative report paths a plan would parse, for `decideReuse` to
 * check against what the leg recorded. Exit-code tools have none.
 *
 * @param {any} plan
 * @returns {string[]}
 */
function reportPathsFor(plan) {
  const report = plan.report;
  if (!report || report.format === "exit-code" || typeof report.path !== "string") return [];
  const componentRoot = plan.componentId.slice(0, plan.componentId.lastIndexOf(":"));
  return [path.posix.join(componentRoot.split(path.sep).join("/"), report.path.split(path.sep).join("/"))];
}

/**
 * Build the resolver the quality runner calls once per executable plan.
 *
 * The manifest, the head and the tree state are each read ONCE, up front: they
 * describe the checkout as it is when the check starts, and re-reading them per
 * plan would let a tool that ran earlier in the same check change the answer
 * for a later one.
 *
 * @param {{ repoRoot: string, reuse: Record<string, string> }} input
 * @returns {{ resolve: (plan: any) => ({ leg: string, head_sha: string }|null), decisions: ReuseDecision[] }}
 */
export function buildReuseResolver({ repoRoot, reuse }) {
  const map = validateReuse(reuse);
  const manifest = readRunManifest(repoRoot);
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]) ?? "";
  // `--porcelain` omits ignored files, so the manifest and coverage output —
  // both gitignored — cannot make the tree look dirty. Null (git failed) is
  // "unknown", which decideReuse treats as not clean.
  const status = git(repoRoot, ["status", "--porcelain"]);
  const treeClean = status === null ? undefined : status === "";
  /** @type {ReuseDecision[]} */
  const decisions = [];

  return {
    decisions,
    resolve(plan) {
      const leg = map[plan.capability];
      if (leg === undefined) return null;
      const verdict = decideReuse({
        manifest,
        headSha,
        treeClean,
        leg,
        reportPaths: reportPathsFor(plan),
        hashFile: (rel) => sha256File(path.join(repoRoot, rel)),
      });
      if (!verdict.ok) {
        decisions.push({ capability: plan.capability, leg, reused: false, reason: verdict.reason });
        return null;
      }
      decisions.push({ capability: plan.capability, leg, reused: true });
      return { leg, head_sha: verdict.headSha };
    },
  };
}
