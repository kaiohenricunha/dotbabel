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
// A whole-repository deep run takes about 1.5 hours on a hosted runner, and
// this repository's CI minutes are limited. So the job runs only on
// workflow_dispatch, never on a schedule, and the routine deep audit runs
// locally (docs/quality.md, "Continuous integration"). The consumer template
// keeps its weekly schedule.
//
// Only `jobs.deep` is checked for flags. The `pr` job diffs against the pull
// request base on purpose.

import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "quality.yml");

const QUALITY_CHECK = /dotbabel-quality\.mjs\s+check\b|dotbabel\s+quality\s+check\b/;

const loadWorkflow = () => yaml.load(fs.readFileSync(WORKFLOW, "utf8"));

function deepQualityScripts() {
  return (loadWorkflow().jobs?.deep?.steps ?? [])
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
      expect(script, "a whole-repo audit must not scope itself to a diff").not.toMatch(/--(base|head)\b/);
    }
  });

  it("runs only on demand, never on a schedule", () => {
    const doc = loadWorkflow();
    // js-yaml reads the bare `on:` key as the boolean true.
    const on = doc.on ?? doc[true] ?? {};
    expect(Object.keys(on)).toContain("workflow_dispatch");
    expect(Object.keys(on), "a scheduled deep run spends CI minutes every week").not.toContain("schedule");
    expect(doc.jobs.deep.if).toBe("github.event_name == 'workflow_dispatch'");
  });
});
