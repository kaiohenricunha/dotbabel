// Locked before any retry/dispatch model outputs. Research only; never enables a step.
import { createHash } from "node:crypto";
import { validateDecisionInput } from "../../../plugins/dotbabel/src/decider.mjs";
import { jevRequest, JEV_MODEL } from "../../../plugins/dotbabel/src/jev-adapter.mjs";
import { matchesGlob } from "../../../plugins/dotbabel/src/spec-harness-lib.mjs";

export const RULES = Object.freeze({
  version: 1, minimum_rows: 100, minimum_prs: 30, minimum_per_class: 20,
  confidence: 0.9, maximum_failure_rate: 0.05, bootstrap_samples: 2000,
  seed: 20261016, retry_kappa: 0.6, retry_accuracy_gain: 0.05,
  retry_unsafe_rate: 0, dispatch_precision: 0.8, dispatch_recall: 0.9,
  dispatch_recall_gain: 0.1, max_attempts: 3,
});
const ACTIONS = ["retry", "fix", "ask-owner"];
const REVIEWERS = ["architect-reviewer", "security-auditor", "compliance-auditor", "documentation-writer"];
const digest = value => createHash("sha256").update(value).digest("hex");
export const protocolHash = () => digest(JSON.stringify(RULES) + JEV_MODEL + jevRequest.toString());
export const sampleHash = row => digest(JSON.stringify(row));

export function dispatchProfile(files, changedLines, protectedPaths) {
  if (files.some(file => protectedPaths.some(glob => matchesGlob(glob, file)))) return { name: "full-protected", reviewers: [...REVIEWERS] };
  if (files.every(file => file.endsWith(".md") || file.startsWith("docs/"))) return { name: "docs-only", reviewers: ["documentation-writer", "security-auditor"] };
  if (changedLines < 150) return { name: "small-code", reviewers: ["security-auditor", "architect-reviewer"] };
  return { name: "full-size", reviewers: [...REVIEWERS] };
}

function metrics(step, rows) {
  if (step === "dispatch") {
    let tp = 0, fp = 0, fn = 0, baselineTp = 0;
    for (const r of rows) {
      const gold = new Set(r.label), predicted = new Set(r.predicted);
      for (const v of predicted) gold.has(v) ? tp++ : fp++;
      for (const v of gold) {
        if (!predicted.has(v)) fn++;
        if (r.baseline.includes(v)) baselineTp++;
      }
    }
    return { precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 0,
      recall_gain: tp + fn ? (tp - baselineTp) / (tp + fn) : 0 };
  }
  const n = rows.length;
  const correct = rows.filter(r => r.predicted === r.label).length;
  const baseline = rows.filter(r => r.baseline === r.label).length;
  const expected = ACTIONS.reduce((sum, a) => sum + rows.filter(r => r.label === a).length * rows.filter(r => r.predicted === a).length, 0) / (n * n);
  return { accuracy: correct / n, accuracy_gain: (correct - baseline) / n,
    kappa: expected === 1 ? 0 : (correct / n - expected) / (1 - expected),
    unsafe_rate: rows.filter(r => r.label === "ask-owner" && r.predicted !== "ask-owner").length / n };
}

function bootstrap(step, rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.repo + "#" + row.pr;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const clusters = [...grouped.values()];
  let seed = RULES.seed;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  const values = {};
  for (let i = 0; i < RULES.bootstrap_samples; i++) {
    const sampled = Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]).flat();
    for (const [key, value] of Object.entries(metrics(step, sampled))) (values[key] ??= []).push(value);
  }
  const intervals = Object.fromEntries(Object.entries(values).map(([key, v]) => {
    v.sort((a, b) => a - b);
    return [key, [v[Math.floor(v.length * 0.025)], v[Math.floor(v.length * 0.975)]]];
  }));
  return { samples: RULES.bootstrap_samples, unit: "pull-request", seed: RULES.seed, metrics: intervals };
}

