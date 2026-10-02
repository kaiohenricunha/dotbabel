/**
 * This repository's own local-attest matrix is PR-scoped (owner decision):
 * lint, test and bats scope themselves through the governed attest-scope
 * wrapper; the whole-repo invariant legs run only when a changed file is one
 * of their inputs; quality always runs. These tests pin that shape and the
 * governance around it.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/local-attest-config.mjs";
import { markSkips } from "../src/local-attest-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const dotbabel = JSON.parse(readFileSync(path.join(REPO_ROOT, ".dotbabel.json"), "utf8"));
const cfg = await loadConfig({ cwd: REPO_ROOT });
const leg = (name) => cfg.matrix.find((l) => l.name === name);
const tracked = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean);

describe("this repository's local-attest matrix is PR-scoped", () => {
  it("runs lint, test and bats through the governed scope wrapper with scope: true", () => {
    for (const name of ["lint", "test", "bats"]) {
      expect(leg(name)?.command).toBe(`node plugins/dotbabel/scripts/attest-scope.mjs ${name}`);
      expect(leg(name)?.scope).toBe(true);
    }
    // quality reuses the test leg's lcov, so the test leg must still declare it.
    expect(leg("test").produces).toEqual(["coverage/lcov.info"]);
  });

  it("gates each whole-repo invariant leg on its inputs", () => {
    for (const name of ["dogfood", "build-plugin --check", "validate-settings"]) {
      expect(leg(name)?.when?.changedPaths?.length, `${name} has no changedPaths`).toBeGreaterThan(0);
      expect(leg(name)?.scope).toBeUndefined();
    }
  });

  it("never gates or scopes quality, the required leg that always executes", () => {
    expect(leg("quality").when).toBeUndefined();
    expect(leg("quality").skipWhenDiffOnly).toBeUndefined();
    expect(leg("quality").scope).toBeUndefined();
    expect(markSkips(cfg.matrix, ["README.md"]).find((l) => l.name === "quality").skipped).toBe(false);
  });

  it("runs each invariant leg when its own script or config changes", () => {
    const runs = (name, file) => !markSkips(cfg.matrix, [file]).find((l) => l.name === name).skipped;
    expect(runs("validate-settings", "plugins/dotbabel/scripts/validate-settings.sh")).toBe(true);
    expect(runs("validate-settings", "plugins/dotbabel/tests/test_validate_settings.sh")).toBe(true);
    expect(runs("build-plugin --check", "scripts/build-plugin.mjs")).toBe(true);
    expect(runs("build-plugin --check", "skills/local-attest/SKILL.md")).toBe(true);
    expect(runs("dogfood", "CLAUDE.md")).toBe(true);
    expect(runs("dogfood", "docs/specs/dotbabel-core/spec.json")).toBe(true);
    expect(runs("dogfood", "scripts/build-compute-schema.mjs")).toBe(true);
    for (const name of ["dogfood", "build-plugin --check", "validate-settings"]) {
      expect(runs(name, "package.json"), `${name} must run when package.json changes`).toBe(true);
    }
  });

  it("skips the invariant legs for a change outside all their inputs", () => {
    const marked = markSkips(cfg.matrix, ["docs/audits/some-audit.md"]);
    for (const name of ["dogfood", "build-plugin --check", "validate-settings"]) {
      expect(marked.find((l) => l.name === name).skipped, name).toBe(true);
    }
  });

  it("has no stale changedPaths glob — each one matches a tracked file", () => {
    for (const name of ["dogfood", "build-plugin --check", "validate-settings"]) {
      for (const glob of leg(name).when.changedPaths) {
        const hit = tracked.some((f) => !markSkips([{ name: "x", mode: "hard", command: "x", when: { changedPaths: [glob] } }], [f])[0].skipped);
        expect(hit, `${name}: ${glob} matches no tracked file`).toBe(true);
      }
    }
  });
});

describe("governance of the scoped matrix", () => {
  it("hashes the scope wrapper and the selection module into every attestation", () => {
    const governed = dotbabel.attestation.governance_files;
    expect(governed).toContain("plugins/dotbabel/scripts/attest-scope.mjs");
    expect(governed).toContain("plugins/dotbabel/src/attest-scope.mjs");
  });

  it("gives every quality tool the scoped legs answer for a paths filter, so a skipped leg is never re-run in full by quality", () => {
    const component = dotbabel.quality.components.find((c) => c.root === ".");
    for (const tool of ["lint", "test", "coverage"]) {
      expect(component.tools[tool].paths?.length, `quality tool ${tool} has no paths`).toBeGreaterThan(0);
    }
  });

  it("measures the source tree with quality's test and coverage tools", () => {
    const component = dotbabel.quality.components.find((c) => c.root === ".");
    expect(component.tools.test.paths).toContain("plugins/dotbabel/src/**");
    expect(component.tools.coverage.paths).toContain("plugins/dotbabel/src/**");
  });
});
