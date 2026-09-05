import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";

function invalid(message) { throw new ValidationError({ code: ERROR_CODES.QUALITY_REPORT_INVALID, category: "quality", message }); }
function json(text) { try { return JSON.parse(text); } catch (error) { invalid(`quality report is not valid JSON: ${error.message}`); } }
function percent(covered, total) { return total === 0 ? 100 : (covered / total) * 100; }

function analyzerRule(name = "") {
  if (name === "gocognit") return "complexity.cognitive";
  if (name === "gocyclo" || name === "cyclop") return "complexity.cyclomatic";
  if (name === "errcheck") return "semantic.ignored_errors";
  if (name === "unused") return "maintainability.dead_code";
  if (name.includes("no-explicit-any") || name === "ANN401") return "semantic.dynamic_types";
  if (name.includes("no-unsafe-") || name.includes("type-assertion") || name.includes("non-null-assert")) return "semantic.unchecked_assertions";
  if (["E722", "BLE001"].includes(name)) return "semantic.swallowed_errors";
  return "correctness.lint";
}

function sarifFindings(body) {
  const findings = [];
  for (const run of body.runs ?? []) {
    const rules = new Map((run.tool?.driver?.rules ?? []).map((rule) => [rule.id, rule]));
    for (const item of run.results ?? []) {
      const score = Number(item.properties?.["security-severity"] ?? rules.get(item.ruleId)?.properties?.["security-severity"]);
      const reliableSecurity = Number.isFinite(score) ? score >= 7 : ["critical", "high"].includes(String(item.level).toLowerCase());
      const location = item.locations?.[0]?.physicalLocation;
      findings.push({
        rule: reliableSecurity ? "security.high_confidence" : "correctness.lint",
        message: item.message?.text ?? "tool finding",
        severity: reliableSecurity ? (score >= 9 ? "critical" : "high") : item.level ?? "warning",
        path: location?.artifactLocation?.uri,
        line: location?.region?.startLine,
        fingerprint: item.partialFingerprints?.primaryLocationLineHash,
      });
    }
  }
  return findings;
}

function lintFindings(format, body) {
  if (format === "sarif") return sarifFindings(body);
  let raw;
  if (format === "golangci-json") raw = body.Issues ?? [];
  else if (format === "eslint-json") raw = (Array.isArray(body) ? body : []).flatMap((file) => (file.messages ?? []).map((item) => ({ ...item, filePath: file.filePath })));
  else raw = Array.isArray(body) ? body : [];
  return raw.map((item) => {
    const name = item.FromLinter ?? item.ruleId ?? item.code ?? "";
    return {
      rule: analyzerRule(name),
      message: item.Text ?? item.message ?? "tool finding",
      severity: item.severity === 2 ? "error" : item.severity === 1 ? "warning" : item.severity ?? "warning",
      path: item.Pos?.Filename ?? item.filePath ?? item.filename,
      line: item.Pos?.Line ?? item.line ?? item.location?.row,
      fingerprint: item.fingerprint,
    };
  });
}

