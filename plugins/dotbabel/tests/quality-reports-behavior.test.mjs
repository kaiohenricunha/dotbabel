// Behavioral boundaries of `quality/reports.mjs` (TEST-1, mutation floor 85).
//
// `quality-reports.test.mjs` proves each parser reads a well-formed report. What
// it leaves loose is everything at the edges of a rule: which analyzer names map
// to which rule, where a SARIF severity score flips from "lint" to "security",
// whether a coverage block's range is inclusive, and when two changed paths are
// ambiguous. Those are decisions the parsers make silently, and a wrong one
// produces a plausible-looking number rather than an error — which is why each
// case below sits on a boundary or uses a near-miss input.
//
// Every expectation states an outcome a caller can observe. None asserts how the
// parser reaches it.

import { describe, expect, it } from "vitest";

import {
  calculateChangedCoverage,
  calculateChangedMutationScore,
  coveragePercent,
  parseQualityReport,
} from "../src/quality/reports.mjs";

const parse = (format, body) => parseQualityReport({ format, text: typeof body === "string" ? body : JSON.stringify(body) });

const caught = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

describe("malformed reports fail loudly and identically", () => {
  const jsonFormats = [
    "dotbabel-v1",
    "istanbul-json",
    "coveragepy-json",
    "jscpd-json",
    "stryker-json",
    "gremlins-json",
    "mutmut-json",
    "sarif",
    "golangci-json",
    "eslint-json",
    "ruff-json",
  ];

  it.each(jsonFormats)("%s reports invalid JSON as QUALITY_REPORT_INVALID in the quality category", (format) => {
    const error = caught(() => parse(format, "{ not json"));
    expect(error, `${format} accepted invalid JSON`).not.toBeNull();
    expect(error.code).toBe("QUALITY_REPORT_INVALID");
    expect(error.category).toBe("quality");
    // The underlying parser's reason travels with it, so the message says what
    // is wrong rather than only that something is.
    expect(error.message).toMatch(/not valid JSON: .+/);
  });

  it("reports an unknown format as QUALITY_REPORT_INVALID and names the format", () => {
    const error = caught(() => parse("made-up", "{}"));
    expect(error.code).toBe("QUALITY_REPORT_INVALID");
    expect(error.category).toBe("quality");
    expect(error.message).toContain("made-up");
  });
});

describe("dotbabel-v1", () => {
  const report = (extra) => ({ schema_version: 1, ...extra });

  it("returns the metrics and findings it was given, untouched", () => {
    const metrics = [{ rule: "duplication.percent", actual: 4 }];
    const findings = [{ rule: "correctness.lint", message: "m" }];
    expect(parse("dotbabel-v1", report({ metrics, findings }))).toEqual({ metrics, findings });
  });

  it("requires BOTH arrays, each on its own", () => {
    // `||` between the two checks: dropping either half must still be rejected.
    expect(caught(() => parse("dotbabel-v1", report({ metrics: [] })))?.code).toBe("QUALITY_REPORT_INVALID");
    expect(caught(() => parse("dotbabel-v1", report({ findings: [] })))?.code).toBe("QUALITY_REPORT_INVALID");
    expect(caught(() => parse("dotbabel-v1", report({ metrics: {}, findings: [] })))?.code).toBe("QUALITY_REPORT_INVALID");
    expect(caught(() => parse("dotbabel-v1", report({ metrics: [], findings: "none" })))?.code).toBe("QUALITY_REPORT_INVALID");
    expect(caught(() => parse("dotbabel-v1", report({ metrics: [], findings: [] })))).toBeNull();
  });

  it("names what is missing", () => {
    expect(caught(() => parse("dotbabel-v1", report({})))?.message).toMatch(/metrics and findings/);
  });
});

