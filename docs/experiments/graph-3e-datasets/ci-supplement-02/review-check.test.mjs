import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkReview, rebuildCounter } from './review-check.mjs';

test('counter rebuild: failures add, success resets, skips and cancels do nothing', () => {
  const h = c => c.map(conclusion => ({ conclusion }));
  assert.equal(rebuildCounter(h(['failure'])), 1);
  assert.equal(rebuildCounter(h(['failure', 'cancelled', 'timed_out'])), 2);
  assert.equal(rebuildCounter(h(['failure', 'success', 'failure'])), 1);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-check-'));
  fs.mkdirSync(path.join(dir, 'evidence'));
  fs.writeFileSync(path.join(dir, 'evidence', 'failure.log'), 'a\nnpm error code ECONNRESET\nc\n');
  fs.writeFileSync(path.join(dir, 'evidence', 'other.log'), 'a\nnpm error code ECONNRESET\nc\n');
  const packet = { id: 'p1', within_run_consecutive_failures: 1, history: [{ conclusion: 'failure', failure_log: { path: 'evidence/failure.log' } }],
    failure_log: { path: 'evidence/failure.log' }, source_context: [] };
  const review = { id: 'p1', recommended_action: 'retry', counter: 1, rationale: 'reset', inspection_complete: true, blind_to_predictions: true,
    evidence: [{ kind: 'field', field_path: '$.within_run_consecutive_failures', value: 1 },
      { kind: 'log', path: 'evidence/failure.log', line_start: 2, line_end: 2, quote: 'npm error code ECONNRESET' }],
    per_action_reasons: { retry: 'transport reset', fix: 'no defect', 'ask-owner': 'no authority need' }, tail_sufficient: true, missing_evidence: [] };
  return { dir, packet, review };
}

test('a complete review passes', () => {
  const { dir, packet, review } = fixture();
  assert.deepEqual(checkReview(review, packet, dir), []);
});

test('wrong quotes, missing fields, and bad counters are reported', () => {
  const { dir, packet, review } = fixture();
  assert.match(checkReview({ ...review, evidence: [review.evidence[0], { ...review.evidence[1], quote: 'made up' }] }, packet, dir).join(), /quote/);
  assert.match(checkReview({ ...review, per_action_reasons: { retry: 'x', fix: '' } }, packet, dir).join(), /per_action_reasons/);
  assert.match(checkReview({ ...review, counter: 2 }, packet, dir).join(), /counter/);
  assert.match(checkReview({ ...review, recommended_action: 'skip' }, packet, dir).join(), /action/);
  assert.match(checkReview({ ...review, recommended_action: 'unknown', missing_evidence: [] }, packet, dir).join(), /missing_evidence/);
  assert.match(checkReview({ ...review, evidence: [review.evidence[0], { ...review.evidence[1], path: '../escape.log' }] }, packet, dir).join(), /path/);
  assert.deepEqual(checkReview({ ...review, evidence: [{ kind: 'field', field_path: 'history' }, review.evidence[1]] }, packet, dir), []);
  assert.match(checkReview({ ...review, evidence: [{ kind: 'field', field_path: 'repo' }, review.evidence[1]] }, packet, dir).join(), /counter field/);
  assert.match(checkReview({ ...review, evidence: [review.evidence[0], { ...review.evidence[1], path: 'evidence/other.log' }] }, packet, dir).join(), /not referenced/);
  const { tail_sufficient, ...noTail } = review;
  assert.match(checkReview(noTail, packet, dir).join(), /tail_sufficient/);
});
