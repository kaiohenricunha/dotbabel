import { describe, expect, it } from "vitest";

import { calculateChangedCoverage, parseQualityReport } from "../src/quality/reports.mjs";

describe("quality reports", () => {
  it("parses dotbabel-v1 and rejects other versions", () => {
    const parsed = parseQualityReport({ format: "dotbabel-v1", text: JSON.stringify({ schema_version: 1, metrics: [{ rule: "duplication.percent", actual: 4 }], findings: [] }) });
    expect(parsed.metrics[0].actual).toBe(4);
    expect(() => parseQualityReport({ format: "dotbabel-v1", text: '{"schema_version":2}' })).toThrow(/schema_version/);
  });

  it("computes changed coverage from executable lines only", () => {
    const parsed = parseQualityReport({ format: "lcov", text: "SF:web/a.js\nDA:2,1\nDA:3,0\nDA:8,1\nBRDA:3,0,0,0\nBRDA:3,0,1,1\nend_of_record\n" });
    const changed = calculateChangedCoverage(parsed.coverage, { "web/a.js": [2, 3], "web/other.js": [1] });
    expect(changed.line).toEqual({ covered: 1, total: 2 });
    expect(changed.branch).toEqual({ covered: 1, total: 2 });
  });

  it("uses overlapping Go statement blocks and emits no branch result", () => {
    const parsed = parseQualityReport({ format: "go-coverprofile", text: "mode: set\napi/a.go:2.1,4.2 3 1\napi/a.go:8.1,9.2 2 0\n" });
    const changed = calculateChangedCoverage(parsed.coverage, { "api/a.go": [3, 8] });
    expect(changed.statement).toEqual({ covered: 3, total: 5 });
    expect(changed.branch).toBeUndefined();
  });

  it("parses Go statement and LCOV line and branch counts", () => {
    const go = parseQualityReport({ format: "go-coverprofile", text: "mode: set\na.go:1.1,2.2 2 1\na.go:3.1,3.5 1 0\n" });
    expect(go.coverage.statement).toEqual({ covered: 2, total: 3 });
    expect(go.coverage.branch).toBeUndefined();
    const lcov = parseQualityReport({ format: "lcov", text: "SF:a.js\nLF:10\nLH:9\nBRF:4\nBRH:4\nend_of_record\n" });
    expect(lcov.coverage.line).toEqual({ covered: 9, total: 10 });
    expect(lcov.coverage.branch).toEqual({ covered: 4, total: 4 });
  });

  it("maps configured golangci analyzers to semantic and complexity rules", () => {
    const parsed = parseQualityReport({ format: "golangci-json", text: JSON.stringify({ Issues: [
      { FromLinter: "gocognit", Text: "complexity 17", Pos: { Filename: "api/a.go", Line: 3 } },
      { FromLinter: "errcheck", Text: "ignored error", Pos: { Filename: "api/a.go", Line: 8 } },
    ] }) });
    expect(parsed.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "complexity.cognitive", path: "api/a.go", line: 3 }),
      expect.objectContaining({ rule: "semantic.ignored_errors", path: "api/a.go", line: 8 }),
    ]));
  });

  it("flattens ESLint results and preserves TypeScript semantic distinctions", () => {
    const parsed = parseQualityReport({ format: "eslint-json", text: JSON.stringify([{ filePath: "web/a.ts", messages: [
      { ruleId: "@typescript-eslint/no-explicit-any", message: "Unexpected any", line: 2, severity: 1 },
      { ruleId: "@typescript-eslint/no-unsafe-assignment", message: "Unsafe value", line: 4, severity: 2 },
    ] }]) });
    expect(parsed.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "semantic.dynamic_types", line: 2 }),
      expect.objectContaining({ rule: "semantic.unchecked_assertions", line: 4 }),
    ]));
  });

  it("maps only reliable SARIF High findings to the security hard gate", () => {
    const parsed = parseQualityReport({ format: "sarif", text: JSON.stringify({ runs: [{
      tool: { driver: { rules: [{ id: "SEC001", properties: { "security-severity": "8.2" } }] } },
      results: [{ ruleId: "SEC001", level: "error", message: { text: "unsafe input" } }],
    }] }) });
    expect(parsed.findings[0]).toMatchObject({ rule: "security.high_confidence", severity: "high" });
  });

  it("parses coverage.py line and branch evidence", () => {
    const parsed = parseQualityReport({ format: "coveragepy-json", text: JSON.stringify({
      totals: { covered_lines: 2, num_statements: 3, covered_branches: 1, num_branches: 2 },
      files: { "src/a.py": { executed_lines: [2, 8], missing_lines: [3], executed_branches: [[3, 4]], missing_branches: [[3, 5]] } },
    }) });
    expect(parsed.coverage.line).toEqual({ covered: 2, total: 3 });
    expect(parsed.coverage.branch).toEqual({ covered: 1, total: 2 });
    expect(calculateChangedCoverage(parsed.coverage, { "src/a.py": [2, 3] })).toEqual({
      line: { covered: 1, total: 2 }, branch: { covered: 1, total: 2 },
    });
  });

  it("omits Python branch evidence when branch measurement is inactive", () => {
    const parsed = parseQualityReport({ format: "coveragepy-json", text: JSON.stringify({ totals: { covered_lines: 0, num_statements: 0 }, files: {} }) });
    expect(parsed.coverage.branch).toBeUndefined();
  });

  it("parses Istanbul, duplication, mutation, and Ruff reports", () => {
    const istanbul = parseQualityReport({ format: "istanbul-json", text: JSON.stringify({ "web/a.js": {
      s: { 0: 1, 1: 0 }, statementMap: { 0: { start: { line: 2 } }, 1: { start: { line: 3 } } },
      b: { 0: [1, 0] }, branchMap: { 0: { locations: [{ start: { line: 2 } }, { start: { line: 2 } }] } },
    } }) });
    expect(istanbul.coverage.line).toEqual({ covered: 1, total: 2 });
    expect(istanbul.coverage.branch).toEqual({ covered: 1, total: 2 });
    expect(parseQualityReport({ format: "jscpd-json", text: '{"statistics":{"total":{"percentage":4.5}}}' }).metrics[0]).toMatchObject({ rule: "duplication.percent", actual: 4.5 });
    expect(parseQualityReport({ format: "stryker-json", text: '{"metrics":{"mutationScore":86}}' }).metrics[0]).toMatchObject({ rule: "mutation.changed_score", actual: 86 });
    expect(parseQualityReport({ format: "ruff-json", text: '[{"code":"E722","message":"bare except","filename":"a.py","location":{"row":5}}]' }).findings[0]).toMatchObject({ rule: "semantic.swallowed_errors", line: 5 });
  });

  it("accepts exit-code reports and rejects malformed or unknown reports", () => {
    expect(parseQualityReport({ format: "exit-code", text: "" })).toEqual({ metrics: [], findings: [] });
    expect(() => parseQualityReport({ format: "dotbabel-v1", text: "{" })).toThrow(/not valid JSON/);
    expect(() => parseQualityReport({ format: "made-up", text: "{}" })).toThrow(/unsupported quality report/);
  });
});
