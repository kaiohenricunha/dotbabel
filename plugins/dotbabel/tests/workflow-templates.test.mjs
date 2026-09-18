import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

import { scaffoldHarness } from "../src/init-harness-scaffold.mjs";

// --- P-D1: consumer CI templates (KD-10, SEC-7, SEC-13) -------------------
//
// These templates run in repositories we never see, against pull requests from
// authors we do not control. A workflow is the one artifact where a review slip
// is directly exploitable — an unpinned action is a supply-chain hole and a
// write token on a fork-triggered event is an exfiltration path — so SEC-7 and
// SEC-13 are asserted here rather than left to a reviewer's eye.
//
// The YAML is PARSED, never grepped: a regex reads a commented-out job and a
// quoted string as if they were live configuration.

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/workflows");

const templateFiles = () => fs.readdirSync(TEMPLATES_DIR).filter((name) => /\.ya?ml$/.test(name));
const readTemplate = (name) => fs.readFileSync(path.join(TEMPLATES_DIR, name), "utf8");
const loadTemplate = (name) => yaml.load(readTemplate(name));

/** Every `uses:` value anywhere in a parsed workflow. */
function usesValues(node, found = []) {
  if (Array.isArray(node)) for (const item of node) usesValues(item, found);
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses" && typeof value === "string") found.push(value);
      else usesValues(value, found);
    }
  }
  return found;
}

/**
 * The `on:` key. js-yaml resolves an unquoted `on` to boolean true (the YAML
 * 1.1 spec), which is why this is read by identity rather than by name — a
 * test that looked up `doc.on` would silently see undefined for every workflow.
 */
const triggers = (doc) => doc.on ?? doc[true];

/**
 * Every `run:` script in a parsed workflow.
 *
 * Assertions about what a workflow EXECUTES must read this, never the raw
 * file: these templates explain their own flag choices in header comments, so
 * a raw-text search for a flag matches the sentence saying the flag is absent
 * and fails on a correct template. That exact false positive has now been
 * written twice in this repository — once for `--post`, once for `--base`.
 */
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