describe("analyzer names map to exactly one rule each", () => {
  // Names arrive as `FromLinter` (golangci), `ruleId` (ESLint), or `code` (Ruff).
  const golangci = (name) => parse("golangci-json", { Issues: [{ FromLinter: name, Text: "t" }] }).findings[0].rule;

  it.each([
    ["gocognit", "complexity.cognitive"],
    ["gocyclo", "complexity.cyclomatic"],
    ["cyclop", "complexity.cyclomatic"],
    ["errcheck", "semantic.ignored_errors"],
    ["unused", "maintainability.dead_code"],
    ["@typescript-eslint/no-explicit-any", "semantic.dynamic_types"],
    ["ANN401", "semantic.dynamic_types"],
    ["@typescript-eslint/no-unsafe-assignment", "semantic.unchecked_assertions"],
    ["@typescript-eslint/no-unsafe-call", "semantic.unchecked_assertions"],
    ["@typescript-eslint/consistent-type-assertions", "semantic.unchecked_assertions"],
    ["@typescript-eslint/no-non-null-assertion", "semantic.unchecked_assertions"],
    ["E722", "semantic.swallowed_errors"],
    ["BLE001", "semantic.swallowed_errors"],
    ["govet", "correctness.lint"],
  ])("%s -> %s", (name, rule) => {
    expect(golangci(name)).toBe(rule);
  });

  it.each([
    // The equality checks are exact: a name that merely CONTAINS or extends a
    // known one must not inherit its rule.
    "gocognit-extra",
    "gocyclo2",
    "cyclops",
    "errcheck2",
    "unused-param",
    "E7221",
    "BLE0011",
    "ann401",
    "e722",
    // The substring checks need their whole marker, dash included.
    "unsafe",
    "no-unsafe",
    "no-explicit",
  ])("%s is plain lint, not a semantic rule", (name) => {
    expect(golangci(name)).toBe("correctness.lint");
  });

  it("falls back to lint when the item names no analyzer at all", () => {
    expect(parse("golangci-json", { Issues: [{ Text: "t" }] }).findings[0].rule).toBe("correctness.lint");
  });

  it("prefers FromLinter over ruleId over code", () => {
    const rule = (item) => parse("golangci-json", { Issues: [item] }).findings[0].rule;
    expect(rule({ FromLinter: "gocyclo", ruleId: "unused", code: "E722" })).toBe("complexity.cyclomatic");
    expect(rule({ ruleId: "unused", code: "E722" })).toBe("maintainability.dead_code");
    expect(rule({ code: "E722" })).toBe("semantic.swallowed_errors");
  });
});

describe("lint findings", () => {
  it("golangci: reads Text, position and fingerprint from their own fields", () => {
    const { findings } = parse("golangci-json", {
      Issues: [{ FromLinter: "govet", Text: "shadowed", Pos: { Filename: "a.go", Line: 7 }, fingerprint: "fp-1" }],
    });
    expect(findings).toEqual([{ rule: "correctness.lint", message: "shadowed", severity: "warning", path: "a.go", line: 7, fingerprint: "fp-1" }]);
  });

  it("golangci: a body with no Issues has no findings", () => {
    expect(parse("golangci-json", {}).findings).toEqual([]);
  });

  it("eslint: flattens messages under their file and maps numeric severity", () => {
    const { findings } = parse("eslint-json", [
      {
        filePath: "src/a.js",
        messages: [
          { ruleId: "no-undef", message: "x is not defined", severity: 2, line: 3 },
          { ruleId: "semi", message: "missing semicolon", severity: 1, line: 9 },
        ],
      },
      { filePath: "src/b.js", messages: [] },
      { filePath: "src/c.js" },
    ]);
    expect(findings).toEqual([
      { rule: "correctness.lint", message: "x is not defined", severity: "error", path: "src/a.js", line: 3, fingerprint: undefined },
      { rule: "correctness.lint", message: "missing semicolon", severity: "warning", path: "src/a.js", line: 9, fingerprint: undefined },
    ]);
  });

  it("eslint: a body that is not an array has no findings", () => {
    expect(parse("eslint-json", { messages: [{ message: "m" }] }).findings).toEqual([]);
  });

  it("ruff: reads filename and the row of its location", () => {
    const { findings } = parse("ruff-json", [{ code: "E722", message: "bare except", filename: "a.py", location: { row: 12, column: 1 } }]);
    expect(findings).toEqual([{ rule: "semantic.swallowed_errors", message: "bare except", severity: "warning", path: "a.py", line: 12, fingerprint: undefined }]);
  });

  it("ruff: a body that is not an array has no findings", () => {
    expect(parse("ruff-json", { code: "E722" }).findings).toEqual([]);
  });

  it("passes an unrecognised severity through and defaults an absent one to warning", () => {
    const severity = (item) => parse("golangci-json", { Issues: [{ Text: "t", ...item }] }).findings[0].severity;
    expect(severity({ severity: "info" })).toBe("info");
    expect(severity({ severity: 2 })).toBe("error");
    expect(severity({ severity: 1 })).toBe("warning");
    expect(severity({})).toBe("warning");
  });

  it("uses a generic message when the tool supplied none, and prefers Text over message", () => {
    const message = (item) => parse("golangci-json", { Issues: [item] }).findings[0].message;
    expect(message({ FromLinter: "govet" })).toBe("tool finding");
    expect(message({ Text: "from text", message: "from message" })).toBe("from text");
    expect(message({ message: "from message" })).toBe("from message");
  });

  it("reads the position from whichever field the tool used", () => {
    const at = (item) => {
      const [f] = parse("golangci-json", { Issues: [{ Text: "t", ...item }] }).findings;
      return [f.path, f.line];
    };
    expect(at({ Pos: { Filename: "g.go", Line: 1 }, filePath: "e.js", line: 2 })).toEqual(["g.go", 1]);
    expect(at({ filePath: "e.js", filename: "r.py", line: 2 })).toEqual(["e.js", 2]);
    expect(at({ filename: "r.py", location: { row: 3 } })).toEqual(["r.py", 3]);
  });
});

