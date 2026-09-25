/**
 * Tests for skills/security-audit/scripts/findings-to-sarif.mjs — converts the
 * confirmed records of a finished security-audit run into SARIF 2.1.0 that
 * `dotbabel quality` ingests through parseQualityReport({ format: "sarif" }).
 *
 * Fixtures follow the shape of the upstream builders in
 * skills/security-audit/references/upstream/validate-findings.test.cjs, so the
 * upstream validator accepts them.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { parseQualityReport } from "../src/quality/reports.mjs";
import { validateQualityConfig } from "../src/quality/config.mjs";
import { findingsToSarif } from "../../../skills/security-audit/scripts/findings-to-sarif.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CONVERTER = join(REPO_ROOT, "skills", "security-audit", "scripts", "findings-to-sarif.mjs");

const traceStep = (kind, file, line) => ({
  kind,
  file,
  line,
  scope: "handle",
  description: "Attacker data reaches the operation.",
});

function confirmed(fingerprint, severity, sinkFile = "src/store.c", sinkLine = 30) {
  return {
    verdict: "confirmed",
    fingerprint,
    title: `Finding ${fingerprint}`,
    description: "An attacker can reach an operation without the intended ownership check.",
    root_cause: "handle omits the ownership check before changing the object.",
    intended_behavior: "Only the object's owner can change it.",
    trace: [
      traceStep("entrypoint", "src/handler.c", 10),
      traceStep("propagation", "src/model.c", 20),
      traceStep("sink", sinkFile, sinkLine),
    ],
    evidence: [
      {
        file: "src/handler.c",
        line: 10,
        description: "The source performs the operation without the required check.",
      },
    ],
    conditions: [],
    execution: {
      attacker_perspective: "An unprivileged remote user with their own account.",
      payloads: ["An object identifier owned by another user."],
      instructions: ["Submit the identifier through the public operation."],
      observed_result: "The other user's object changes.",
    },
    remediation: { strategy: "Check ownership before the state change." },
    severity: {
      likelihood: { score: severity, reason: "The operation is directly reachable." },
      impact: { score: severity, reason: "The attacker changes one protected object." },
      overall_severity: severity,
    },
    confidence: { score: "high", reason: "The source path and result were reproduced." },
  };
}

const needsValidation = {
  verdict: "needs_validation",
  fingerprint: "c-needs-validation",
  title: "Unchecked parsed size",
  description: "A parsed size may reach an allocation without a limit.",
  claimed_root_cause: "parse_size may pass an unbounded value to allocate.",
  trace: [traceStep("entrypoint", "src/parser.c", 5)],
  evidence: [{ file: "src/parser.c", line: 5, description: "The size is read without a bound." }],
  blockers: ["The generated parser source is absent from this checkout."],
  validation_plan: {
    local: "Generate the parser and submit the smallest input that exceeds the documented limit.",
  },
};

const rejected = {
  verdict: "rejected",
  fingerprint: "d-rejected",
  title: "Authorization bypass in router",
  description: "The candidate claimed a route bypassed authorization.",
  claimed_root_cause: "dispatch was claimed to skip the authorization wrapper.",
  trace: [traceStep("sink", "src/router.c", 7)],
  evidence: [{ file: "src/router.c", line: 7, description: "The wrapper runs first." }],
  reason: "All routes pass through the authorization wrapper before dispatch.",
};

const FULL_RUN = [
  confirmed("a-critical", "critical"),
  confirmed("b-medium", "medium", "src/other.c", 44),
  needsValidation,
  rejected,
];

/** Build a run dir; pass `null` for findings or metadata to leave that file out. */
function mkRun({
  findings = FULL_RUN,
  metadata = { run_id: "run-1", run_status: "complete" },
} = {}) {
  const dir = makeTempDir("sarif-run-");
  if (findings !== null)
    writeFileSync(join(dir, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
  if (metadata !== null)
    writeFileSync(join(dir, "run-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return dir;
}

function convert(runDir, ...extra) {
  const outFile = join(makeTempDir("sarif-out-"), "nested", "audit.sarif");
  const result = spawnSync(
    process.execPath,
    [CONVERTER, "--run-dir", runDir, "--out", outFile, ...extra],
    { encoding: "utf8" },
  );
  return { result, outFile };
}

describe("findings-to-sarif CLI", () => {
  it("writes SARIF 2.1.0 with one result per confirmed record", () => {
    const { result, outFile } = convert(mkRun());
    expect(result.status, result.stderr).toBe(0);

    const sarif = JSON.parse(readFileSync(outFile, "utf8"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe("security-audit");
    const results = sarif.runs[0].results;
    expect(results.map((r) => r.partialFingerprints.primaryLocationLineHash)).toEqual([
      "a-critical",
      "b-medium",
    ]);

    const [critical, medium] = results;
    expect(critical.ruleId).toBe("security-audit/confirmed");
    expect(critical.level).toBe("error");
    expect(critical.properties["security-severity"]).toBe("9.5");
    expect(critical.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "src/store.c" },
      region: { startLine: 30 },
    });
    // two non-sink trace steps + one evidence entry
    expect(critical.relatedLocations).toHaveLength(3);
    expect(critical.message.text).toContain("Finding a-critical");
    expect(medium.level).toBe("warning");
    expect(medium.properties["security-severity"]).toBe("5.5");
  });

  it("feeds dotbabel quality: critical becomes security.high_confidence, medium stays correctness.lint", () => {
    const { result, outFile } = convert(mkRun());
    expect(result.status, result.stderr).toBe(0);

    const { findings } = parseQualityReport({
      format: "sarif",
      text: readFileSync(outFile, "utf8"),
    });
    expect(findings.map((f) => [f.rule, f.severity, f.path, f.line, f.fingerprint])).toEqual([
      ["security.high_confidence", "critical", "src/store.c", 30, "a-critical"],
      ["correctness.lint", "warning", "src/other.c", 44, "b-medium"],
    ]);
  });

  it("writes an empty result list for an empty findings.json", () => {
    const { result, outFile } = convert(mkRun({ findings: [] }));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outFile, "utf8")).runs[0].results).toEqual([]);
  });

  it("refuses a findings.json that the upstream validator rejects (exit 2)", () => {
    const broken = [{ verdict: "confirmed", fingerprint: "x" }];
    const { result, outFile } = convert(mkRun({ findings: broken }));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/validate-findings/);
    expect(existsSync(outFile)).toBe(false);
  });

  it("refuses an incomplete run so it never reads as a pass (exit 2)", () => {
    const metadata = {
      run_id: "run-1",
      run_status: "incomplete",
      incomplete_reason: "validation_budget_exhausted",
    };
    const { result, outFile } = convert(mkRun({ metadata }));
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/validation_budget_exhausted/);
    expect(existsSync(outFile)).toBe(false);
  });

  it.each([
    ["run-metadata.json", { metadata: null }],
    ["findings.json", { findings: null }],
  ])("exits 2 when %s is missing", (name, options) => {
    const { result } = convert(mkRun(options));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(name);
  });

  it.each([[["--run-dir", "x"]], [["--out", "x"]], [["--bogus"]], [[]]])(
    "exits 64 for %j",
    (args) => {
      const result = spawnSync(process.execPath, [CONVERTER, ...args], { encoding: "utf8" });
      expect(result.status).toBe(64);
    },
  );

  it("still runs through a bootstrap-style symlink instead of a silent exit 0", () => {
    const shim = join(makeTempDir("sarif-shim-"), "findings-to-sarif.mjs");
    symlinkSync(CONVERTER, shim);
    const result = spawnSync(process.execPath, [shim], { encoding: "utf8" });
    expect(result.status).toBe(64);
  });
});

