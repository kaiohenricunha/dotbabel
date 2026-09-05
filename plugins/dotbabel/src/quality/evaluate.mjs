import { createHash } from "node:crypto";

import { evaluateMetricAgainstBaseline } from "./baseline.mjs";
import { compareThreshold, selectProfileRules } from "./policy.mjs";

function fingerprint(item) {
  if (item.fingerprint) return item.fingerprint;
  return `sha256:${createHash("sha256").update([item.rule, item.component ?? item.componentId, item.path, item.symbol, item.message].filter(Boolean).join("\0")).digest("hex")}`;
}

function unavailableVerdict(level) { return level === "error" ? "fail" : level === "warning" ? "warn" : "info"; }
function checkedVerdict(rule, pass) { return pass ? "pass" : rule.level === "error" ? "fail" : rule.level === "warning" ? "warn" : "info"; }

/** Evaluate commands, normalized metrics, baselines, and exact exceptions. */
export function evaluateQuality({ policy, profile, executions = [], metrics = [], findings = [], baseline = null, renames = [], now = new Date() } = {}) {
  const selected = selectProfileRules(profile, policy.rules);
  const results = [];
  const covered = new Set();
  for (const execution of executions) {
    for (const ruleId of execution.ruleIds ?? []) {
      const rule = policy.rules[ruleId];
      if (!rule || !rule.profiles.includes(profile) || rule.enabled === false) continue;
      covered.add(ruleId);
      const unavailable = execution.state === "unavailable" || execution.timedOut;
      const notConfigured = execution.state === "not_configured";
      const pass = execution.exitCode === 0 && !(execution.stdoutFailure && execution.stdout.trim());
      results.push({
        rule: ruleId,
        component: execution.componentId,
        class: rule.class,
        state: unavailable ? "unavailable" : notConfigured ? "not_configured" : "checked",
        verdict: unavailable || notConfigured ? unavailableVerdict(rule.on_unavailable) : checkedVerdict(rule, pass),
        message: unavailable ? (execution.timedOut ? "tool timed out" : "tool is unavailable") : notConfigured ? `ambiguous tools: ${(execution.candidates ?? []).join(", ")}` : pass ? "check passed" : execution.stderr.trim() || execution.stdout.trim() || "check failed",
        provenance: rule.provenance,
      });
    }
  }
  const baselineMetrics = new Map((baseline?.metrics ?? []).map((item) => [item.key, item]));
  for (const metric of metrics) {
    const rule = policy.rules[metric.rule];
    if (!rule || !rule.profiles.includes(profile) || rule.enabled === false) continue;
    covered.add(metric.rule);
    const renamedFrom = renames.find((item) => item.to === metric.path)?.from;
    const oldMetric = (metric.key ? baselineMetrics.get(metric.key) : undefined) ?? (baseline?.metrics ?? []).find((item) =>
      item.rule === metric.rule && item.path === renamedFrom && item.symbol === metric.symbol && item.component === metric.component);
    const old = oldMetric?.actual;
    if (metric.rule === "coverage.no_regression" && oldMetric && oldMetric.report_format !== metric.report_format) {
      results.push({ ...metric, class: rule.class, state: "not_applicable", verdict: "info", baseline: old, message: "coverage baseline format is incompatible", provenance: rule.provenance });
      continue;
    }
    if (metric.rule === "coverage.no_regression" && oldMetric?.total > 0 && metric.total > 0) {
      const pass = metric.covered * oldMetric.total >= oldMetric.covered * metric.total;
      results.push({ ...metric, class: rule.class, state: "checked", verdict: checkedVerdict(rule, pass), baseline: old, baseline_covered: oldMetric.covered, baseline_total: oldMetric.total, provenance: rule.provenance });
      continue;
    }
    const ratchet = evaluateMetricAgainstBaseline({ actual: metric.actual, threshold: rule.threshold, baseline: old, direction: rule.direction });
    const pass = old === undefined ? compareThreshold(rule, metric.actual) : ratchet.verdict === "pass";
    results.push({ ...metric, class: rule.class, state: "checked", verdict: checkedVerdict(rule, pass), threshold: rule.threshold, baseline: old, improved: ratchet.improved, provenance: rule.provenance });
  }
  const baselineFindings = new Map((baseline?.findings ?? []).map((item) => [item.fingerprint, item]));
  const currentFingerprints = new Set();
  for (const finding of findings) {
    const rule = policy.rules[finding.rule];
    if (!rule || !rule.profiles.includes(profile) || rule.enabled === false) continue;
    covered.add(finding.rule);
    const findingId = fingerprint(finding);
    currentFingerprints.add(findingId);
    const legacy = baselineFindings.has(findingId);
    results.push({ ...finding, fingerprint: findingId, class: rule.class, state: "checked", verdict: legacy ? "info" : checkedVerdict(rule, false), legacy, provenance: rule.provenance });
  }
  for (const oldFinding of baseline?.findings ?? []) {
    if (currentFingerprints.has(oldFinding.fingerprint) || !covered.has(oldFinding.rule)) continue;
    const rule = policy.rules[oldFinding.rule];
    if (!rule || !rule.profiles.includes(profile) || rule.enabled === false) continue;
    results.push({ ...oldFinding, class: rule.class, state: "checked", verdict: "info", resolved: true, message: "baseline finding resolved", provenance: rule.provenance });
  }
  for (const rule of selected) {
    if (covered.has(rule.id)) continue;
    results.push({ rule: rule.id, class: rule.class, state: rule.class === "semantic" ? "skipped" : "not_configured", verdict: "info", message: rule.class === "semantic" ? "agent review is required" : "no authoritative tool is configured", provenance: rule.provenance });
  }

  const exceptionStates = [];
  for (const exception of policy.exceptions ?? []) {
    const matched = results.find((item) => item.rule === exception.rule && item.fingerprint === exception.fingerprint);
    const expired = new Date(`${exception.expires}T23:59:59Z`) < now;
    if (matched && !expired && matched.verdict === "fail") {
      matched.verdict = "warn";
      matched.exception = exception.id;
      exceptionStates.push({ id: exception.id, state: "active" });
    } else exceptionStates.push({ id: exception.id, state: expired ? "expired" : "unused" });
  }
  results.sort((a, b) => `${a.component ?? ""}:${a.class}:${a.rule}`.localeCompare(`${b.component ?? ""}:${b.class}:${b.rule}`));
  return {
    results,
    exceptions: exceptionStates,
    verdict: results.some((item) => item.verdict === "fail") ? "fail" : results.some((item) => item.verdict === "warn") ? "warn" : "pass",
    environment_error: results.some((item) => ["unavailable", "not_configured"].includes(item.state) && item.verdict === "fail"),
  };
}
