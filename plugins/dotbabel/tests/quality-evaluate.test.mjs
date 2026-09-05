import { describe, expect, it } from "vitest";

import { evaluateQuality } from "../src/quality/evaluate.mjs";
import { QUALITY_RULES } from "../src/quality/policy.mjs";

function policy(exceptions = []) {
  return {
    rules: Object.fromEntries(Object.entries(QUALITY_RULES).map(([id, rule]) => [id, {
      ...rule,
      level: rule.default_level,
      provenance: { level: "shipped", threshold: "shipped" },
    }])),
    exceptions,
  };
}

describe("quality evaluation", () => {
  it("matches a legacy metric across a Git rename", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "fast",
      metrics: [{ rule: "complexity.cognitive", path: "new.go", symbol: "work", key: "new.go:work", actual: 18 }],
      baseline: { metrics: [{ rule: "complexity.cognitive", path: "old.go", symbol: "work", key: "old.go:work", actual: 20 }], findings: [] },
      renames: [{ from: "old.go", to: "new.go" }],
    });
    expect(result.results.find((item) => item.rule === "complexity.cognitive")).toMatchObject({ verdict: "pass", baseline: 20, improved: true });
  });

  it("does not fail an unchanged baseline finding and reports its removal", () => {
    const legacy = { rule: "maintainability.dead_code", path: "old.py", fingerprint: "sha256:legacy" };
    const unchanged = evaluateQuality({ policy: policy(), profile: "pr", findings: [legacy], baseline: { metrics: [], findings: [legacy] } });
    expect(unchanged.results.find((item) => item.fingerprint === legacy.fingerprint)).toMatchObject({ verdict: "info", legacy: true });

    const resolved = evaluateQuality({
      policy: policy(),
      profile: "pr",
      executions: [{ componentId: ".:python", ruleIds: [legacy.rule], state: "checked", exitCode: 0, stdout: "", stderr: "" }],
      baseline: { metrics: [], findings: [legacy] },
    });
    expect(resolved.results.find((item) => item.fingerprint === legacy.fingerprint)).toMatchObject({ verdict: "info", resolved: true });
  });

  it("keeps unavailable evidence separate from a passing check", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "pr",
      executions: [{ componentId: ".:go", ruleIds: ["correctness.tests"], state: "unavailable", exitCode: null, stdout: "", stderr: "" }],
    });
    expect(result.results.find((item) => item.rule === "correctness.tests")).toMatchObject({ state: "unavailable", verdict: "fail" });
    expect(result.environment_error).toBe(true);
  });

  it("evaluates passing, failing, output-sensitive, and ambiguous commands", () => {
    const executions = [
      { componentId: "a:go", ruleIds: ["correctness.compile"], state: "checked", exitCode: 0, stdout: "", stderr: "" },
      { componentId: "b:go", ruleIds: ["correctness.lint"], state: "checked", exitCode: 1, stdout: "", stderr: "lint failed" },
      { componentId: "c:go", ruleIds: ["correctness.format"], state: "checked", exitCode: 0, stdout: "bad.go\n", stderr: "", stdoutFailure: true },
      { componentId: "d:go", ruleIds: ["correctness.types"], state: "not_configured", candidates: ["mypy", "pyright"] },
    ];
    const result = evaluateQuality({ policy: policy(), profile: "fast", executions });
    expect(result.results.find((item) => item.component === "a:go")).toMatchObject({ verdict: "pass" });
    expect(result.results.find((item) => item.component === "b:go")).toMatchObject({ verdict: "fail", message: "lint failed" });
    expect(result.results.find((item) => item.component === "c:go")).toMatchObject({ verdict: "fail" });
    expect(result.results.find((item) => item.component === "d:go")).toMatchObject({ state: "not_configured", verdict: "fail" });
  });

  it("compares coverage regression with exact integer arithmetic", () => {
    const baseline = { metrics: [{ key: "coverage", rule: "coverage.no_regression", actual: 90, covered: 9, total: 10, report_format: "lcov" }], findings: [] };
    const pass = evaluateQuality({ policy: policy(), profile: "pr", metrics: [{ key: "coverage", rule: "coverage.no_regression", actual: 90, covered: 90, total: 100, report_format: "lcov" }], baseline });
    expect(pass.results.find((item) => item.rule === "coverage.no_regression")).toMatchObject({ verdict: "pass", baseline_covered: 9, baseline_total: 10 });
    const fail = evaluateQuality({ policy: policy(), profile: "pr", metrics: [{ key: "coverage", rule: "coverage.no_regression", actual: 89.99, covered: 8999, total: 10000, report_format: "lcov" }], baseline });
    expect(fail.results.find((item) => item.rule === "coverage.no_regression").verdict).toBe("fail");
    const incompatible = evaluateQuality({ policy: policy(), profile: "pr", metrics: [{ key: "coverage", rule: "coverage.no_regression", actual: 100, covered: 1, total: 1, report_format: "istanbul-json" }], baseline });
    expect(incompatible.results.find((item) => item.rule === "coverage.no_regression")).toMatchObject({ state: "not_applicable", verdict: "info" });
  });

  it("reports active, expired, and unused exact exceptions", () => {
    const exceptions = [
      { id: "QEX-1", rule: "complexity.cognitive", fingerprint: "sha256:active", expires: "2027-01-01" },
      { id: "QEX-2", rule: "complexity.cognitive", fingerprint: "sha256:expired", expires: "2025-01-01" },
      { id: "QEX-3", rule: "complexity.cognitive", fingerprint: "sha256:unused", expires: "2027-01-01" },
    ];
    const result = evaluateQuality({
      policy: policy(exceptions), profile: "fast", now: new Date("2026-01-01T00:00:00Z"),
      findings: [
        { rule: "complexity.cognitive", fingerprint: "sha256:active", message: "new complexity" },
        { rule: "complexity.cognitive", fingerprint: "sha256:expired", message: "old exception" },
      ],
    });
    expect(result.results.find((item) => item.fingerprint === "sha256:active")).toMatchObject({ verdict: "warn", exception: "QEX-1" });
    expect(result.exceptions).toEqual([
      { id: "QEX-1", state: "active" },
      { id: "QEX-2", state: "expired" },
      { id: "QEX-3", state: "unused" },
    ]);
  });

  it("warns for semantic findings and marks missing semantic review as skipped", () => {
    const result = evaluateQuality({ policy: policy(), profile: "fast", findings: [{ rule: "semantic.dynamic_types", message: "explicit any", path: "a.ts" }] });
    expect(result.results.find((item) => item.rule === "semantic.dynamic_types")).toMatchObject({ verdict: "warn", state: "checked" });
    expect(result.results.find((item) => item.rule === "semantic.lifecycle")).toMatchObject({ verdict: "info", state: "skipped" });
  });
});