/** Parse one supported tool report into normalized metrics and findings. */
export function parseQualityReport({ format, text }) {
  if (format === "exit-code") return { metrics: [], findings: [] };
  if (format === "dotbabel-v1") {
    const body = json(text);
    if (body.schema_version !== 1) invalid("dotbabel-v1 report schema_version must be 1");
    if (!Array.isArray(body.metrics) || !Array.isArray(body.findings)) invalid("dotbabel-v1 report requires metrics and findings arrays");
    return { metrics: body.metrics, findings: body.findings };
  }
  if (format === "go-coverprofile") {
    let covered = 0; let total = 0; const blocks = [];
    for (const line of text.split("\n").slice(1).filter(Boolean)) {
      const match = /^(.+):(\d+)\.\d+,(\d+)\.\d+\s+(\d+)\s+(\d+)$/.exec(line);
      if (!match) continue;
      const statements = Number(match[4]); total += statements; if (Number(match[5]) > 0) covered += statements;
      blocks.push({ path: match[1], start: Number(match[2]), end: Number(match[3]), statements, count: Number(match[5]) });
    }
    return { metrics: [], findings: [], coverage: { statement: { covered, total }, blocks } };
  }
  if (format === "lcov") {
    const values = { LF: 0, LH: 0, BRF: 0, BRH: 0 }; const files = {}; let current;
    for (const line of text.split("\n")) {
      if (line.startsWith("SF:")) { current = line.slice(3).replaceAll("\\", "/"); files[current] = { lines: [], branches: [] }; continue; }
      const count = /^(LF|LH|BRF|BRH):(\d+)$/.exec(line); if (count) { values[count[1]] += Number(count[2]); continue; }
      const detail = /^DA:(\d+),(\d+)/.exec(line); if (current && detail) { files[current].lines.push({ line: Number(detail[1]), count: Number(detail[2]) }); continue; }
      const branch = /^BRDA:(\d+),[^,]*,[^,]*,([^,]+)/.exec(line); if (current && branch) files[current].branches.push({ line: Number(branch[1]), count: branch[2] === "-" ? 0 : Number(branch[2]) });
    }
    if (values.LF === 0) for (const file of Object.values(files)) { values.LF += file.lines.length; values.LH += file.lines.filter((item) => item.count > 0).length; }
    if (values.BRF === 0) for (const file of Object.values(files)) { values.BRF += file.branches.length; values.BRH += file.branches.filter((item) => item.count > 0).length; }
    const coverage = { line: { covered: values.LH, total: values.LF }, files };
    if (values.BRF > 0) coverage.branch = { covered: values.BRH, total: values.BRF };
    return { metrics: [], findings: [], coverage };
  }
  if (format === "coveragepy-json") {
    const body = json(text); const totals = body.totals ?? {};
    const files = Object.fromEntries(Object.entries(body.files ?? {}).map(([name, file]) => [name.replaceAll("\\", "/"), {
      lines: [...(file.executed_lines ?? []).map((line) => ({ line, count: 1 })), ...(file.missing_lines ?? []).map((line) => ({ line, count: 0 }))],
      branches: [...(file.executed_branches ?? []).map(([line]) => ({ line, count: 1 })), ...(file.missing_branches ?? []).map(([line]) => ({ line, count: 0 }))],
    }]));
    const coverage = { line: { covered: totals.covered_lines ?? 0, total: totals.num_statements ?? 0 }, files };
    if (totals.num_branches !== undefined) coverage.branch = { covered: totals.covered_branches ?? 0, total: totals.num_branches };
    return { metrics: [], findings: [], coverage };
  }
  if (format === "istanbul-json") {
    const body = json(text); let lineTotal = 0; let lineCovered = 0; let branchTotal = 0; let branchCovered = 0; const files = {};
    for (const [name, file] of Object.entries(body)) {
      files[name.replaceAll("\\", "/")] = { lines: [], branches: [] };
      for (const [id, count] of Object.entries(file.s ?? {})) { lineTotal++; if (count > 0) lineCovered++; files[name.replaceAll("\\", "/")].lines.push({ line: file.statementMap?.[id]?.start?.line, count }); }
      for (const [id, counts] of Object.entries(file.b ?? {})) for (const [index, count] of counts.entries()) { branchTotal++; if (count > 0) branchCovered++; files[name.replaceAll("\\", "/")].branches.push({ line: file.branchMap?.[id]?.locations?.[index]?.start?.line ?? file.branchMap?.[id]?.line, count }); }
    }
    return { metrics: [], findings: [], coverage: { line: { covered: lineCovered, total: lineTotal }, branch: { covered: branchCovered, total: branchTotal }, files } };
  }
  if (format === "jscpd-json") {
    const body = json(text); const actual = body.statistics?.total?.percentage ?? body.total?.percentage;
    return { metrics: actual === undefined ? [] : [{ rule: "duplication.percent", actual }], findings: [] };
  }
  if (format === "stryker-json") {
    const body = json(text); const killed = body.thresholds ? undefined : body.mutationScore;
    const actual = killed ?? body.metrics?.mutationScore;
    return { metrics: actual === undefined ? [] : [{ rule: "mutation.changed_score", actual }], findings: [] };
  }
  if (["sarif", "golangci-json", "eslint-json", "ruff-json"].includes(format)) {
    const body = json(text);
    return { metrics: [], findings: lintFindings(format, body) };
  }
  invalid(`unsupported quality report format: ${format}`);
}

/** Return an unrounded coverage percentage from integer counts. */
export function coveragePercent(counts) { return percent(counts.covered, counts.total); }

function normalize(name) { return name.replaceAll("\\", "/").replace(/^\.\//, ""); }
function matchChangedPath(reportPath, changedPaths, componentRoot) {
  const report = normalize(reportPath);
  const prefixed = componentRoot && componentRoot !== "." ? normalize(`${componentRoot}/${report}`) : report;
  if (changedPaths.includes(prefixed)) return prefixed;
  if (changedPaths.includes(report)) return report;
  const suffixes = changedPaths.filter((name) => report.endsWith(`/${name}`) || name.endsWith(`/${report}`));
  return suffixes.length === 1 ? suffixes[0] : undefined;
}

/** Calculate exact covered and total counts for changed executable lines. */
export function calculateChangedCoverage(coverage, changedLines, componentRoot = ".") {
  const changedPaths = Object.keys(changedLines);
  const result = {};
  if (coverage.blocks) {
    let covered = 0; let total = 0;
    for (const block of coverage.blocks) {
      const file = matchChangedPath(block.path, changedPaths, componentRoot);
      if (!file || !(changedLines[file] ?? []).some((line) => line >= block.start && line <= block.end)) continue;
      total += block.statements; if (block.count > 0) covered += block.statements;
    }
    if (total > 0) result.statement = { covered, total };
  }
  if (coverage.files) {
    let coveredLines = 0; let totalLines = 0; let coveredBranches = 0; let totalBranches = 0;
    for (const [reportPath, fileCoverage] of Object.entries(coverage.files)) {
      const file = matchChangedPath(reportPath, changedPaths, componentRoot);
      if (!file) continue;
      const changed = new Set(changedLines[file]);
      for (const item of fileCoverage.lines ?? []) if (item.line && changed.has(item.line)) { totalLines++; if (item.count > 0) coveredLines++; }
      for (const item of fileCoverage.branches ?? []) if (item.line && changed.has(item.line)) { totalBranches++; if (item.count > 0) coveredBranches++; }
    }
    if (totalLines > 0) result.line = { covered: coveredLines, total: totalLines };
    if (totalBranches > 0) result.branch = { covered: coveredBranches, total: totalBranches };
  }
  return result;
}