describe("SARIF security classification", () => {
  const sarif = (result, rules = []) => ({
    runs: [{ tool: { driver: { rules } }, results: [{ ruleId: "R", message: { text: "m" }, ...result }] }],
  });
  const finding = (result, rules) => parse("sarif", sarif(result, rules)).findings[0];

  it.each([
    [6.9, "correctness.lint"],
    [7, "security.high_confidence"],
    [8.9, "security.high_confidence"],
    [9, "security.high_confidence"],
    [10, "security.high_confidence"],
  ])("a numeric security-severity of %s is %s", (score, rule) => {
    expect(finding({ properties: { "security-severity": String(score) } }).rule).toBe(rule);
  });

  it.each([
    [7, "high"],
    [8.9, "high"],
    [9, "critical"],
    [9.8, "critical"],
  ])("a security-severity of %s is reported as %s", (score, severity) => {
    expect(finding({ properties: { "security-severity": String(score) } }).severity).toBe(severity);
  });

  it("takes the score from the rule when the result carries none, and the result wins when both do", () => {
    const rules = [{ id: "R", properties: { "security-severity": "9.5" } }];
    expect(finding({}, rules).rule).toBe("security.high_confidence");
    expect(finding({}, rules).severity).toBe("critical");
    expect(finding({ properties: { "security-severity": "2" } }, rules).rule).toBe("correctness.lint");
  });

  it("falls back to the level when there is no numeric score, ignoring case", () => {
    expect(finding({ level: "high" }).rule).toBe("security.high_confidence");
    expect(finding({ level: "CRITICAL" }).rule).toBe("security.high_confidence");
    expect(finding({ level: "error" }).rule).toBe("correctness.lint");
    expect(finding({ level: "note" }).rule).toBe("correctness.lint");
    expect(finding({}).rule).toBe("correctness.lint");
  });

  it("does not let a non-numeric score hide a high level", () => {
    expect(finding({ properties: { "security-severity": "n/a" }, level: "high" }).rule).toBe("security.high_confidence");
    expect(finding({ properties: { "security-severity": "n/a" }, level: "note" }).rule).toBe("correctness.lint");
  });

  it("lets a numeric score outrank the level", () => {
    expect(finding({ properties: { "security-severity": "3" }, level: "high" }).rule).toBe("correctness.lint");
  });

  it("keeps the tool's own level as the severity of a lint finding, defaulting to warning", () => {
    expect(finding({ level: "error" }).severity).toBe("error");
    expect(finding({ level: "note" }).severity).toBe("note");
    expect(finding({}).severity).toBe("warning");
  });

  it("carries the message, location and fingerprint", () => {
    const f = finding({
      locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.js" }, region: { startLine: 42 } } }],
      partialFingerprints: { primaryLocationLineHash: "abc:1" },
    });
    expect(f).toMatchObject({ message: "m", path: "src/a.js", line: 42, fingerprint: "abc:1" });
  });

  it("supplies a generic message and leaves the location empty when the result has none", () => {
    const f = parse("sarif", { runs: [{ results: [{ ruleId: "R" }] }] }).findings[0];
    expect(f.message).toBe("tool finding");
    expect(f.path).toBeUndefined();
    expect(f.line).toBeUndefined();
    expect(f.fingerprint).toBeUndefined();
  });

  it("reads rules per run, so one run's rule does not classify another run's result", () => {
    const { findings } = parse("sarif", {
      runs: [
        { tool: { driver: { rules: [{ id: "R", properties: { "security-severity": "9" } }] } }, results: [{ ruleId: "R", message: { text: "a" } }] },
        { tool: { driver: { rules: [] } }, results: [{ ruleId: "R", message: { text: "b" } }] },
      ],
    });
    expect(findings.map((f) => f.rule)).toEqual(["security.high_confidence", "correctness.lint"]);
  });

  it("tolerates a report with no runs, no results, or no rule list", () => {
    expect(parse("sarif", {}).findings).toEqual([]);
    expect(parse("sarif", { runs: [{}] }).findings).toEqual([]);
    expect(parse("sarif", { runs: [{ tool: {}, results: [{ ruleId: "R", message: { text: "m" } }] }] }).findings).toHaveLength(1);
  });
});

