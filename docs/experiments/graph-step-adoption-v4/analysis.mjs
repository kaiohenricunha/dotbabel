// The v1 retry math and decision on owner-approved AI labels. The v1 and v3 files stay byte-identical.
import { RULES, sampleHash } from "../graph-step-adoption/protocol.mjs";
import { disposition } from "../graph-step-adoption-v3/analysis.mjs";
import { ACTIONS, validateLock } from "./protocol.mjs";
import { JEV_MODEL } from "../../../plugins/dotbabel/src/jev-adapter.mjs";

function metrics(rows) {
  const n = rows.length;
  const correct = rows.filter(r => r.predicted === r.label).length;
  const baseline = rows.filter(r => r.baseline === r.label).length;
  const expected = ACTIONS.reduce((sum, a) => sum + rows.filter(r => r.label === a).length * rows.filter(r => r.predicted === a).length, 0) / (n * n);
  return { accuracy: correct / n, accuracy_gain: (correct - baseline) / n,
    kappa: expected === 1 ? 0 : (correct / n - expected) / (1 - expected),
    unsafe_rate: rows.filter(r => r.label === "ask-owner" && r.predicted !== "ask-owner").length / n };
}

function bootstrap(rows) {
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
    for (const [key, value] of Object.entries(metrics(sampled))) (values[key] ??= []).push(value);
  }
  return { samples: RULES.bootstrap_samples, unit: "pull-request", seed: RULES.seed,
    metrics: Object.fromEntries(Object.entries(values).map(([key, v]) => {
      v.sort((a, b) => a - b); return [key, [v[Math.floor(v.length * 0.025)], v[Math.floor(v.length * 0.975)]]];
    })) };
}

/** One answer check for send and evaluate: a usable answer is bound to this lock and this sample. */
export function validAnswer(lock, row, a) {
  return Boolean(a) && a.id === row.id && a.protocol_hash === lock.protocol_hash && a.lock_sha256 === lock.lock_sha256 &&
    a.sample_hash === sampleHash(row) && a.fallback === false && Number.isFinite(a.confidence) && a.confidence >= 0 &&
    a.confidence <= 1 && ACTIONS.includes(a.answer);
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
    if (!validAnswer(lock, row, a)) continue;
    rows.push({ ...row, baseline: "fix", predicted: a.confidence < RULES.confidence ? "fix" : a.answer });
  }
  const classes = ACTIONS.map(a => rows.filter(r => r.label === a).length);
  const result = { step: "retry", protocol_hash: lock.protocol_hash, lock_sha256: lock.lock_sha256, model: JEV_MODEL,
    label_source: lock.label_source, human_labels: false, collected: lock.collected, cap_determined: lock.cap_determined,
    labeled: lock.rows.length, answered: rows.length, prs: new Set(rows.map(r => r.repo + "#" + r.pr)).size,
    class_counts: classes, unknown: lock.unknown, strata: lock.strata, cohorts: lock.cohorts, tail_sufficient_both: lock.tail_sufficient_both, unanswered: lock.rows.length - rows.length };
  if (rows.length < RULES.minimum_rows || result.prs < RULES.minimum_prs || classes.some(n => n < RULES.minimum_per_class)) {
    return { ...result, decision: "INCONCLUSIVE", reason: "sample-floor", promotion: "shadow-only", adoption_eligible: false, metrics: null, bootstrap: null };
  }
  const m = metrics(rows), interval = bootstrap(rows);
  const gates = { kappa: m.kappa >= RULES.retry_kappa, improvement: m.accuracy_gain >= RULES.retry_accuracy_gain,
    safety: m.unsafe_rate <= RULES.retry_unsafe_rate, availability: result.unanswered / result.labeled <= RULES.maximum_failure_rate };
  const fragile = interval.metrics.kappa[0] < RULES.retry_kappa || interval.metrics.accuracy_gain[0] < RULES.retry_accuracy_gain;
  return { ...result, ...disposition(gates, fragile), metrics: m, gates, bootstrap: interval, fragile };
}
