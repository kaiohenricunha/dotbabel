// AI-proxy agreement only. Numeric math intentionally matches the immutable v1 dispatch rule.
import { RULES, sampleHash } from "../graph-step-adoption/protocol.mjs";
import { validateLock } from "./protocol.mjs";
import { JEV_MODEL } from "../../../plugins/dotbabel/src/jev-adapter.mjs";

function metrics(rows) {
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

function bootstrap(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.repo + "#" + row.pr;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const clusters = [...groups.values()], values = {}; let seed = RULES.seed;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < RULES.bootstrap_samples; i++) {
    const sampled = Array.from({ length: clusters.length }, () => clusters[Math.floor(random() * clusters.length)]).flat();
    for (const [key, value] of Object.entries(metrics(sampled))) (values[key] ??= []).push(value);
  }
  return { samples: RULES.bootstrap_samples, unit: "pull-request", seed: RULES.seed,
    metrics: Object.fromEntries(Object.entries(values).map(([key, v]) => {
      v.sort((a, b) => a - b); return [key, [v[Math.floor(v.length * 0.025)], v[Math.floor(v.length * 0.975)]]];
    })) };
}

export function sampleFloor(rows, prs, classes) {
  return rows >= RULES.minimum_rows && prs >= RULES.minimum_prs && classes.length === 2 && classes.every(count => count >= RULES.minimum_per_class);
}

export function evaluate(file, answers = []) {
  const lock = validateLock(file), ids = new Set(lock.rows.map(r => r.id)), map = new Map();
  for (const a of answers) {
    if (map.has(a.id)) throw new Error("duplicate answer id");
    if (!ids.has(a.id)) throw new Error("answer outside the locked sample");
    map.set(a.id, a);
  }
  const rows = [];
  for (const row of lock.rows) {
    const a = map.get(row.id);
    if (!a || a.protocol_hash !== lock.protocol_hash || a.lock_sha256 !== lock.lock_sha256 || a.sample_hash !== sampleHash(row) ||
        a.fallback !== false || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1 ||
        !Array.isArray(a.answer) || new Set(a.answer).size !== a.answer.length || a.answer.some(r => !row.input.candidates.includes(r))) continue;
    const baseline = row.input.profile.includes("security-auditor") ? [] : ["security-auditor"];
    rows.push({ ...row, baseline, predicted: a.confidence < RULES.confidence ? baseline : [...new Set([...baseline, ...a.answer])] });
  }
  const classes = [rows.filter(r => r.label.length).length, rows.filter(r => !r.label.length).length];
  const result = { step: "dispatch", protocol_hash: lock.protocol_hash, lock_sha256: lock.lock_sha256, model: JEV_MODEL,
    evidence_scope: "AI-proxy agreement only", human_labels: false, adoption_eligible: false, promotion: "shadow-only",
    collected: lock.rows.length + lock.unknown, labeled: lock.rows.length, answered: rows.length,
    prs: new Set(rows.map(r => r.repo + "#" + r.pr)).size, class_counts: classes, unknown: lock.unknown,
    cohorts: lock.cohorts, unanswered: lock.rows.length - rows.length };
  if (!sampleFloor(rows.length, result.prs, classes)) return { ...result, decision: "INCONCLUSIVE", reason: "sample-floor", metrics: null, bootstrap: null };
  const m = metrics(rows), interval = bootstrap(rows);
  const gates = { precision: m.precision >= RULES.dispatch_precision, recall: m.recall >= RULES.dispatch_recall,
    improvement: m.recall_gain >= RULES.dispatch_recall_gain, availability: result.unanswered / result.labeled <= RULES.maximum_failure_rate };
  return { ...result, decision: Object.values(gates).every(Boolean) ? "AI_AGREEMENT_PASS" : "AI_AGREEMENT_FAIL",
    numeric_gates_passed: Object.values(gates).every(Boolean), metrics: m, gates, bootstrap: interval,
    fragile: interval.metrics.precision[0] < RULES.dispatch_precision || interval.metrics.recall[0] < RULES.dispatch_recall || interval.metrics.recall_gain[0] < RULES.dispatch_recall_gain };
}