describe("findingsToSarif", () => {
  it.each([
    ["critical", "9.5", "error"],
    ["high", "8.0", "error"],
    ["medium", "5.5", "warning"],
    ["low", "3.0", "note"],
    ["informational", "0.0", "note"],
  ])("maps %s to security-severity %s and level %s", (severity, score, level) => {
    const [result] = findingsToSarif([confirmed("a", severity)]).runs[0].results;
    expect(result.properties["security-severity"]).toBe(score);
    expect(result.level).toBe(level);
  });

  it("uses the last trace step when no step is a sink", () => {
    const record = confirmed("a", "high");
    record.trace = [traceStep("entrypoint", "src/a.c", 1), traceStep("propagation", "src/b.c", 2)];
    const [result] = findingsToSarif([record]).runs[0].results;
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe("src/b.c");
  });
});

describe("SKILL.md quality example", () => {
  it("is a valid .dotbabel.json quality config that runs this converter", () => {
    const skill = readFileSync(join(REPO_ROOT, "skills", "security-audit", "SKILL.md"), "utf8");
    // Pick the block by content, not by position: SKILL.md carries more than
    // one JSON example (the promoter manifest is another one).
    const blocks = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    const block = blocks.find((body) => body.includes('"quality"'));
    expect(block, "SKILL.md must keep its .dotbabel.json example").toBeDefined();

    const { quality } = JSON.parse(block);
    expect(() => validateQualityConfig(quality)).not.toThrow();
    const tool = quality.components[0].tools.security;
    expect(tool.argv[1]).toBe(".claude/skills/security-audit/scripts/findings-to-sarif.mjs");
    expect(tool.report).toEqual({
      format: "sarif",
      path: tool.argv[tool.argv.indexOf("--out") + 1],
    });
  });
});
