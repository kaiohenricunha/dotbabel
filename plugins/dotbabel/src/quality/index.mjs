import fs from "node:fs";
import path from "node:path";

import { resolveQualityPolicy } from "./config.mjs";
import { resolveQualityScope } from "./scope.mjs";
import { detectQualityCapabilities, filesMatchingQualityPaths, planQualityCheck, qualityChangePaths } from "./discovery.mjs";
import { runQualityPlans } from "./runner.mjs";
import { calculateChangedCoverage, calculateChangedMutationScore, parseQualityReport, coveragePercent } from "./reports.mjs";
import { evaluateQuality } from "./evaluate.mjs";
import { loadQualityBaseline, loadQualityBaselineAtRevision } from "./baseline.mjs";
import { qualityEnvelope } from "./reporters.mjs";
import { capabilityRules } from "./adapters/shared.mjs";
import { matchesPathScope } from "./paths.mjs";

function inside(root, candidate) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseExecutionReports(repoRoot, executions, scope) {
  const metrics = [];
  const findings = [];
  for (const execution of executions) {
    const capabilities = execution.capabilities ?? [execution.capability];
    if (execution.exitCode !== 0) {
      if (capabilities.includes("coverage")) {
        execution.state = "unavailable";
        execution.stderr = execution.stderr || "coverage command exited non-zero";
        const reportRules = capabilities.flatMap((capability) => capability === "coverage"
          ? ["coverage.no_regression", "coverage.changed_lines", "coverage.changed_branches"]
          : capabilityRules(capability));
        execution.ruleIds = [...new Set([...(execution.ruleIds ?? []), ...reportRules])];
      }
      continue;
    }
    for (const report of execution.reports ?? (execution.report ? [execution.report] : [])) {
      if (report.format === "exit-code") continue;
      const componentRoot = execution.componentId.slice(0, execution.componentId.lastIndexOf(":"));
      const reportPath = path.resolve(repoRoot, componentRoot, report.path);
      if (!fs.existsSync(reportPath) || !fs.statSync(reportPath).isFile() || !inside(repoRoot, reportPath)) {
        execution.state = "unavailable";
        execution.stderr = "configured report is missing or escapes the repository";
        const reportRules = capabilities.flatMap((capability) => capability === "coverage"
          ? ["coverage.no_regression", "coverage.changed_lines", "coverage.changed_branches"]
          : capabilityRules(capability));
        execution.ruleIds = [...new Set([...(execution.ruleIds ?? []), ...reportRules])];
        continue;
      }
      const parsed = parseQualityReport({ format: report.format, text: fs.readFileSync(reportPath, "utf8") });
      metrics.push(...parsed.metrics.map((item) => ({ ...item, component: execution.componentId })));
      findings.push(...parsed.findings.map((item) => ({ ...item, component: execution.componentId })));
      if (parsed.mutants) {
        // Mutation scoring mirrors coverage: the parser stays pure and this is
        // where the diff is applied. `null` means no valid mutant starts on a
        // changed line, which REL-11 reports as not_applicable rather than 0 —
        // a change with nothing to mutate has not failed a mutation budget.
        const mutation = calculateChangedMutationScore(parsed.mutants, scope.changedLines, componentRoot);
        metrics.push(mutation === null
          ? { rule: "mutation.changed_score", component: execution.componentId, not_applicable: true, evidence: "no mutant starts on a changed line", key: `${execution.componentId}:mutation-changed-score`, report_format: report.format }
          : { rule: "mutation.changed_score", component: execution.componentId, actual: mutation.actual, detected: mutation.detected, valid: mutation.valid, key: `${execution.componentId}:mutation-changed-score`, report_format: report.format });
      }
      const changed = calculateChangedCoverage(parsed.coverage ?? {}, scope.changedLines, componentRoot);
      const totalCoverage = parsed.coverage?.statement ?? parsed.coverage?.line;
      if (totalCoverage) metrics.push({ rule: "coverage.no_regression", component: execution.componentId, actual: coveragePercent(totalCoverage), covered: totalCoverage.covered, total: totalCoverage.total, key: `${execution.componentId}:repository-coverage`, report_format: report.format });
      if (changed.statement) metrics.push({ rule: "coverage.changed_lines", component: execution.componentId, actual: coveragePercent(changed.statement), covered: changed.statement.covered, total: changed.statement.total, key: `${execution.componentId}:statement-coverage`, evidence: "Go cover profiles contain approximate statement blocks, not branch coverage" });
      if (changed.line) metrics.push({ rule: "coverage.changed_lines", component: execution.componentId, actual: coveragePercent(changed.line), covered: changed.line.covered, total: changed.line.total, key: `${execution.componentId}:line-coverage` });
      if (changed.branch) metrics.push({ rule: "coverage.changed_branches", component: execution.componentId, actual: coveragePercent(changed.branch), covered: changed.branch.covered, total: changed.branch.total, key: `${execution.componentId}:branch-coverage` });
    }
  }
  return { metrics, findings };
}

