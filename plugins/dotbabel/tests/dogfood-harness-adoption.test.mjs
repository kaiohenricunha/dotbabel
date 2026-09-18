// This repository ships a verification harness and, until now, did not run
// most of it against itself.
//
// P-F1 declared the mutation tool but stopped there. `workflow-templates.test.mjs`
// proves the shipped TEMPLATES are correct; nothing proved this repository
// adopts them. §6.4 commits P-D1 to "post-deploy: the first run of `test.yml`
// in this repository during P-F1", and that run never happened — the template
// carried ten criteria references and this repository's own workflow carried
// none.
//
// The YAML is PARSED, never grepped, for the reason `workflow-templates.test.mjs`
// documents: a regex reads a comment explaining a flag's absence as the flag.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const readRepo = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
const testWorkflow = () => yaml.load(readRepo(".github/workflows/test.yml"));

/** Every `run:` script anywhere in a parsed workflow. */
function runScripts(node, found = []) {
  if (Array.isArray(node)) for (const item of node) runScripts(item, found);
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "run" && typeof value === "string") found.push(value);
      else runScripts(value, found);
    }
  }
  return found;
}

/**
 * Matches both invocation forms: the template's `dotbabel criteria verify` and
 * this repository's in-tree `dotbabel-criteria.mjs verify`.
 */
const CRITERIA_VERIFY = /criteria(\.mjs)?\s+verify/;

/**
 * Executable lines of a shell script: comments and `echo` hints stripped.
 *
 * Matching raw file text is how a comment explaining a flag gets mistaken for
 * the flag. The hook's own failure branch echoes the bin path and the word
 * `--json` appears in its header comment, so both would satisfy a whole-file
 * match while the invocation said something else entirely.
 *
 * @param {string} script
 * @returns {string[]}
 */
function shellLines(script) {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("echo"));
}

/** The job in this repository's test workflow that verifies acceptance criteria. */
function criteriaJob() {
  const jobs = testWorkflow().jobs ?? {};
  return Object.entries(jobs).find(([, job]) => runScripts(job).some((script) => CRITERIA_VERIFY.test(script)));
}

