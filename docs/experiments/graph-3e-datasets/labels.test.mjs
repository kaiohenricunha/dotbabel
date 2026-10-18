import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { reconcile, integrate } from "./labels.mjs";
import { collect, stage, finalize, seal, save, validate } from "./prepare.mjs";
import { sealRecovery } from "./recovery.mjs";

const sha = "a".repeat(40);
const row = { id: "owner/repo#1:retry", repo: "owner/repo", pr: 1, head_sha: sha, step: "retry",
  input: { phase: "local-attest", attempt: 1, failure_tail: "lint: invalid syntax" }, label: null };
const annotation = { id: row.id, head_sha: sha, label: "fix", annotator: "agent:one", rationale: "Correct the syntax before running lint again.",
  status: "labeled", blind_to_predictions: true, labeled_at: "2026-10-18T03:00:00Z", evidence: ["evidence/a.json"], inspection_complete: true };
const verification = { id: row.id, head_sha: sha, label: "fix", verifier: "agent:two", rationale: "A repeated command cannot correct invalid syntax.",
  status: "independent-label", blind_to_predictions: true, verified_at: "2026-10-18T03:01:00Z", evidence: ["evidence/a.json"], inspection_complete: true };

test("admits separate matching blind labels without claiming human provenance", () => {
  const result = reconcile([row], [annotation], [verification], "2026-10-18T03:02:00Z");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].label_source, "ai-annotation-verified");
  assert.equal(result.verifications[0].status, "agree");
  assert.deepEqual(result.verifications[0].disagreements, []);
});

test("retains unknown labels and disagreements instead of inventing consensus", () => {
  for (const [a, v, reason] of [
    [{ ...annotation, label: null, status: "unknown" }, { ...verification, label: null, status: "unknown" }, "insufficient_evidence"],
    [annotation, { ...verification, label: "retry" }, "independent_labels_disagree"],
  ]) {
    const result = reconcile([row], [a], [v], "2026-10-18T03:02:00Z");
    assert.equal(result.accepted.length, 0);
    assert.equal(result.unknown[0].reason, reason);
  }
});

test("rejects reused actors, unseen heads, late labels, prediction exposure and duplicate IDs", () => {
  for (const bad of [{ ...verification, verifier: annotation.annotator }, { ...verification, head_sha: "b".repeat(40) },
    { ...verification, verified_at: "2026-10-18T04:00:00Z" }, { ...verification, blind_to_predictions: false }])
    assert.throws(() => reconcile([row], [annotation], [bad], "2026-10-18T03:02:00Z"));
  assert.throws(() => reconcile([row], [annotation, annotation], [verification], "2026-10-18T03:02:00Z"));
  assert.throws(() => reconcile([row], [annotation], [], "2026-10-18T03:02:00Z"));
});

test("dispatch negatives require complete independent inspection and no unavailable additions", () => {
  const r = { ...row, step: "dispatch", input: { profile: ["security-auditor"], candidates: ["documentation-writer"], changed_files: ["a.md"], changed_lines: 2 } };
  const a = { ...annotation, label: [] }, v = { ...verification, label: [] };
  assert.equal(reconcile([r], [a], [v], "2026-10-18T03:02:00Z").accepted.length, 1);
  assert.throws(() => reconcile([r], [{ ...a, inspection_complete: false }], [v], "2026-10-18T03:02:00Z"));
  assert.throws(() => reconcile([r], [{ ...a, label: ["security-auditor"] }], [{ ...v, label: ["security-auditor"] }], "2026-10-18T03:02:00Z"));
});

test("integrates sealed evidence and blind sidecars without changing the parent", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-labels-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "parent"), recovery = path.join(root, "recovery"), labeling = path.join(root, "labeling");
  const write = (dir, name, value) => save(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  write(root, "config.json", { sources: [], repositories: [] });
  await collect(path.join(root, "config.json"), parent); stage(parent);
  write(parent, "annotations.jsonl", ""); write(parent, "verification.jsonl", ""); finalize(parent); seal(parent);
  const parentManifest = fs.readFileSync(path.join(parent, "manifest.json"), "utf8");
  const r = { ...row, source: "https://github.com/owner/repo/pull/1", label_source: null, labeled_before_replay: false,
    evidence: ["evidence/a.json"], provenance_ref: "evidence/a.json" };
  write(recovery, "evidence/a.json", { repo: r.repo, pr: r.pr, head_sha: sha, decision_head_verified: true,
    failure_link_verified: true, original_log: true, phase: r.input.phase, attempt: 1, failure_tail: r.input.failure_tail });
  write(recovery, "retry-annotation-input.jsonl", JSON.stringify(r) + "\n");
  write(recovery, "dispatch-annotation-input.jsonl", ""); sealRecovery(recovery, parent);
  for (const name of ["annotator-input.jsonl", "verifier-input.jsonl"]) write(labeling, name, JSON.stringify(r) + "\n");
  write(labeling, "annotations.jsonl", JSON.stringify(annotation) + "\n");
  write(labeling, "independent-verification.jsonl", JSON.stringify(verification) + "\n");
  const out = path.join(root, "verified");
  const result = integrate(parent, recovery, labeling, out, "2026-10-18T03:02:00Z");
  assert.equal(result.new_agreed_labels, 1);
  assert.equal(result.datasets.retry.classes.fix, 1);
  assert.equal(result.evaluator.retry.exclusions.unlabeled, 1);
  assert.equal(result.sample_floors_met, false);
  assert.equal(fs.readFileSync(path.join(parent, "manifest.json"), "utf8"), parentManifest);
  assert.equal(validate(out).structural_valid, true);
  assert.equal(fs.statSync(path.join(out, "retry.jsonl")).mode & 0o777, 0o600);
  assert.throws(() => integrate(parent, recovery, labeling, out), /output must be new/);
  const unknownLabels = path.join(root, "unknown-labels");
  for (const name of ["annotator-input.jsonl", "verifier-input.jsonl"]) write(unknownLabels, name, JSON.stringify(r) + "\n");
  write(unknownLabels, "annotations.jsonl", JSON.stringify({ ...annotation, label: null, status: "unknown" }) + "\n");
  write(unknownLabels, "independent-verification.jsonl", JSON.stringify({ ...verification, label: null, status: "unknown" }) + "\n");
  const uncertain = integrate(parent, recovery, unknownLabels, path.join(root, "uncertain"), "2026-10-18T03:02:00Z");
  assert.equal(uncertain.new_agreed_labels, 0);
  assert.equal(uncertain.new_unknown, 1);
});