function sourceFindings(repoRoot, scope, includedFiles) {
  const metrics = [];
  const findings = [];
  const suppressions = /(?:nolint|noqa|eslint-disable|@ts-ignore|istanbul ignore|pragma:\s*no cover)/i;
  for (const changed of scope.changedFiles) {
    if (changed.status === "deleted") continue;
    if (!includedFiles.includes(changed.path)) continue;
    const absolute = path.join(repoRoot, changed.path);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const lines = fs.readFileSync(absolute, "utf8").split("\n");
    metrics.push({ rule: "size.file_loc", path: changed.path, actual: Math.max(0, lines.length - 1), key: `${changed.path}:file-loc` });
    for (const line of scope.changedLines[changed.path] ?? []) if (suppressions.test(lines[line - 1] ?? "")) findings.push({ rule: "policy.new_suppression", path: changed.path, line, message: "a changed suppression directive requires review" });
  }
  return { metrics, findings };
}

function narrowScope(scope, paths) {
  if (paths.length === 0) return { ...scope, paths };
  const changedFiles = scope.changedFiles.filter((file) => matchesPathScope(paths, file.path));
  const changedLines = Object.fromEntries(Object.entries(scope.changedLines).filter(([file]) => matchesPathScope(paths, file)));
  const renames = scope.renames.filter((item) => matchesPathScope(paths, item.to) || matchesPathScope(paths, item.from));
  return { ...scope, changedFiles, changedLines, renames, paths };
}

/** Run the complete quality check data flow. */
export async function runQualityCheck(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const policy = options.policy ?? resolveQualityPolicy({ repoRoot, env: options.env, profile: options.profile, base: options.base, head: options.head, jobs: options.jobs });
  const profile = options.profile ?? policy.default_profile;
  if (!policy.enabled) return qualityEnvelope("check", { state: "disabled", profile, verdict: "pass", results: [] });
  const paths = options.paths ?? [];
  const all = Boolean(options.all);
  const fullScope = resolveQualityScope({ repoRoot, base: options.base, head: options.head, env: options.env, configuredBase: policy.base_ref, all });
  const criticalMatches = filesMatchingQualityPaths(qualityChangePaths(fullScope.changedFiles), policy.critical_paths ?? []);
  const scope = narrowScope(fullScope, paths);
  const detection = detectQualityCapabilities({ repoRoot, policy, paths });
  const planned = planQualityCheck({ repoRoot, policy, changeSet: { ...scope, criticalMatches }, profile, detection, paths });
  const executions = await runQualityPlans({ repoRoot, plans: planned.plans, allowProjectCommands: options.allowProjectCommands, passEnv: options.passEnv, env: options.env, jobs: options.jobs ?? policy.jobs ?? 2, timeoutSeconds: profile === "deep" ? 1800 : profile === "pr" ? 900 : 120 });
  const parsed = parseExecutionReports(repoRoot, executions, scope);
  const native = sourceFindings(repoRoot, scope, detection.files);
  // Whole-repository mode reads no diff, so there is no merge base to read a
  // committed baseline from; fall back to the working-tree baseline.
  const baseline = ["pr", "deep"].includes(profile) && scope.mergeBase
    ? loadQualityBaselineAtRevision({ repoRoot, baselineFile: policy.baseline_file, revision: scope.mergeBase })
    : loadQualityBaseline({ repoRoot, baselineFile: policy.baseline_file });
  const evaluation = evaluateQuality({ policy, profile, executions, metrics: [...parsed.metrics, ...native.metrics], findings: [...parsed.findings, ...native.findings], baseline, renames: scope.renames, criticalMatches });
  return qualityEnvelope("check", { state: "checked", profile, policy_hash: policy.policy_hash, scope, path_scope: paths, all_files: all, critical_matches: criticalMatches, components: planned.components, exclusions: detection.exclusions, executions, ...evaluation });
}

export { resolveQualityPolicy } from "./config.mjs";
export { detectQualityCapabilities, planQualityCheck } from "./discovery.mjs";
export { loadQualityBaseline } from "./baseline.mjs";