describe("this repository adopts the harness it ships (P-D1, P-D2)", () => {
  it("runs acceptance-criteria verification in its own CI", () => {
    expect(criteriaJob(), ".github/workflows/test.yml runs no criteria verification").toBeDefined();
  });

  it("does not gate criteria verification on the local-attest marker", () => {
    // An attested pull request certifies lint/test/bats/dogfood and says
    // nothing about the criteria, so gating this job the way `test` is gated
    // would mean the criteria are never verified on any attesting PR.
    //
    // Deliberately NOT asserted here: that `.local-attest.config.mjs` contains
    // no criteria leg. An earlier version did, which made this test fail on the
    // one change that would close the gap it exists to motivate — a gate that
    // punishes its own remediation.
    const [, job] = criteriaJob();
    const needs = [job?.needs ?? []].flat();
    expect(needs, "criteria verification must not wait on the attestation gate").not.toContain("classify");
    expect(JSON.stringify(job?.if ?? ""), "criteria verification must not be skipped when attested").not.toMatch(/attested/);
  });

  it("checks out the pull request head SHA, not the merge commit", () => {
    // `criteria verify` fails closed unless local HEAD equals the pull request
    // head, and the default merge commit never does.
    const [, job] = criteriaJob();
    // A `workflow_dispatch` fallback may follow, but the pull_request path must
    // resolve to the head SHA first.
    const checkout = (job.steps ?? []).find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toMatch(/^\$\{\{\s*github\.event\.pull_request\.head\.sha\b/);
  });

  it("never posts evidence from CI (KD-10)", () => {
    const [, job] = criteriaJob();
    for (const script of runScripts(job).filter((s) => CRITERIA_VERIFY.test(s))) {
      expect(script, "CI verifies criteria; it never posts the evidence comment").not.toMatch(/--post\b/);
    }
  });

  it("declares critical_paths so the test escalation can fire (AC-9)", () => {
    // The shipped default is the empty list (`quality/policy.mjs`), so an
    // undeclared key means the KD-6 escalation never fires here — while
    // CLAUDE.md tells contributors to consult that very key.
    const config = JSON.parse(readRepo(".dotbabel.json"));
    const declared = config.quality?.critical_paths ?? [];
    expect(declared, "quality.critical_paths is undeclared").not.toHaveLength(0);

    // Non-emptiness is not enough: a typo'd or stale glob matches nothing and
    // leaves the escalation as dead as an undeclared key.
    const tracked = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    for (const glob of declared) {
      expect(tracked.some((file) => path.matchesGlob(file, glob)), `${glob} matches no tracked file`).toBe(true);
    }
  });

  it("installs the pre-push hook and runs its own bin, not a published copy", () => {
    // A bare `dotbabel` resolves to whatever is on PATH — on this machine a
    // GLOBALLY INSTALLED published release. For the repository that produces
    // dotbabel, that would check the working tree with someone else's version,
    // so the adopted hook must call the in-tree bin. The template stays generic
    // for consumers, which is why this is not a byte-identity assertion.
    const hookPath = path.join(REPO_ROOT, "githooks", "pre-push");
    expect(fs.existsSync(hookPath), "githooks/pre-push is not installed").toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(hookPath).mode & 0o111, "githooks/pre-push is not executable").not.toBe(0);

    // Assert the INVOCATION, not the file text. The failure branch echoes the
    // bin path as a hint, so a hook that printed it while calling a bare
    // `dotbabel` would satisfy a whole-file match.
    const hook = fs.readFileSync(hookPath, "utf8");
    const invocations = shellLines(hook).filter((line) => /check --profile fast/.test(line));
    expect(invocations.length, "no pre-push invocation of the fast profile found").toBeGreaterThan(0);
    for (const line of invocations) {
      expect(line, "the hook must run the in-tree bin, not whatever `dotbabel` is on PATH").toMatch(/node "\$QUALITY_BIN"/);
    }
  });

  it("only blocks a push on a verdict the checker actually produced (KD-11)", () => {
    // Running the in-tree bin means node exits 1 on a module-load failure too,
    // so a broken checker would otherwise wedge the push it is needed to fix.
    const hook = fs.readFileSync(path.join(REPO_ROOT, "githooks", "pre-push"), "utf8");
    const invocations = shellLines(hook).filter((line) => /check --profile fast/.test(line));
    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) {
      expect(line, "without --json an uncaught module-load failure is indistinguishable from a policy failure").toMatch(/--json/);
    }
    // And the blocking branch must consult whether a report was produced.
    const blocking = shellLines(hook).some((line) => /reported/.test(line));
    expect(blocking, "exit 1 must be qualified by whether the checker reported").toBe(true);
  });

  it("grants CI trust without disarming the fork and argv guards", () => {
    // `--allow-project-commands` is overloaded: it also disables the fork-PR
    // refusal and the SEC-1 untrusted-argv check in criteria/preconditions.mjs,
    // which would let a fork author edit a criterion's argv and have it run.
    const [, job] = criteriaJob();
    const step = (job.steps ?? []).find((s) => runScripts(s).some((script) => CRITERIA_VERIFY.test(script)));
    expect(step?.env?.CHECK_ON_STOP_TRUST_ALL, "the job cannot pass its own trust precondition without this").toBe("1");
    for (const script of runScripts(job)) {
      expect(script, "--allow-project-commands would disarm the fork and argv guards").not.toMatch(/--allow-project-commands/);
    }
  });

  it("writes its report where the preconditions tolerate it", () => {
    // A bare `> criteria-report.json` creates an untracked file before node
    // starts, and the preconditions reject a tree dirty outside `.dotbabel/`,
    // so the job failed on a file it had created itself.
    const [, job] = criteriaJob();
    for (const script of runScripts(job).filter((s) => CRITERIA_VERIFY.test(s))) {
      const redirect = script.match(/>\s*(\S+)/);
      expect(redirect?.[1], "the report must live under .dotbabel/").toMatch(/^\.dotbabel\//);
    }
  });

  it("declares no write permission, which is what KD-10 actually needs", () => {
    // The real invariant is not the absence of a `--post` flag — a renamed step
    // could post by another route. No write scope means no step can comment.
    const [, job] = criteriaJob();
    for (const value of Object.values(job.permissions ?? {})) {
      expect(value, "a write permission would let this job post evidence").not.toBe("write");
    }
  });
});