describe("go-coverprofile", () => {
  const profile = (...lines) => ["mode: set", ...lines].join("\n");

  it("sums statements, counting a block covered only when its count is above zero", () => {
    const { coverage } = parse("go-coverprofile", profile("a.go:1.1,3.2 4 1", "a.go:5.1,6.2 2 0", "b.go:1.1,2.2 3 7"));
    expect(coverage.statement).toEqual({ covered: 7, total: 9 });
  });

  it("keeps each block's path, range, statement count and hit count", () => {
    const { coverage } = parse("go-coverprofile", profile("a.go:10.4,12.9 3 2"));
    expect(coverage.blocks).toEqual([{ path: "a.go", start: 10, end: 12, statements: 3, count: 2 }]);
  });

  it("skips blank lines and lines that are not blocks", () => {
    const { coverage } = parse("go-coverprofile", profile("", "not a block", "a.go:1.1,2.2 5 1", ""));
    expect(coverage.blocks).toHaveLength(1);
    expect(coverage.statement).toEqual({ covered: 5, total: 5 });
  });

  it("rejects a block line with trailing text, a missing column, or leading text before the path", () => {
    const { coverage } = parse("go-coverprofile", profile("a.go:1.1,2.2 5 1 extra", "a.go:1,2.2 5 1", "a.go:1.1,2 5 1", "a.go:1.1,2.2 5", "a.go:x.1,2.2 5 1"));
    expect(coverage.blocks).toEqual([]);
    expect(coverage.statement).toEqual({ covered: 0, total: 0 });
  });

  it("accepts a path that itself contains a colon", () => {
    const { coverage } = parse("go-coverprofile", profile("C:/repo/a.go:1.1,2.2 2 1"));
    expect(coverage.blocks[0].path).toBe("C:/repo/a.go");
  });

  it("accepts any run of whitespace between the fields", () => {
    const { coverage } = parse("go-coverprofile", profile("a.go:1.1,2.2   3 \t 1"));
    expect(coverage.blocks).toHaveLength(1);
    expect(coverage.blocks[0]).toMatchObject({ statements: 3, count: 1 });
  });

  it("parses multi-digit lines and counts as whole numbers", () => {
    const { coverage } = parse("go-coverprofile", profile("a.go:120.1,345.9 12 250"));
    expect(coverage.blocks[0]).toEqual({ path: "a.go", start: 120, end: 345, statements: 12, count: 250 });
  });

  it("emits no branch coverage, since the profile has none", () => {
    expect(parse("go-coverprofile", profile("a.go:1.1,2.2 1 1")).coverage.branch).toBeUndefined();
  });
});

describe("lcov", () => {
  it("prefers the summary counters when the file records them, summing across files", () => {
    const { coverage } = parse(
      "lcov",
      ["SF:a.js", "DA:1,1", "LF:3", "LH:2", "end_of_record", "SF:b.js", "DA:1,1", "LF:4", "LH:4", "end_of_record"].join("\n"),
    );
    expect(coverage.line).toEqual({ covered: 6, total: 7 });
  });

  it("derives line totals from DA records when no summary counter is present", () => {
    const { coverage } = parse("lcov", ["SF:a.js", "DA:1,1", "DA:2,0", "DA:3,5", "end_of_record", "SF:b.js", "DA:1,0", "end_of_record"].join("\n"));
    expect(coverage.line).toEqual({ covered: 2, total: 4 });
  });

  it("derives line totals from DA records when the summary counter is zero", () => {
    const { coverage } = parse("lcov", ["SF:a.js", "DA:1,1", "DA:2,0", "LF:0", "LH:0", "end_of_record"].join("\n"));
    expect(coverage.line).toEqual({ covered: 1, total: 2 });
  });

  it("records per-file lines and branches, treating a dash hit count as zero", () => {
    const { coverage } = parse(
      "lcov",
      ["SF:a.js", "DA:10,3", "DA:11,0", "BRDA:10,0,0,4", "BRDA:10,0,1,-", "end_of_record"].join("\n"),
    );
    expect(coverage.files["a.js"]).toEqual({
      lines: [
        { line: 10, count: 3 },
        { line: 11, count: 0 },
      ],
      branches: [
        { line: 10, count: 4 },
        { line: 10, count: 0 },
      ],
    });
  });

  it("uses the branch summary counters when present and derives them from BRDA otherwise", () => {
    const summarised = parse("lcov", ["SF:a.js", "BRDA:1,0,0,1", "BRF:5", "BRH:3", "end_of_record"].join("\n")).coverage;
    expect(summarised.branch).toEqual({ covered: 3, total: 5 });
    const derived = parse("lcov", ["SF:a.js", "BRDA:1,0,0,1", "BRDA:1,0,1,0", "BRDA:2,0,0,-", "end_of_record"].join("\n")).coverage;
    expect(derived.branch).toEqual({ covered: 1, total: 3 });
  });

  it("omits the branch key entirely when the report has no branch data", () => {
    const { coverage } = parse("lcov", ["SF:a.js", "DA:1,1", "end_of_record"].join("\n"));
    expect(coverage.branch).toBeUndefined();
  });

  it("normalises Windows separators in the file path", () => {
    const { coverage } = parse("lcov", ["SF:src\\deep\\a.js", "DA:1,1", "end_of_record"].join("\n"));
    expect(Object.keys(coverage.files)).toEqual(["src/deep/a.js"]);
  });

  it("ignores line and branch records that appear before any file", () => {
    const { coverage } = parse("lcov", ["DA:1,1", "BRDA:1,0,0,1", "SF:a.js", "DA:2,1", "end_of_record"].join("\n"));
    expect(coverage.files["a.js"].lines).toEqual([{ line: 2, count: 1 }]);
    expect(coverage.files["a.js"].branches).toEqual([]);
  });

  it("accepts a DA record that carries a checksum after the hit count", () => {
    const { coverage } = parse("lcov", ["SF:a.js", "DA:4,2,abc123", "end_of_record"].join("\n"));
    expect(coverage.files["a.js"].lines).toEqual([{ line: 4, count: 2 }]);
  });

  it("rejects counter and record lines that do not fit their pattern", () => {
    const { coverage } = parse("lcov", ["SF:a.js", "LF:x", "LFX:9", "DA:1", "DA:a,1", "BRDA:1,0,0", "end_of_record"].join("\n"));
    expect(coverage.files["a.js"]).toEqual({ lines: [], branches: [] });
    expect(coverage.line).toEqual({ covered: 0, total: 0 });
  });
});

