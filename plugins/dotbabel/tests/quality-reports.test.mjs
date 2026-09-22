import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { calculateChangedCoverage, calculateChangedMutationScore, parseQualityReport } from "../src/quality/reports.mjs";

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
    // Was: `{"metrics":{"mutationScore":86}}` → `mutation.changed_score: 86`.
    // Stryker's json reporter emits no such field, and a repository-wide score
    // is not a changed-line score either way (KD-7). Per-mutant now.
    expect(parseQualityReport({ format: "stryker-json", text: '{"files":{"a.mjs":{"mutants":[{"status":"Killed","location":{"start":{"line":7}}}]}}}' }).mutants)
      .toEqual([{ file: "a.mjs", line: 7, status: "Killed" }]);
    expect(parseQualityReport({ format: "ruff-json", text: '[{"code":"E722","message":"bare except","filename":"a.py","location":{"row":5}}]' }).findings[0]).toMatchObject({ rule: "semantic.swallowed_errors", line: 5 });
  });

  it("accepts exit-code reports and rejects malformed or unknown reports", () => {
    expect(parseQualityReport({ format: "exit-code", text: "" })).toEqual({ metrics: [], findings: [] });
    expect(() => parseQualityReport({ format: "dotbabel-v1", text: "{" })).toThrow(/not valid JSON/);
    expect(() => parseQualityReport({ format: "made-up", text: "{}" })).toThrow(/unsupported quality report/);
  });
});

// --- P-C2 / P-C3: captured reports from the tools the built-in plans run ----
//
// The cases above use hand-written text, which proves the parser's arithmetic
// but not that it reads what the real tools emit. These read reports captured
// from pinned versions (see each fixture directory's VERSIONS.md), so a format
// change in pytest-cov, Vitest or Jest fails here rather than silently
// producing a coverage result of zero.

describe("captured coverage reports", () => {
  const fixture = (...parts) =>
    fs.readFileSync(path.join(import.meta.dirname, "fixtures", "quality", ...parts), "utf8");

  it("parses a captured pytest-cov JSON report", () => {
    const parsed = parseQualityReport({ format: "coveragepy-json", text: fixture("pytest-cov", "coverage.json") });
    expect(parsed.coverage.line).toEqual({ covered: 6, total: 8 });
    expect(parsed.coverage.branch).toEqual({ covered: 3, total: 4 });

    // Per-file detail survives, so changed-line coverage can be computed.
    const changed = calculateChangedCoverage(parsed.coverage, { "src/calc.py": [4, 8] });
    expect(changed.line).toEqual({ covered: 1, total: 2 });
  });

  it("parses captured Vitest and Jest coverage-final.json reports", () => {
    const vitest = parseQualityReport({ format: "istanbul-json", text: fixture("istanbul", "vitest-coverage-final.json") });
    expect(vitest.coverage.line).toEqual({ covered: 2, total: 3 });
    expect(vitest.coverage.branch).toEqual({ covered: 1, total: 2 });

    const jest = parseQualityReport({ format: "istanbul-json", text: fixture("istanbul", "jest-coverage-final.json") });
    expect(jest.coverage.line).toEqual({ covered: 2, total: 2 });
    expect(jest.coverage.branch).toEqual({ covered: 2, total: 2 });

    // One parser serves both, which is the reason the plans request this
    // format from either runner.
    const changed = calculateChangedCoverage(vitest.coverage, { "/repo/src/calc.js": [4, 7] });
    expect(changed.line).toEqual({ covered: 1, total: 2 });
  });
});

// --- P-C4: per-mutant parsing and changed-line mutation scoring (KD-7) -----
//
// The old `stryker-json` parser read one top-level number, so a mutation score
// described the whole repository no matter how small the diff. KD-7 replaces
// that with per-mutant parsing: a mutant counts only when it STARTS on a line
// the pull request changed.
//
// Every fixture here is the real output of a real run — see the directory's
// VERSIONS.md. A parser proved against an invented shape is not proved.

