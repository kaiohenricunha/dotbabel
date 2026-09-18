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
    // `.local-attest.config.mjs` has no criteria leg, so an attested pull
    // request certifies lint/test/bats/dogfood and says nothing about the
    // criteria. Gating this job the way the `test` job is gated would mean the
    // criteria are never verified on any pull request that attests — which is
    // every pull request in this repository's workflow.
    const attestLegs = readRepo(".local-attest.config.mjs");
    expect(attestLegs, "local-attest gained a criteria leg — revisit this gate").not.toMatch(/criteria/);

    const [, job] = criteriaJob();
    const needs = [job?.needs ?? []].flat();
    expect(needs, "criteria verification must not wait on the attestation gate").not.toContain("classify");
    expect(JSON.stringify(job?.if ?? ""), "criteria verification must not be skipped when attested").not.toMatch(/attested/);
  });

  it("checks out the pull request head SHA, not the merge commit", () => {
    // `criteria verify` fails closed unless local HEAD equals the pull request
    // head, and the default merge commit never does.
    const [, job] = criteriaJob();
    const checkout = (job.steps ?? []).find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
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
    expect(config.quality?.critical_paths ?? [], "quality.critical_paths is undeclared").not.toHaveLength(0);
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

    const hook = fs.readFileSync(hookPath, "utf8");
    expect(hook).toMatch(/plugins\/dotbabel\/bin\//);
    expect(hook, "a bare `dotbabel` here runs the globally installed release").not.toMatch(/^\s*(timeout "\$TIMEOUT" )?dotbabel /m);
  });
});