describe("coverage.py JSON", () => {
  it("reads totals, and per-file executed and missing lines and branches", () => {
    const { coverage } = parse("coveragepy-json", {
      totals: { covered_lines: 8, num_statements: 10, num_branches: 4, covered_branches: 3 },
      files: {
        "pkg\\mod.py": {
          executed_lines: [1, 2],
          missing_lines: [3],
          executed_branches: [[1, 2], [1, 3]],
          missing_branches: [[4, 5]],
        },
      },
    });
    expect(coverage.line).toEqual({ covered: 8, total: 10 });
    expect(coverage.branch).toEqual({ covered: 3, total: 4 });
    expect(coverage.files["pkg/mod.py"]).toEqual({
      lines: [
        { line: 1, count: 1 },
        { line: 2, count: 1 },
        { line: 3, count: 0 },
      ],
      branches: [
        { line: 1, count: 1 },
        { line: 1, count: 1 },
        { line: 4, count: 0 },
      ],
    });
  });

  it("treats missing totals as zero and omits branch data when branches were not measured", () => {
    const { coverage } = parse("coveragepy-json", {});
    expect(coverage.line).toEqual({ covered: 0, total: 0 });
    expect(coverage.branch).toBeUndefined();
    expect(coverage.files).toEqual({});
  });

  it("keeps a measured-but-empty branch total, distinct from not measured", () => {
    expect(parse("coveragepy-json", { totals: { num_branches: 0 } }).coverage.branch).toEqual({ covered: 0, total: 0 });
    expect(parse("coveragepy-json", { totals: { num_branches: 6 } }).coverage.branch).toEqual({ covered: 0, total: 6 });
  });

  it("tolerates a file entry with no line or branch lists", () => {
    const { coverage } = parse("coveragepy-json", { files: { "a.py": {} } });
    expect(coverage.files["a.py"]).toEqual({ lines: [], branches: [] });
  });
});

describe("istanbul JSON", () => {
  it("counts statements and branch arms, taking each arm's line from its own location", () => {
    const { coverage } = parse("istanbul-json", {
      "src\\a.js": {
        s: { 0: 1, 1: 0 },
        statementMap: { 0: { start: { line: 10 } }, 1: { start: { line: 11 } } },
        b: { 0: [3, 0] },
        branchMap: { 0: { line: 12, locations: [{ start: { line: 12 } }, { start: { line: 13 } }] } },
      },
    });
    expect(coverage.line).toEqual({ covered: 1, total: 2 });
    expect(coverage.branch).toEqual({ covered: 1, total: 2 });
    expect(coverage.files["src/a.js"]).toEqual({
      lines: [
        { line: 10, count: 1 },
        { line: 11, count: 0 },
      ],
      branches: [
        { line: 12, count: 3 },
        { line: 13, count: 0 },
      ],
    });
  });

  it("falls back to the branch's own line when an arm has no location", () => {
    const { coverage } = parse("istanbul-json", { "a.js": { s: {}, b: { 0: [1] }, branchMap: { 0: { line: 7 } } } });
    expect(coverage.files["a.js"].branches).toEqual([{ line: 7, count: 1 }]);
  });

  it("sums across files and reports zero, not absence, for a file with no maps", () => {
    const { coverage } = parse("istanbul-json", {
      "a.js": { s: { 0: 1 }, statementMap: { 0: { start: { line: 1 } } } },
      "b.js": { s: { 0: 0 }, statementMap: { 0: { start: { line: 1 } } } },
      "c.js": {},
    });
    expect(coverage.line).toEqual({ covered: 1, total: 2 });
    expect(coverage.branch).toEqual({ covered: 0, total: 0 });
    expect(Object.keys(coverage.files)).toEqual(["a.js", "b.js", "c.js"]);
    expect(coverage.files["c.js"]).toEqual({ lines: [], branches: [] });
  });
});

