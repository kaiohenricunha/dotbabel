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
  it("reports not_triggered with an info verdict for an unmatched path-triggered tool", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "pr",
      executions: [{
        componentId: ".:javascript",
        ruleIds: ["correctness.tests"],
        state: "not_triggered",
        evidence: "changed files did not match: tests/**, fixtures/**",
      }],
    });
    expect(result.results.find((item) => item.rule === "correctness.tests")).toMatchObject({
      state: "not_triggered",
      verdict: "info",
      message: "changed files did not match: tests/**, fixtures/**",
    });
    expect(result.results.at(-1).rule).toBe("correctness.tests");
    expect(result.results.filter((item) => item.state === "not_triggered")).toHaveLength(1);
    expect(result.results.filter((item) => item.state === "not_configured").every((item) => item.message === "no authoritative tool is configured")).toBe(true);
    expect(result.results.filter((item) => item.state === "skipped").every((item) => item.message === "agent review is required")).toBe(true);
    expect(result.verdict).toBe("pass");
    expect(result.environment_error).toBe(false);
  });

  it("counts an escalated test result in the fast profile", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "fast",
      criticalMatches: ["critical/value.js"],
      executions: [{
        componentId: ".:javascript",
        ruleIds: ["correctness.tests"],
        state: "checked",
        exitCode: 1,
        stdout: "",
        stderr: "test failed",
      }],
    });
    expect(result.results.find((item) => item.rule === "correctness.tests")).toEqual({
      rule: "correctness.tests",
      component: ".:javascript",
      class: "hard",
      state: "checked",
      verdict: "fail",
      message: "test failed",
      provenance: { level: "shipped", threshold: "shipped" },
    });
    expect(result.verdict).toBe("fail");
  });

  it("ignores unknown executions and distinguishes output-sensitive checks", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "fast",
      executions: [
        { componentId: "unknown", ruleIds: ["unknown.rule"], state: "checked", exitCode: 1, stdout: "", stderr: "unknown" },
        { componentId: "plain", ruleIds: ["correctness.compile"], state: "checked", exitCode: 0, stdout: "diagnostic", stderr: "" },
        { componentId: "sensitive", ruleIds: ["correctness.format"], state: "checked", exitCode: 0, stdout: "", stderr: "", stdoutFailure: true },
      ],
    });
    expect(result.results.find((item) => item.component === "unknown")).toBeUndefined();
    expect(result.results.find((item) => item.component === "plain")).toMatchObject({ verdict: "pass", message: "check passed" });
    expect(result.results.find((item) => item.component === "sensitive")).toMatchObject({ verdict: "pass", message: "check passed" });
  });

  it("uses all baseline identity fields and generates stable finding fingerprints", () => {
    const baseline = { metrics: [
      { rule: "complexity.cognitive", path: "old.js", symbol: "other", component: "web", actual: 1 },
      { rule: "complexity.cognitive", path: "old.js", symbol: "target", component: "api", actual: 2 },
      { rule: "complexity.cognitive", path: "old.js", symbol: "target", component: "web", actual: 20 },
    ], findings: [] };
    const result = evaluateQuality({
      policy: policy(),
      profile: "fast",
      baseline,
      renames: [{ from: "old.js", to: "new.js" }],
      metrics: [{ rule: "complexity.cognitive", path: "new.js", symbol: "target", component: "web", actual: 18 }],
      findings: [{ rule: "semantic.dynamic_types", path: "new.js", symbol: "target", message: "dynamic value" }],
    });
    expect(result.results.find((item) => item.rule === "complexity.cognitive")).toMatchObject({ baseline: 20, verdict: "pass" });
    expect(result.results.find((item) => item.rule === "semantic.dynamic_types").fingerprint).toBe("sha256:f034699270b30b50274b7c5fc690991f85988a56a853e9298749051621d61840");
  });

  it("maps unavailable levels to fail, warn, and info", () => {
    const configured = policy();
    configured.rules["correctness.compile"].on_unavailable = "error";
    configured.rules["security.high_confidence"].on_unavailable = "warning";
    configured.rules["maintainability.dead_code"].on_unavailable = "info";
    const result = evaluateQuality({
      policy: configured,
      profile: "pr",
      executions: [
        { componentId: "a", ruleIds: ["correctness.compile"], state: "unavailable" },
        { componentId: "b", ruleIds: ["security.high_confidence"], state: "unavailable" },
        { componentId: "c", ruleIds: ["maintainability.dead_code"], state: "unavailable" },
      ],
    });
    expect(result.results.filter((item) => item.component).map((item) => item.verdict)).toEqual(["fail", "warn", "info"]);
    expect(result.verdict).toBe("fail");
    expect(result.environment_error).toBe(true);
  });

  it("skips known rules outside the selected profile", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "fast",
      executions: [{ componentId: "tests", ruleIds: ["correctness.tests"], state: "checked", exitCode: 1, stdout: "", stderr: "failed" }],
      metrics: [{ rule: "coverage.changed_lines", actual: 0 }],
      findings: [{ rule: "maintainability.dead_code", message: "unused" }],
    });
    expect(result.results.some((item) => item.component === "tests")).toBe(false);
    expect(result.results.some((item) => item.actual === 0)).toBe(false);
    expect(result.results.some((item) => item.message === "unused")).toBe(false);
    expect(result.verdict).toBe("pass");
  });

  it("renders a not_configured execution's own evidence when it has no candidates", () => {
    // `not_configured` carried one meaning — "equal-authority tools, pick one"
    // — and its message is composed from `candidates`. A plan that is
    // not_configured for a DIFFERENT reason (the tool exists but cannot be
    // expressed as one argv, as mutmut cannot) has no candidates, so the
    // message rendered as the literal "ambiguous tools: " and the plan's
    // remediation text was dropped on the floor.
    const result = evaluateQuality({
      policy: policy(),
      profile: "deep",
      executions: [
        { componentId: "py", ruleIds: ["mutation.changed_score"], state: "not_configured", evidence: "mutmut needs two commands; declare it as a project mutation tool" },
        { componentId: "js", ruleIds: ["correctness.format"], state: "not_configured", candidates: ["prettier", "biome"] },
      ],
    });
    expect(result.results.find((item) => item.component === "py").message).toBe("mutmut needs two commands; declare it as a project mutation tool");
    // The candidates contract is unchanged where candidates exist.
    expect(result.results.find((item) => item.component === "js").message).toBe("ambiguous tools: prettier, biome");
  });

  it("reports every execution failure state with its exact message", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "fast",
      executions: [
        { componentId: "a", ruleIds: ["correctness.compile"], state: "unavailable", timedOut: true },
        { componentId: "b", ruleIds: ["correctness.format"], state: "not_configured", candidates: ["prettier", "biome"] },
        { componentId: "c", ruleIds: ["correctness.lint"], state: "checked", exitCode: 1, stdout: "stdout failure", stderr: "" },
        { componentId: "d", ruleIds: ["correctness.types"], state: "checked", exitCode: 1, stdout: "", stderr: "" },
      ],
    });
    expect(result.results.filter((item) => item.component).map(({ component, state, verdict, message }) => ({ component, state, verdict, message }))).toEqual([
      { component: "a", state: "unavailable", verdict: "fail", message: "tool timed out" },
      { component: "b", state: "not_configured", verdict: "fail", message: "ambiguous tools: prettier, biome" },
      { component: "c", state: "checked", verdict: "fail", message: "stdout failure" },
      { component: "d", state: "checked", verdict: "fail", message: "check failed" },
    ]);
  });

  it("uses percentage regression only when both totals are positive", () => {
    const baseline = { metrics: [
      { key: "zero-old", rule: "coverage.no_regression", actual: 50, covered: 0, total: 0, report_format: "lcov" },
      { key: "zero-new", rule: "coverage.no_regression", actual: 50, covered: 1, total: 2, report_format: "lcov" },
    ], findings: [] };
    const result = evaluateQuality({
      policy: policy(),
      profile: "pr",
      baseline,
      metrics: [
        { key: "zero-old", rule: "coverage.no_regression", actual: 40, covered: 0, total: 0, report_format: "lcov" },
        { key: "zero-new", rule: "coverage.no_regression", actual: 40, covered: 0, total: 0, report_format: "lcov" },
      ],
    });
    expect(result.results.filter((item) => item.rule === "coverage.no_regression").map((item) => item.verdict)).toEqual(["fail", "fail"]);
  });

  it("requires an exception to match the rule, fingerprint, state, and failing verdict", () => {
    const configured = policy([
      { id: "QEX-1", rule: "complexity.cognitive", fingerprint: "sha256:target", expires: "2027-01-01" },
    ]);
    const result = evaluateQuality({
      policy: configured,
      profile: "fast",
      now: new Date("2026-01-01T00:00:00Z"),
      findings: [
        { rule: "size.file_loc", fingerprint: "sha256:target", message: "wrong rule" },
        { rule: "complexity.cognitive", fingerprint: "sha256:other", message: "wrong fingerprint" },
        { rule: "complexity.cognitive", fingerprint: "sha256:target", message: "matching failure" },
      ],
    });
    expect(result.results.find((item) => item.fingerprint === "sha256:target" && item.rule === "complexity.cognitive")).toMatchObject({ verdict: "warn", exception: "QEX-1" });
    const wrongRule = result.results.find((item) => item.rule === "size.file_loc");
    expect(wrongRule).toMatchObject({ verdict: "warn" });
    expect(wrongRule.exception).toBeUndefined();
  });

  it("reports a warning-only run as warn", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "fast",
      findings: [{ rule: "semantic.dynamic_types", message: "dynamic" }],
    });
    expect(result.verdict).toBe("warn");
    expect(result.environment_error).toBe(false);
  });

  it("reports exact metric boundary states", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "pr",
      baseline: { metrics: [
        { key: "format", rule: "coverage.no_regression", actual: 90, report_format: "lcov" },
      ], findings: [] },
      metrics: [
        { key: "format", rule: "coverage.no_regression", actual: 90, report_format: "istanbul-json" },
        { key: "nan", rule: "coverage.changed_lines", actual: NaN },
      ],
    });
    expect(result.results.find((item) => item.key === "format")).toMatchObject({
      state: "not_applicable",
      verdict: "info",
      message: "coverage baseline format is incompatible",
    });
    expect(result.results.find((item) => item.key === "nan")).toMatchObject({
      state: "unavailable",
      verdict: "fail",
      message: "measured value is not a finite number",
    });
  });

  it("keeps a passing result unchanged by an exception", () => {
    const result = evaluateQuality({
      policy: policy([{ id: "QEX-1", rule: "complexity.cognitive", fingerprint: "sha256:pass", expires: "2027-01-01" }]),
      profile: "fast",
      now: new Date("2026-01-01T00:00:00Z"),
      metrics: [{ rule: "complexity.cognitive", actual: 1, fingerprint: "sha256:pass" }],
    });
    const passing = result.results.find((item) => item.fingerprint === "sha256:pass");
    expect(passing).toMatchObject({ verdict: "pass" });
    expect(passing.exception).toBeUndefined();
    expect(result.exceptions).toEqual([{ id: "QEX-1", state: "unused" }]);
  });

  it("keeps an exception active through the final second of its expiration date", () => {
    const result = evaluateQuality({
      policy: policy([{ id: "QEX-1", rule: "complexity.cognitive", fingerprint: "sha256:boundary", expires: "2027-01-01" }]),
      profile: "fast",
      now: new Date("2027-01-01T23:59:59Z"),
      findings: [{ rule: "complexity.cognitive", fingerprint: "sha256:boundary", message: "failure" }],
    });
    expect(result.exceptions).toEqual([{ id: "QEX-1", state: "active" }]);
  });

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

  it("does not let an exception downgrade a result whose state is not \"checked\"", () => {
    const exceptions = [{ id: "QEX-1", rule: "coverage.changed_lines", fingerprint: "sha256:unavailable", expires: "2027-01-01" }];
    const result = evaluateQuality({
      policy: policy(exceptions),
      profile: "pr",
      now: new Date("2026-01-01T00:00:00Z"),
      metrics: [{ rule: "coverage.changed_lines", component: ".:js", actual: NaN, fingerprint: "sha256:unavailable", key: "a" }],
    });
    const item = result.results.find((entry) => entry.rule === "coverage.changed_lines");
    expect(item).toMatchObject({ state: "unavailable", verdict: "fail" });
    expect(item.exception).toBeUndefined();
    expect(result.exceptions).toEqual([{ id: "QEX-1", state: "unused" }]);
  });

  it("does not let an exception downgrade a forbidden rule even if config validation was bypassed", () => {
    const exceptions = [{ id: "QEX-1", rule: "correctness.lint", fingerprint: "sha256:forbidden", expires: "2027-01-01" }];
    const result = evaluateQuality({
      policy: policy(exceptions),
      profile: "fast",
      now: new Date("2026-01-01T00:00:00Z"),
      findings: [{ rule: "correctness.lint", fingerprint: "sha256:forbidden", message: "banned pattern" }],
    });
    const item = result.results.find((entry) => entry.rule === "correctness.lint");
    expect(item).toMatchObject({ verdict: "fail" });
    expect(item.exception).toBeUndefined();
    expect(result.exceptions).toEqual([{ id: "QEX-1", state: "unused" }]);
  });

  it("reports a non-finite metric value as unavailable instead of a silent pass", () => {
    const result = evaluateQuality({
      policy: policy(),
      profile: "pr",
      metrics: [{ rule: "coverage.changed_lines", component: ".:js", actual: NaN, key: "a" }],
    });
    expect(result.results.find((item) => item.rule === "coverage.changed_lines")).toMatchObject({ state: "unavailable", verdict: "fail" });
  });
});
