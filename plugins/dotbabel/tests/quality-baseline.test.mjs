import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createQualityBaseline, evaluateMetricAgainstBaseline, loadQualityBaseline, loadQualityBaselineAtRevision, writeQualityBaseline } from "../src/quality/baseline.mjs";

describe("quality baselines", () => {
  it("sorts stable entries and excludes hard correctness failures", () => {
    const baseline = createQualityBaseline({
      sourceRevision: "abc",
      policyHash: "sha256:test",
      metrics: [{ rule: "complexity.cognitive", key: "b", actual: 12 }, { rule: "complexity.cognitive", key: "a", actual: 20 }],
      findings: [{ rule: "correctness.compile", fingerprint: "bad", verdict: "fail" }, { rule: "maintainability.dead_code", fingerprint: "keep", verdict: "warn" }],
    });
    expect(baseline.metrics.map((item) => item.key)).toEqual(["a", "b"]);
    expect(baseline.findings.map((item) => item.fingerprint)).toEqual(["keep"]);
  });

  it("passes a legacy improvement and fails a regression", () => {
    expect(evaluateMetricAgainstBaseline({ actual: 18, threshold: 15, baseline: 20, direction: "max" }).verdict).toBe("pass");
    expect(evaluateMetricAgainstBaseline({ actual: 21, threshold: 15, baseline: 20, direction: "max" }).verdict).toBe("fail");
    expect(evaluateMetricAgainstBaseline({ actual: 91, threshold: 90, baseline: 92, direction: "min" })).toMatchObject({ verdict: "pass", improved: false });
    expect(evaluateMetricAgainstBaseline({ actual: 89, threshold: 90, baseline: 88, direction: "min" })).toMatchObject({ verdict: "pass", improved: true });
  });

  it("writes, reads, and validates baseline files inside the repository", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-baseline-file-"));
    try {
      const baseline = createQualityBaseline({ sourceRevision: "abc", policyHash: "sha256:x" });
      expect(loadQualityBaseline({ repoRoot })).toBeNull();
      const file = writeQualityBaseline({ repoRoot, baselineFile: ".dotbabel/quality-baseline.json", baseline });
      expect(file).toBe(path.join(repoRoot, ".dotbabel", "quality-baseline.json"));
      expect(loadQualityBaseline({ repoRoot })).toEqual(baseline);
      fs.writeFileSync(file, "not JSON");
      expect(() => loadQualityBaseline({ repoRoot })).toThrow(/not valid JSON/);
      fs.writeFileSync(file, "{}");
      expect(() => loadQualityBaseline({ repoRoot })).toThrow(/schema is invalid/);
      expect(() => loadQualityBaseline({ repoRoot, baselineFile: "../escape.json" })).toThrow(/escapes/);
      expect(() => writeQualityBaseline({ repoRoot, baselineFile: "../escape.json", baseline })).toThrow(/escapes/);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
  });

  it("loads the base revision baseline instead of the changed working copy", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-baseline-revision-"));
    try {
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
      fs.mkdirSync(path.join(repo, ".dotbabel"));
      fs.writeFileSync(path.join(repo, ".dotbabel", "quality-baseline.json"), JSON.stringify({ schema_version: 1, source_revision: "base", policy_hash: "sha256:x", components: {}, tool_versions: {}, metrics: [], findings: [] }));
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
      const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      fs.writeFileSync(path.join(repo, ".dotbabel", "quality-baseline.json"), JSON.stringify({ schema_version: 1, source_revision: "head", policy_hash: "sha256:y", components: {}, tool_versions: {}, metrics: [], findings: [] }));
      expect(loadQualityBaselineAtRevision({ repoRoot: repo, baselineFile: ".dotbabel/quality-baseline.json", revision }).source_revision).toBe("base");
      expect(loadQualityBaselineAtRevision({ repoRoot: repo, baselineFile: ".dotbabel/missing.json", revision })).toBeNull();
      expect(() => loadQualityBaselineAtRevision({ repoRoot: repo, baselineFile: "../escape.json", revision })).toThrow(/escapes/);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });
});