describe("jscpd JSON", () => {
  it("reads the percentage from statistics.total, then from total", () => {
    expect(parse("jscpd-json", { statistics: { total: { percentage: 4.5 } } }).metrics).toEqual([{ rule: "duplication.percent", actual: 4.5 }]);
    expect(parse("jscpd-json", { total: { percentage: 2 } }).metrics).toEqual([{ rule: "duplication.percent", actual: 2 }]);
    expect(parse("jscpd-json", { statistics: { total: { percentage: 1 } }, total: { percentage: 9 } }).metrics[0].actual).toBe(1);
  });

  it("reports a genuine zero percent instead of dropping it", () => {
    expect(parse("jscpd-json", { statistics: { total: { percentage: 0 } } }).metrics).toEqual([{ rule: "duplication.percent", actual: 0 }]);
  });

  it("emits no metric when the report has no percentage, and never a finding", () => {
    expect(parse("jscpd-json", {})).toEqual({ metrics: [], findings: [] });
  });
});

describe("mutation report parsers", () => {
  it("stryker: normalises paths and keeps only mutants with an integer start line", () => {
    const { mutants } = parse("stryker-json", {
      files: {
        ".\\src\\a.js": {
          mutants: [
            { status: "Killed", location: { start: { line: 3 } } },
            { status: "Survived", location: { start: { line: 3.5 } } },
            { status: "Survived", location: { start: { line: "4" } } },
            { status: "Survived", location: {} },
            { status: "Survived" },
          ],
        },
        "./src/b.js": { mutants: [{ status: "Timeout", location: { start: { line: 9 } } }] },
        "src/c.js": {},
      },
    });
    expect(mutants).toEqual([
      { file: "src/a.js", line: 3, status: "Killed" },
      { file: "src/b.js", line: 9, status: "Timeout" },
    ]);
  });

  it("stryker: a report with no files has no mutants", () => {
    expect(parse("stryker-json", {}).mutants).toEqual([]);
  });

  it("gremlins: normalises the file name and keeps only integer lines", () => {
    const { mutants } = parse("gremlins-json", {
      files: [
        { file_name: ".\\pkg\\a.go", mutations: [{ line: 5, status: "KILLED" }, { line: "6", status: "LIVED" }, { status: "LIVED" }] },
        { file_name: "./pkg/b.go" },
        {},
      ],
    });
    expect(mutants).toEqual([{ file: "pkg/a.go", line: 5, status: "KILLED" }]);
  });

  it("gremlins: a report with no files has no mutants", () => {
    expect(parse("gremlins-json", {}).mutants).toEqual([]);
  });

  it("mutmut: is never applicable to a changed-line score, but carries the whole-suite score apart from `actual`", () => {
    const { metrics, findings } = parse("mutmut-json", { total: 10, killed: 7 });
    expect(findings).toEqual([]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ rule: "mutation.changed_score", not_applicable: true, whole_suite_score: 70 });
    expect(metrics[0].actual).toBeUndefined();
    expect(metrics[0].evidence).toMatch(/aggregate/);
  });

  it("mutmut: reports a whole-suite score of zero when nothing was killed", () => {
    expect(parse("mutmut-json", { total: 10, killed: 0 }).metrics[0].whole_suite_score).toBe(0);
  });

  it("mutmut: carries no whole-suite score without a positive total and a numeric kill count", () => {
    for (const body of [{}, { total: 0, killed: 0 }, { total: -3, killed: 1 }, { total: "x", killed: 1 }, { total: 10 }, { total: 10, killed: "many" }]) {
      const metric = parse("mutmut-json", body).metrics[0];
      expect(metric.not_applicable, JSON.stringify(body)).toBe(true);
      expect(metric.whole_suite_score, JSON.stringify(body)).toBeUndefined();
    }
  });
});