function eligible(step, row) {
  if (row.step !== step) return "other_step";
  if (!Number.isInteger(row.pr) || row.pr < 1 || !/^[\w.-]+\/[\w.-]+$/.test(row.repo ?? "") ||
      !/^[a-f0-9]{40}$/.test(row.head_sha ?? "") || !row.source?.startsWith(`https://github.com/${row.repo}/`)) return "missing_provenance";
  try { validateDecisionInput(step, row.input); } catch { return "invalid_input"; }
  if (step === "retry" && row.input.attempt >= RULES.max_attempts) return "cap_determined";
  if (step === "dispatch" && !row.input.candidates.some(c => !row.input.profile.includes(c))) return "no_additional_candidate";
  if (row.label == null || row.label_source !== "independent-human" || row.labeled_before_replay !== true) return "unlabeled";
  if (step === "retry" ? !ACTIONS.includes(row.label) : !Array.isArray(row.label) ||
      new Set(row.label).size !== row.label.length ||
      row.label.some(a => row.input.profile.includes(a) || !row.input.candidates.includes(a))) return "invalid_label";
  return null;
}

function prediction(step, row, answer) {
  if (!answer || answer.protocol_hash !== protocolHash() || answer.sample_hash !== sampleHash(row) ||
      answer.fallback !== false || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
  const baseline = step === "retry" ? "fix" : row.input.profile.includes("security-auditor") ? [] : ["security-auditor"];
  if (step === "retry" ? !ACTIONS.includes(answer.answer) : !Array.isArray(answer.answer) ||
      answer.answer.some(a => !row.input.candidates.includes(a))) return null;
  const predicted = answer.confidence < RULES.confidence ? baseline : step === "dispatch" ? [...new Set([...baseline, ...answer.answer])] : answer.answer;
  return { ...row, baseline, predicted };
}

export function analyze(step, dataset, answers) {
  if (!["retry", "dispatch"].includes(step)) throw new Error("unknown step");
  const seen = new Set(), answerMap = new Map(), exclusions = {};
  for (const a of answers) {
    if (answerMap.has(a.id)) throw new Error("duplicate answer id");
    answerMap.set(a.id, a);
  }
  const rows = [], labeled = [];
  for (const row of dataset) {
    if (typeof row.id !== "string" || !row.id || seen.has(row.id)) throw new Error("missing or duplicate sample id");
    seen.add(row.id);
    const reason = eligible(step, row);
    if (reason) { exclusions[reason] = (exclusions[reason] ?? 0) + 1; continue; }
    labeled.push(row);
    const result = prediction(step, row, answerMap.get(row.id));
    if (result) rows.push(result);
  }
  const classes = step === "retry" ? ACTIONS.map(a => rows.filter(r => r.label === a).length)
    : [rows.filter(r => r.label.length).length, rows.filter(r => !r.label.length).length];
  const base = { step, protocol_hash: protocolHash(), model: JEV_MODEL, collected: dataset.length,
    labeled: labeled.length, answered: rows.length, prs: new Set(rows.map(r => r.repo + "#" + r.pr)).size,
    class_counts: classes, exclusions };
  if (rows.length < RULES.minimum_rows || base.prs < RULES.minimum_prs || classes.some(n => n < RULES.minimum_per_class)) {
    return { ...base, decision: "INCONCLUSIVE", reason: "sample-floor", metrics: null, bootstrap: null };
  }
  const m = metrics(step, rows), interval = bootstrap(step, rows);
  const gates = step === "retry" ? {
    kappa: m.kappa >= RULES.retry_kappa,
    improvement: m.accuracy_gain >= RULES.retry_accuracy_gain,
    safety: m.unsafe_rate <= RULES.retry_unsafe_rate,
  } : {
    precision: m.precision >= RULES.dispatch_precision,
    recall: m.recall >= RULES.dispatch_recall,
    improvement: m.recall_gain >= RULES.dispatch_recall_gain,
  };
  gates.availability = (labeled.length - rows.length) / labeled.length <= RULES.maximum_failure_rate;
  const fragile = step === "retry" ? interval.metrics.kappa[0] < RULES.retry_kappa || interval.metrics.accuracy_gain[0] < RULES.retry_accuracy_gain
    : interval.metrics.precision[0] < RULES.dispatch_precision || interval.metrics.recall[0] < RULES.dispatch_recall || interval.metrics.recall_gain[0] < RULES.dispatch_recall_gain;
  return { ...base, decision: Object.values(gates).every(Boolean) ? "ADOPT" : "REJECT",
    metrics: m, gates, bootstrap: interval, fragile, promotion: Object.values(gates).every(Boolean) && !fragile ? "review-required" : "shadow-only" };
}