describe("mutation reports", () => {
  const mutationFixture = (name) =>
    fs.readFileSync(path.join(import.meta.dirname, "fixtures", "quality", "mutation", name), "utf8");

  it("parses a captured Stryker mutation-testing-elements report into per-mutant results", () => {
    const parsed = parseQualityReport({ format: "stryker-json", text: mutationFixture("stryker-mutation.json") });
    expect(parsed.mutants).toHaveLength(18);

    // Line attribution is the whole point: without it there is no changed-line
    // score, only a repository-wide one.
    for (const m of parsed.mutants) {
      expect(typeof m.file).toBe("string");
      expect(Number.isInteger(m.line)).toBe(true);
      expect(typeof m.status).toBe("string");
    }
    const statuses = new Set(parsed.mutants.map((m) => m.status));
    expect(statuses.has("Killed")).toBe(true);
    expect(statuses.has("Survived")).toBe(true);
  });

  it("scores only mutants on changed lines as detected divided by valid times 100", () => {
    const mutants = [
      { file: "src/a.mjs", line: 10, status: "Killed" },
      { file: "src/a.mjs", line: 10, status: "Survived" },
      { file: "src/a.mjs", line: 99, status: "Survived" }, // unchanged line, excluded
      { file: "src/b.mjs", line: 3, status: "Killed" }, // unchanged file, excluded
    ];
    const score = calculateChangedMutationScore(mutants, { "src/a.mjs": [10] });
    expect(score).toEqual({ detected: 1, valid: 2, actual: 50 });
  });

  it("excludes compile-error and ignored mutants from the valid count", () => {
    // A mutant that never compiled tested nothing, and an ignored one was
    // deliberately excluded. Counting either as survived would punish the
    // author for the tool's own bookkeeping.
    const mutants = [
      { file: "a.mjs", line: 1, status: "Killed" },
      { file: "a.mjs", line: 1, status: "CompileError" },
      { file: "a.mjs", line: 1, status: "Ignored" },
      { file: "a.mjs", line: 1, status: "RuntimeError" },
    ];
    expect(calculateChangedMutationScore(mutants, { "a.mjs": [1] })).toEqual({ detected: 1, valid: 1, actual: 100 });
  });

  it("reports mutation.changed_score as not_applicable when no mutant starts on a changed line", () => {
    const mutants = [{ file: "a.mjs", line: 50, status: "Killed" }];
    expect(calculateChangedMutationScore(mutants, { "a.mjs": [1, 2] })).toBeNull();
    // An empty mutant list is the same answer, not a zero score.
    expect(calculateChangedMutationScore([], { "a.mjs": [1] })).toBeNull();
  });

  it("parses a captured mutmut report fixture", () => {
    const parsed = parseQualityReport({ format: "mutmut-json", text: mutationFixture("mutmut-cicd-stats.json") });
    // mutmut emits aggregate counts only — see VERSIONS.md. There are no
    // per-mutant lines to parse, so the changed-line score is not_applicable
    // (KD-7, REL-11) and the whole-suite number rides along as evidence
    // rather than as `actual`, which the 85 threshold would otherwise judge.
    expect(parsed.mutants).toBeUndefined();
    const metric = parsed.metrics.find((m) => m.rule === "mutation.changed_score");
    expect(metric.not_applicable).toBe(true);
    expect(metric.actual).toBeUndefined();
    expect(metric.whole_suite_score).toBeCloseTo((11 / 15) * 100, 5);
    expect(metric.evidence).toMatch(/aggregate/i);
  });

  it("parses a captured Gremlins report fixture", () => {
    const parsed = parseQualityReport({ format: "gremlins-json", text: mutationFixture("gremlins-report.json") });
    expect(parsed.mutants).toHaveLength(6);
    expect(parsed.mutants.every((m) => m.file === "calc.go")).toBe(true);
    expect(parsed.mutants.filter((m) => m.status === "KILLED")).toHaveLength(5);
    expect(parsed.mutants.filter((m) => m.status === "LIVED")).toHaveLength(1);

    // The captured run put one LIVED and one KILLED mutant on line 10.
    expect(calculateChangedMutationScore(parsed.mutants, { "calc.go": [10] })).toEqual({ detected: 1, valid: 2, actual: 50 });
  });

  it("keeps any generated mutant set's score between 0 and 100", () => {
    // Property sweep: whatever mix of statuses arrives, a percentage that
    // escapes [0, 100] would be a arithmetic bug that a single fixture hides.
    const statuses = ["Killed", "Survived", "Timeout", "NoCoverage", "CompileError", "Ignored"];
    for (let seed = 0; seed < 60; seed += 1) {
      const mutants = Array.from({ length: (seed % 11) + 1 }, (_, i) => ({
        file: "a.mjs",
        line: 1,
        status: statuses[(seed + i) % statuses.length],
      }));
      const score = calculateChangedMutationScore(mutants, { "a.mjs": [1] });
      if (score === null) continue;
      expect(score.actual).toBeGreaterThanOrEqual(0);
      expect(score.actual).toBeLessThanOrEqual(100);
      expect(score.detected).toBeLessThanOrEqual(score.valid);
    }
  });

  it("survives mutation reports missing the fields it reads", () => {
    // These are the shapes a tool emits when it ran but found nothing, or when
    // a schema shifts under us. Each must yield an empty result, never a throw
    // — a parser crash takes down the whole quality run, turning one
    // unreadable report into no measurements at all.
    for (const text of ["{}", '{"files":{}}', '{"files":{"a.mjs":{}}}']) {
      expect(parseQualityReport({ format: "stryker-json", text }).mutants).toEqual([]);
    }
    // A mutant with no usable line cannot be attributed to a change, so it is
    // dropped rather than guessed at.
    expect(parseQualityReport({ format: "stryker-json", text: '{"files":{"a.mjs":{"mutants":[{"status":"Killed"},{"status":"Killed","location":{"start":{}}}]}}}' }).mutants).toEqual([]);

    for (const text of ["{}", '{"files":[]}', '{"files":[{"file_name":"a.go"}]}', '{"files":[{"mutations":[{"status":"KILLED"}]}]}']) {
      expect(parseQualityReport({ format: "gremlins-json", text }).mutants).toEqual([]);
    }

    // mutmut with nothing to divide by: still not_applicable, with no score.
    for (const text of ["{}", '{"killed":0,"total":0}']) {
      const metric = parseQualityReport({ format: "mutmut-json", text }).metrics[0];
      expect(metric.not_applicable).toBe(true);
      expect(metric.whole_suite_score).toBeUndefined();
    }
  });

  it("treats an absent mutant list and absent changed lines as no score", () => {
    expect(calculateChangedMutationScore(undefined, { "a.mjs": [1] })).toBeNull();
    expect(calculateChangedMutationScore([{ file: "a.mjs", line: 1, status: "Killed" }], undefined)).toBeNull();
    // A mutant with no status is not evidence of detection.
    expect(calculateChangedMutationScore([{ file: "a.mjs", line: 1 }], { "a.mjs": [1] })).toEqual({ detected: 0, valid: 1, actual: 0 });
  });

  it("stays fast when the CHANGED-LINE count is large, not only the mutant count", () => {
    // The 20000-mutant case below holds changed lines at 3 per file, so it
    // only exercises one axis. A linear `includes` scan per mutant is
    // O(mutants x changed lines), and a large refactor moves the other axis:
    // 20000 mutants against 5000 changed lines is 10^8 comparisons.
    // Worst case on purpose: every lookup must walk the WHOLE array. A miss
    // scans all 5000 entries before failing, and a hit on the last entry
    // scans all 5000 before succeeding — so a short-circuiting early hit
    // cannot hide the cost. 20000 x 5000 is 10^8 comparisons.
    const changedLines = { "src/a.mjs": Array.from({ length: 5000 }, (_, i) => i + 1) };
    const mutants = Array.from({ length: 20000 }, (_, i) => i % 2
      ? { file: "src/a.mjs", line: 999999, status: "Killed" }   // miss: full scan
      : { file: "src/a.mjs", line: 5000, status: "Killed" });   // hit at the end: full scan

    // Best of several runs, not one. Measured on this workload: a per-mutant
    // `includes` scan costs ~230ms at its fastest and ~600ms under suite load;
    // the Set costs ~3ms. 100ms sits below the linear floor and leaves the Set
    // a 30x margin, so the bound separates the two algorithms instead of timing
    // the machine -- but a single sample also measures whatever else shares the
    // machine at that instant, and failed at 124-130ms under concurrent `npm
    // test` + `npm run coverage` on an unmodified checkout (#390). The fastest
    // of a few catches the algorithm's real cost; a quadratic scan is slow on
    // every run, not just an unlucky one.
    let best = Number.POSITIVE_INFINITY;
    let score;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = Date.now();
      score = calculateChangedMutationScore(mutants, changedLines);
      best = Math.min(best, Date.now() - started);
    }

    expect(score).toMatchObject({ valid: 10000, detected: 10000, actual: 100 });
    expect(best).toBeLessThan(100);
  });

  it("parses a report with 20000 mutants in under 2 seconds", () => {
    const files = {};
    for (let i = 0; i < 20; i += 1) {
      files[`src/f${i}.mjs`] = {
        mutants: Array.from({ length: 1000 }, (_, n) => ({
          id: `${i}-${n}`,
          mutatorName: "ArithmeticOperator",
          status: n % 3 === 0 ? "Survived" : "Killed",
          location: { start: { line: (n % 200) + 1, column: 1 }, end: { line: (n % 200) + 1, column: 9 } },
        })),
      };
    }
    const text = JSON.stringify({ schemaVersion: "1.0", files });

    const started = Date.now();
    const parsed = parseQualityReport({ format: "stryker-json", text });
    const changedLines = Object.fromEntries(Object.keys(files).map((f) => [f, [1, 2, 3]]));
    const score = calculateChangedMutationScore(parsed.mutants, changedLines);
    const elapsed = Date.now() - started;

    expect(parsed.mutants).toHaveLength(20000);
    expect(score.valid).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });
});