describe("changed-line mutation score", () => {
  const at = (line, status, file = "a.js") => ({ file, line, status });
  const changed = { "a.js": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] };

  it("counts killed and timed-out mutants as detected, in any letter case", () => {
    const score = calculateChangedMutationScore([at(1, "Killed"), at(2, "KILLED"), at(3, "Timeout"), at(4, "timed_out"), at(5, "Survived")], changed);
    expect(score).toEqual({ detected: 4, valid: 5, actual: 80 });
  });

  it("counts survivors and uncovered mutants as valid but not detected", () => {
    const score = calculateChangedMutationScore([at(1, "Killed"), at(2, "Survived"), at(3, "NoCoverage")], changed);
    expect(score.detected).toBe(1);
    expect(score.valid).toBe(3);
  });

  it.each(["CompileError", "compile_error", "Ignored", "RuntimeError", "runtime_error", "Skipped", "NotViable", "not_viable"])(
    "excludes a %s mutant from the denominator entirely",
    (status) => {
      const score = calculateChangedMutationScore([at(1, "Killed"), at(2, status)], changed);
      expect(score).toEqual({ detected: 1, valid: 1, actual: 100 });
    },
  );

  it("counts a mutant with no status as valid and undetected", () => {
    expect(calculateChangedMutationScore([at(1, "Killed"), at(2, undefined)], changed)).toEqual({ detected: 1, valid: 2, actual: 50 });
  });

  it("returns null, not zero, when no valid mutant is on a changed line", () => {
    expect(calculateChangedMutationScore([at(99, "Survived")], changed)).toBeNull();
    expect(calculateChangedMutationScore([at(1, "CompileError")], changed)).toBeNull();
    expect(calculateChangedMutationScore([], changed)).toBeNull();
    expect(calculateChangedMutationScore(undefined, changed)).toBeNull();
    expect(calculateChangedMutationScore(null, changed)).toBeNull();
    expect(calculateChangedMutationScore([at(1, "Killed")], undefined)).toBeNull();
    expect(calculateChangedMutationScore([at(1, "Killed")], {})).toBeNull();
  });

  it("scores each mutant by its own line, even within one file", () => {
    // The changed-line set is built once per file; a mutant on an unchanged
    // line after one on a changed line must still be left out.
    const score = calculateChangedMutationScore([at(1, "Killed"), at(50, "Survived"), at(2, "Survived")], { "a.js": [1, 2] });
    expect(score).toEqual({ detected: 1, valid: 2, actual: 50 });
  });

  it("ignores mutants in files the change did not touch", () => {
    const score = calculateChangedMutationScore([at(1, "Killed", "a.js"), at(1, "Survived", "other.js")], { "a.js": [1] });
    expect(score).toEqual({ detected: 1, valid: 1, actual: 100 });
  });

  it("does not round the score", () => {
    const score = calculateChangedMutationScore([at(1, "Killed"), at(2, "Survived"), at(3, "Survived")], changed);
    expect(score.actual).toBeCloseTo(100 / 3, 10);
    expect(Number.isInteger(score.actual)).toBe(false);
  });
});

describe("matching a report path to a changed path", () => {
  const score = (mutantFile, changedLines, componentRoot) =>
    calculateChangedMutationScore([{ file: mutantFile, line: 1, status: "Killed" }], changedLines, componentRoot);
  const matches = (...args) => score(...args) !== null;

  it("matches an identical path, ignoring a leading ./ and Windows separators on either side", () => {
    expect(matches("src/a.js", { "src/a.js": [1] })).toBe(true);
    expect(matches("./src/a.js", { "src/a.js": [1] })).toBe(true);
    expect(matches("src\\a.js", { "src/a.js": [1] })).toBe(true);
    expect(matches(".\\src\\a.js", { "src/a.js": [1] })).toBe(true);
  });

  it("prefixes the component root, and prefers that match over the bare path", () => {
    expect(matches("src/a.js", { "pkg/src/a.js": [1] }, "pkg")).toBe(true);
    // Both paths changed: the prefixed one is the file, so only ITS lines count.
    const both = { "pkg/a.js": [7], "a.js": [1] };
    expect(score("a.js", both, "pkg")).toBeNull();
    expect(matches("a.js", { "pkg/a.js": [1], "a.js": [9] }, "pkg")).toBe(true);
  });

  it("falls back to the bare path when the prefixed one was not changed", () => {
    expect(matches("a.js", { "a.js": [1] }, "pkg")).toBe(true);
  });

  it("matches the bare path under the default root, an explicit dot, or an empty root", () => {
    // A `.` or empty root adds no prefix, so the plain report path is what
    // gets compared. (Prefixing a `.` would normalise straight back to the same
    // path, so the two cannot be told apart from outside.)
    expect(matches("a.js", { "a.js": [1] })).toBe(true);
    expect(matches("a.js", { "a.js": [1] }, ".")).toBe(true);
    expect(matches("a.js", { "a.js": [1] }, "")).toBe(true);
  });

  it("matches on a whole trailing path segment in either direction", () => {
    expect(matches("src/a.js", { "a.js": [1] })).toBe(true);
    expect(matches("a.js", { "packages/x/a.js": [1] })).toBe(true);
  });

  it("never matches on a partial file name", () => {
    expect(matches("banana.js", { "nana.js": [1] })).toBe(false);
    expect(matches("nana.js", { "banana.js": [1] })).toBe(false);
    expect(matches("xa.js", { "a.js": [1] })).toBe(false);
  });

  it("treats a suffix that fits two changed files as unmatched rather than guessing", () => {
    expect(matches("a.js", { "x/a.js": [1], "y/a.js": [1] })).toBe(false);
    expect(matches("a.js", { "x/a.js": [1], "y/b.js": [1] })).toBe(true);
  });
});

