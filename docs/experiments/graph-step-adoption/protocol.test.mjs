import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, RULES, protocolHash, sampleHash, dispatchProfile } from "./protocol.mjs";

const sha = "a".repeat(40);
function dataset(step, count = 120) {
  return Array.from({ length: count }, (_, i) => {
    const label = step === "retry" ? ["retry", "fix", "ask-owner"][i % 3] : i % 2 ? ["documentation-writer"] : [];
    return { id: `${step}-${i}`, repo: "owner/repo", pr: i + 1, head_sha: sha, source: `https://github.com/owner/repo/pull/${i + 1}`,
      step, input: step === "retry" ? { phase: "review-pr", attempt: 1, failure_tail: "failure" } : { profile: ["security-auditor"], changed_files: ["notes.md"], changed_lines: 2, candidates: ["documentation-writer"] },
      label, label_source: "independent-human", labeled_before_replay: true };
  });
}
function answers(rows, answer = row => row.label) {
  return rows.map(row => ({ id: row.id, protocol_hash: protocolHash(), sample_hash: sampleHash(row), answer: answer(row), confidence: 1, fallback: false }));
}
test("the rules are pinned before model answers and enforce 2000 clustered samples", () => {
  assert.equal(RULES.minimum_rows, 100);
  assert.equal(RULES.minimum_prs, 30);
  assert.equal(RULES.minimum_per_class, 20);
  assert.equal(RULES.bootstrap_samples, 2000);
  assert.equal(RULES.confidence, 0.9);
  assert.match(protocolHash(), /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(RULES));
});
for (const step of ["retry", "dispatch"]) {
  test(`${step}: a perfect sufficiently large independent dataset passes`, () => {
    const rows = dataset(step);
    const result = analyze(step, rows, answers(rows));
    assert.equal(result.decision, "ADOPT");
    assert.equal(result.answered, 120);
    assert.equal(result.bootstrap.samples, 2000);
    assert.ok(result.bootstrap.metrics);
  });
  test(`${step}: missing labels or model answers is INCONCLUSIVE`, () => {
    const rows = dataset(step);
    assert.equal(analyze(step, rows, []).decision, "INCONCLUSIVE");
    assert.equal(analyze(step, rows.map(r => ({ ...r, label: null })), answers(rows)).decision, "INCONCLUSIVE");
    assert.equal(analyze(step, rows.map(r => ({ ...r, label_source: "model" })), answers(rows)).decision, "INCONCLUSIVE");
  });
  test(`${step}: 99 rows and 29 PRs fail the sample floor`, () => {
    const rows = dataset(step);
    assert.equal(analyze(step, rows.slice(0, 99), answers(rows)).decision, "INCONCLUSIVE");
    assert.equal(analyze(step, rows.map((r,i) => ({...r, pr: i % 29 + 1})), answers(rows)).decision, "INCONCLUSIVE");
  });
  test(`${step}: duplicate ids, stale protocols, and malformed probabilities cannot count`, () => {
    const rows = dataset(step);
    assert.throws(() => analyze(step, [...rows, rows[0]], answers(rows)), /duplicate/);
    assert.throws(() => analyze(step, rows, [...answers(rows), answers(rows)[0]]), /duplicate/);
    assert.equal(analyze(step, rows, answers(rows).map(a => ({ ...a, protocol_hash: "old" }))).decision, "INCONCLUSIVE");
    assert.equal(analyze(step, rows, answers(rows).map(a => ({ ...a, confidence: 1.1 }))).decision, "INCONCLUSIVE");
  });
}
test("retry: the built-in baseline cannot pass an improvement gate", () => {
  const rows = dataset("retry");
  const result = analyze("retry", rows, answers(rows, () => "fix"));
  assert.equal(result.decision, "REJECT");
  assert.equal(result.metrics.accuracy_gain, 0);
});
test("retry: low confidence uses the built-in action, and cap overrides cannot be adopted", () => {
  const rows = dataset("retry");
  assert.equal(analyze("retry", rows, answers(rows).map(a => ({ ...a, confidence: 0.89 }))).decision, "REJECT");
  const capped = rows.map(r => ({ ...r, input: { ...r.input, attempt: 3 }, label: "ask-owner" }));
  const r = analyze("retry", capped, answers(capped, () => "retry"));
  assert.ok(r.exclusions.cap_determined > 0);
  assert.equal(r.decision, "INCONCLUSIVE");
});
test("dispatch: unnecessary reviewers fail precision even with high recall", () => {
  const rows = dataset("dispatch");
  const result = analyze("dispatch", rows, answers(rows, () => ["documentation-writer"]));
  assert.equal(result.decision, "REJECT");
  assert.equal(result.metrics.precision, 0.5);
});
test("dispatch: full profiles are not additional-reviewer opportunities", () => {
  const rows = dataset("dispatch").map(r => ({ ...r, input: { ...r.input, profile: ["security-auditor", "documentation-writer"] } }));
  assert.equal(analyze("dispatch", rows, answers(rows)).decision, "INCONCLUSIVE");
});
test("bootstrap is deterministic and resamples PR clusters", () => {
  const rows = dataset("retry");
  assert.deepEqual(analyze("retry", rows, answers(rows)).bootstrap, analyze("retry", rows, answers(rows)).bootstrap);
});
test("the dispatch profile prioritizes protected paths and the 150-line boundary", () => {
  assert.equal(dispatchProfile(["README.md"], 1, ["README.md"]).name, "full-protected");
  assert.equal(dispatchProfile(["notes.md"], 1000, []).name, "docs-only");
  assert.equal(dispatchProfile(["lib.mjs"], 149, []).name, "small-code");
  assert.equal(dispatchProfile(["lib.mjs"], 150, []).name, "full-size");
  assert.equal(dispatchProfile(["src/a.mjs"], 1, ["src/**"]).name, "full-protected");
  assert.equal(dispatchProfile(["docs/specs/example/spec.json"], 1, ["docs/specs/**/spec.json"]).name, "full-protected");
});
