// #390: this repository's own scheduled deep job must audit the whole
// repository, the same way the consumer template does
// (workflow-templates.test.mjs, "runs the scheduled deep profile over the
// whole repository").
//
// The deep job runs only on schedule and workflow_dispatch, so the checkout is
// the default branch and HEAD equals origin/main. `--base origin/main` then
// resolves a merge base that IS HEAD, the change set is empty, and every
// changed-scope rule — the mutation floor included — reports not_applicable
// while the job exits 0. That failure is invisible at runtime, so it is pinned
// here.
//
// Only `jobs.deep` is checked. The `pr` job diffs against the pull request base
// on purpose.

import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "quality.yml");

const QUALITY_CHECK = /dotbabel-quality\.mjs\s+check\b|dotbabel\s+quality\s+check\b/;

function deepQualityScripts() {
  const doc = yaml.load(fs.readFileSync(WORKFLOW, "utf8"));
  return (doc.jobs?.deep?.steps ?? [])
    .map((step) => step.run)
    .filter((script) => typeof script === "string" && QUALITY_CHECK.test(script));
}

describe("dogfood .github/workflows/quality.yml deep job", () => {
  it("runs the quality check with the deep profile", () => {
    const scripts = deepQualityScripts();
    expect(scripts.length, "jobs.deep runs the quality check").toBeGreaterThan(0);
    for (const script of scripts) expect(script).toMatch(/--profile\s+deep\b/);
  });

  it("audits the whole repository, not an empty diff", () => {
    for (const script of deepQualityScripts()) {
      expect(script).toMatch(/--all\b/);
      expect(script, "a scheduled whole-repo audit must not scope itself to a diff").not.toMatch(/--(base|head)\b/);
    }
  });
});