describe("changed coverage", () => {
  const block = (start, end, statements, count, path = "a.go") => ({ path, start, end, statements, count });

  it("includes a Go block whose range touches a changed line, with both ends inclusive", () => {
    const blocks = [block(10, 12, 3, 1)];
    const total = (line) => calculateChangedCoverage({ blocks }, { "a.go": [line] }).statement?.total ?? 0;
    expect(total(9)).toBe(0);
    expect(total(10)).toBe(3);
    expect(total(11)).toBe(3);
    expect(total(12)).toBe(3);
    expect(total(13)).toBe(0);
  });

  it("counts a block once however many of its lines changed, and covered only when hit", () => {
    const result = calculateChangedCoverage({ blocks: [block(1, 5, 4, 2), block(6, 8, 2, 0)] }, { "a.go": [1, 2, 3, 6] });
    expect(result.statement).toEqual({ covered: 4, total: 6 });
  });

  it("omits the statement key when no block was touched, and ignores blocks in other files", () => {
    expect(calculateChangedCoverage({ blocks: [block(1, 2, 1, 1, "other.go")] }, { "a.go": [1] })).toEqual({});
    expect(calculateChangedCoverage({ blocks: [block(1, 2, 1, 1)] }, { "a.go": [50] })).toEqual({});
    expect(calculateChangedCoverage({ blocks: [] }, { "a.go": [1] })).toEqual({});
  });

  it("scores only the changed executable lines and branches", () => {
    const coverage = {
      files: {
        "a.js": {
          lines: [
            { line: 1, count: 1 },
            { line: 2, count: 0 },
            { line: 3, count: 5 },
          ],
          branches: [
            { line: 1, count: 2 },
            { line: 2, count: 0 },
            { line: 9, count: 1 },
          ],
        },
      },
    };
    const result = calculateChangedCoverage(coverage, { "a.js": [1, 2, 4] });
    expect(result.line).toEqual({ covered: 1, total: 2 });
    expect(result.branch).toEqual({ covered: 1, total: 2 });
  });

  it("ignores records with no usable line number, even when that number appears in the change", () => {
    const coverage = { files: { "a.js": { lines: [{ line: 0, count: 1 }, { line: undefined, count: 1 }], branches: [{ line: 0, count: 1 }, { count: 1 }] } } };
    expect(calculateChangedCoverage(coverage, { "a.js": [0, 1] })).toEqual({});
  });

  it("emits a line or branch key only when something changed", () => {
    const linesOnly = { files: { "a.js": { lines: [{ line: 1, count: 1 }], branches: [] } } };
    expect(calculateChangedCoverage(linesOnly, { "a.js": [1] })).toEqual({ line: { covered: 1, total: 1 } });
    const branchesOnly = { files: { "a.js": { lines: [], branches: [{ line: 1, count: 0 }] } } };
    expect(calculateChangedCoverage(branchesOnly, { "a.js": [1] })).toEqual({ branch: { covered: 0, total: 1 } });
  });

  it("skips a file the change did not touch and tolerates a file with no lists", () => {
    const coverage = { files: { "other.js": { lines: [{ line: 1, count: 1 }] }, "a.js": {} } };
    expect(calculateChangedCoverage(coverage, { "a.js": [1] })).toEqual({});
  });

  it("combines block and per-file evidence when a report carries both", () => {
    const coverage = { blocks: [block(1, 1, 2, 1)], files: { "a.go": { lines: [{ line: 1, count: 1 }], branches: [] } } };
    expect(calculateChangedCoverage(coverage, { "a.go": [1] })).toEqual({ statement: { covered: 2, total: 2 }, line: { covered: 1, total: 1 } });
  });

  it("resolves report paths through the component root", () => {
    const coverage = { files: { "src/a.js": { lines: [{ line: 1, count: 1 }], branches: [] } } };
    expect(calculateChangedCoverage(coverage, { "pkg/src/a.js": [1] }, "pkg").line).toEqual({ covered: 1, total: 1 });
    expect(calculateChangedCoverage(coverage, { "pkg/src/a.js": [1] })).toEqual({ line: { covered: 1, total: 1 } });
  });
});

describe("coveragePercent", () => {
  it("is the unrounded ratio of covered to total, as a percentage", () => {
    expect(coveragePercent({ covered: 1, total: 2 })).toBe(50);
    expect(coveragePercent({ covered: 0, total: 5 })).toBe(0);
    expect(coveragePercent({ covered: 5, total: 5 })).toBe(100);
    expect(coveragePercent({ covered: 1, total: 3 })).toBeCloseTo(33.3333333333, 8);
  });

  it("treats nothing to cover as fully covered rather than dividing by zero", () => {
    expect(coveragePercent({ covered: 0, total: 0 })).toBe(100);
  });
});