describe("workflow templates", () => {
  it("pins every action in every workflow template to a full 40-character commit SHA", () => {
    for (const name of templateFiles()) {
      for (const value of usesValues(loadTemplate(name))) {
        // A tag or branch ref is mutable: the action's owner can repoint it at
        // new code after review. Only a full SHA is immutable. A short SHA is
        // not enough — it is forgeable by brute force.
        expect(value, `${name}: ${value}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("declares top-level permissions with contents read in every workflow template", () => {
    for (const name of templateFiles()) {
      const doc = loadTemplate(name);
      // Omitting top-level permissions inherits the repository default, which
      // in many repositories is still read/write on every scope.
      expect(doc.permissions, `${name} has no top-level permissions`).toBeDefined();
      expect(doc.permissions.contents, `${name} contents permission`).toBe("read");
    }
  });

  it("never uses pull_request_target in a workflow template", () => {
    for (const name of templateFiles()) {
      const on = triggers(loadTemplate(name));
      const events = Array.isArray(on) ? on : typeof on === "string" ? [on] : Object.keys(on ?? {});
      // pull_request_target runs BASE-branch workflow code with a writable
      // token and the repository's secrets, while checking out fork code.
      expect(events, `${name} triggers`).not.toContain("pull_request_target");
    }
  });

  it("never references a secret other than github.token or secrets.GITHUB_TOKEN in test.yml or quality.yml", () => {
    for (const name of ["test.yml", "quality.yml"]) {
      const references = readTemplate(name).match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
      for (const reference of references) {
        expect(reference, `${name} references ${reference}`).toBe("secrets.GITHUB_TOKEN");
      }
    }
  });

  it("skips the verify job only when a trusted local-attest marker matches the head SHA", () => {
    const text = readTemplate("test.yml");
    const doc = yaml.load(text);
    const classify = doc.jobs.classify;
    expect(classify, "test.yml needs a classify job").toBeDefined();

    // The marker must be bound to THIS head SHA; a marker naming any other
    // commit would let an attested old commit wave through new code.
    expect(text).toMatch(/local-attest verified-sha=\$\{?\{?\s*(env\.)?HEAD_SHA/);
    // Only a trusted association counts, or any fork author could self-attest.
    expect(text).toMatch(/author_association\s*==\s*"OWNER"/);
    // Fail closed: the verify job runs unless the marker was positively found.
    expect(doc.jobs.verify.if).toMatch(/attested\s*!=\s*'true'/);
  });

  it("never skips the dotbabel criteria job when a linked spec declares an active criterion", () => {
    const doc = yaml.load(readTemplate("test.yml"));
    const criteria = doc.jobs["dotbabel-criteria"];
    expect(criteria, "test.yml needs a dotbabel-criteria job").toBeDefined();
    // KD-10: the local-attest skip never reaches this job. Criteria are the
    // independent re-run, so honoring a local attestation here would let the
    // same local run both assert and confirm itself.
    expect(JSON.stringify(criteria.if ?? "")).not.toMatch(/attested/);
    expect(JSON.stringify(criteria.needs ?? "")).not.toMatch(/classify/);
  });

  it("checks out the pull request head SHA in the dotbabel criteria job", () => {
    const doc = yaml.load(readTemplate("test.yml"));
    const checkout = doc.jobs["dotbabel-criteria"].steps.find((step) => String(step.uses ?? "").includes("actions/checkout"));
    // `dotbabel criteria verify` fails closed unless HEAD equals the PR head,
    // and the default checkout is the MERGE commit, which never equals it.
    expect(checkout.with.ref).toBe("${{ github.event.pull_request.head.sha }}");
  });

  it("never passes --post to dotbabel criteria in test.yml", () => {
    // KD-10: CI verifies, it never writes evidence. Its bot identity is not a
    // trusted association, and a second writer would race the local run.
    //
    // Asserted against the parsed `run:` scripts, not the raw file: the header
    // comment explains that `--post` is deliberately absent, and a raw-text
    // search matches that sentence and fails on correct templates. Same reason
    // this whole file parses instead of grepping.
    const criteriaScripts = runScripts(yaml.load(readTemplate("test.yml"))).filter((script) => /criteria\s+verify/.test(script));
    expect(criteriaScripts.length, "test.yml runs criteria verify somewhere").toBeGreaterThan(0);
    for (const script of criteriaScripts) expect(script).not.toMatch(/--post\b/);
  });

  it("uploads the quality and criteria reports as artifacts", () => {
    const test = yaml.load(readTemplate("test.yml"));
    const quality = yaml.load(readTemplate("quality.yml"));
    const uploads = (doc) => usesValues(doc).filter((value) => value.includes("actions/upload-artifact"));
    expect(uploads(test).length, "test.yml uploads").toBeGreaterThanOrEqual(2);
    expect(uploads(quality).length, "quality.yml uploads").toBeGreaterThanOrEqual(1);
  });

  it("schedules the deep profile weekly and on workflow_dispatch in quality.yml", () => {
    const doc = yaml.load(readTemplate("quality.yml"));
    const on = triggers(doc);
    expect(Object.keys(on)).toEqual(expect.arrayContaining(["schedule", "workflow_dispatch"]));
    expect(on.schedule[0].cron, "a weekly cron names a single day-of-week").toMatch(/^\S+ \S+ \S+ \S+ [0-6]$/);
    expect(readTemplate("quality.yml")).toMatch(/--profile\s+deep/);
  });

  it("runs the scheduled deep profile over the whole repository, not an empty diff", () => {
    // quality.yml runs only on schedule/dispatch, so the checkout lands on the
    // default branch and HEAD equals origin/main. `--base origin/main` then
    // resolves a merge base that IS HEAD, and scope.mjs diffs that against a
    // clean CI working tree — an empty change set. Every changed-scope rule in
    // the deep profile would evaluate nothing and the job would exit 0 while
    // appearing to audit the repository, including the changed-line mutation
    // score. `--all` is the whole-repository mode and needs no base.
    const quality = runScripts(yaml.load(readTemplate("quality.yml"))).filter((script) => /dotbabel quality check/.test(script));
    expect(quality.length, "quality.yml runs the quality check somewhere").toBeGreaterThan(0);
    for (const script of quality) {
      expect(script).toMatch(/--all\b/);
      expect(script, "a scheduled whole-repo audit must not scope itself to a diff").not.toMatch(/--base\b/);
    }
  });

  it("allows no secret beyond GITHUB_TOKEN in any template, except the declared exception", () => {
    // Enumerates the directory rather than naming files, so a template added
    // later fails closed. ai-review.yml genuinely needs ANTHROPIC_API_KEY;
    // that one exception is declared here instead of the check being narrowed
    // to a hardcoded pair of filenames that new templates silently escape.
    const ALLOWED = { "ai-review.yml": new Set(["secrets.ANTHROPIC_API_KEY", "secrets.GITHUB_TOKEN"]) };
    for (const name of templateFiles()) {
      const allowed = ALLOWED[name] ?? new Set(["secrets.GITHUB_TOKEN"]);
      for (const reference of readTemplate(name).match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
        expect(allowed.has(reference), `${name} references ${reference}`).toBe(true);
      }
    }
  });

  it("scaffolds test.yml and quality.yml into .github/workflows with dotbabel init", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-scaffold-wf-"));
    try {
      const templatesDir = path.resolve(TEMPLATES_DIR, "..");
      const { filesWritten } = scaffoldHarness({ templatesDir, targetDir: target, placeholders: {} }, { force: true });
      for (const name of ["test.yml", "quality.yml"]) {
        expect(filesWritten).toContain(`.github/workflows/${name}`);
        expect(fs.existsSync(path.join(target, ".github", "workflows", name))).toBe(true);
      }
    } finally { fs.rmSync(target, { recursive: true, force: true }); }
  });
});
