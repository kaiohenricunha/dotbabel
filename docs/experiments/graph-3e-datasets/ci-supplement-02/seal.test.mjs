import test from 'node:test';
import assert from 'node:assert/strict';
import { failureTail, retryRow, validateSeal } from './seal.mjs';

test('failure tail ends at the last error annotation and keeps whole lines', () => {
  const lines = ['setup', 'step output', '##[error]first', 'more', '##[error]Process completed with exit code 1.', 'Post job cleanup.', 'Cleaning up orphan processes'];
  const result = failureTail(lines.join('\n'));
  assert.equal(result.tail_rule, 'last-error');
  assert.deepEqual(result.tail_line_range, [1, 5]);
  assert.equal(result.failure_tail, lines.slice(0, 5).join('\n'));
  assert.equal(result.failure_tail.includes('Post job cleanup'), false);
});

test('failure tail falls back to the log end and respects the character limit on line boundaries', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} ` + 'x'.repeat(90));
  const result = failureTail(lines.join('\n'), 1000);
  assert.equal(result.tail_rule, 'log-end');
  assert.ok(result.failure_tail.length <= 1000);
  assert.equal(result.tail_line_range[1], 50);
  assert.equal(result.failure_tail, lines.slice(result.tail_line_range[0] - 1).join('\n'));
  const long = failureTail('a\n' + 'y'.repeat(3000) + '\n##[error]z'.slice(1), 1000);
  assert.ok(long.failure_tail.length <= 1000 && long.failure_tail.length > 0);
});

const packet = { id: 'gha:o/r#5:1:2', repo: 'o/r', pr: 5, run_id: 1, job_id: 2, execution_sha: 'a'.repeat(40),
  within_run_consecutive_failures: 1, source: 'https://github.com/o/r/actions/runs/1/job/2' };

test('retry rows carry exactly the decider input and refuse capped counters', () => {
  const tail = { failure_tail: 'x', tail_rule: 'log-end', tail_line_range: [1, 1] };
  const row = retryRow(packet, 'fix', tail, { cohort: 'c', selection_stratum: 'enriched' });
  assert.deepEqual(Object.keys(row.input).sort(), ['attempt', 'failure_tail', 'phase']);
  assert.deepEqual(row.input, { phase: 'ci', attempt: 1, failure_tail: 'x' });
  assert.equal(row.label_source, 'ai-annotation-verified');
  assert.equal(row.head_sha, packet.execution_sha);
  assert.throws(() => retryRow({ ...packet, within_run_consecutive_failures: 3 }, 'fix', tail, { cohort: 'c', selection_stratum: 'enriched' }), /cap/);
  assert.throws(() => retryRow(packet, 'unknown', tail, { cohort: 'c', selection_stratum: 'enriched' }), /label/);
  assert.throws(() => retryRow(packet, 'fix', tail, { cohort: 'c', selection_stratum: 'other' }), /stratum/);
});

function seal() {
  const tail = { failure_tail: 'x', tail_rule: 'log-end', tail_line_range: [1, 1] };
  const row = retryRow(packet, 'fix', tail, { cohort: 'c', selection_stratum: 'enriched' });
  const reasons = { retry: 'r', fix: 'f', 'ask-owner': 'o' };
  const a = { id: row.id, head_sha: row.head_sha, label: 'fix', annotator: 'A', status: 'labeled', blind_to_predictions: true, inspection_complete: true,
    rationale: 'why', evidence: [{ kind: 'log' }], per_action_reasons: reasons, tail_sufficient: true, labeled_at: '2026-10-20T05:00:00Z' };
  const v = { id: row.id, head_sha: row.head_sha, label: 'fix', verifier: 'B', status: 'agree', disagreements: [], blind_to_predictions: true, inspection_complete: true,
    rationale: 'why', evidence: [{ kind: 'log' }], per_action_reasons: reasons, tail_sufficient: false, verified_at: '2026-10-20T05:10:00Z' };
  return { rows: [row], annotations: [a], verification: [v], unknown: [{ id: 'u', repo: 'o/r', pr: 6, reason: 'disagreement', label: null }],
    times: { packet_frozen_at: '2026-10-20T04:00:00Z', sealed_at: '2026-10-20T06:00:00Z' } };
}

test('seal validation accepts a complete dataset and reports floors without lowering them', () => {
  const result = validateSeal(seal());
  assert.equal(result.counts.rows, 1);
  assert.deepEqual(result.counts.classes, { retry: 0, fix: 1, 'ask-owner': 0 });
  assert.equal(result.floors_met, false);
  assert.deepEqual(result.gaps, { rows: 99, prs: 29, retry: 20, fix: 19, 'ask-owner': 20 });
});

test('seal validation refuses broken provenance', () => {
  const mutate = f => { const s = seal(); f(s); return () => validateSeal(s); };
  assert.throws(mutate(s => { s.verification[0].verifier = 'A'; }), /distinct/);
  assert.throws(mutate(s => { s.annotations[0].per_action_reasons.retry = ''; }), /per_action_reasons/);
  assert.throws(mutate(s => { s.verification[0].label = 'retry'; }), /label/);
  assert.throws(mutate(s => { s.annotations[0].labeled_at = '2026-10-20T03:00:00Z'; }), /frozen/);
  assert.throws(mutate(s => { s.unknown[0].id = s.rows[0].id; }), /unknown/);
  assert.throws(mutate(s => { delete s.annotations[0].tail_sufficient; }), /tail_sufficient/);
  assert.throws(mutate(s => { s.rows[0].input.job = 'x'; }), /input/);
  assert.throws(mutate(s => { s.rows.push({ ...s.rows[0], id: 'other' }); s.annotations.push({ ...s.annotations[0], id: 'other' }); s.verification.push({ ...s.verification[0], id: 'other' }); }), /PR/);
});

test('v4 strict checks: repository spelling, tail consistency, verification order, unique sidecar ids', () => {
  const mutate = f => { const s = seal(); f(s); return () => validateSeal(s); };
  assert.throws(mutate(s => { s.unknown[0].repo = 'O/R'; }), /spelling/);
  assert.throws(mutate(s => { s.rows[0].tail_rule = 'last-error'; }), /tail/);
  assert.throws(mutate(s => { s.rows[0].input.failure_tail = 'a\n##[error]x'; }), /tail/);
  assert.throws(mutate(s => { s.rows[0].input.failure_tail = 'a\nb\nc'; }), /tail/);
  assert.throws(mutate(s => { s.verification[0].verified_at = '2026-10-20T04:30:00Z'; }), /verified_at/);
  assert.throws(mutate(s => { s.unknown.push({ ...s.unknown[0] }); }), /duplicate/);
  assert.deepEqual(validateSeal(seal()).repositories, ['o/r']);
  const ok = failureTail('x\n##[error]boom\nPost job cleanup.');
  const s = seal(); s.rows[0].input.failure_tail = ok.failure_tail; s.rows[0].tail_rule = ok.tail_rule; s.rows[0].tail_line_range = ok.tail_line_range;
  assert.equal(validateSeal(s).counts.rows, 1);
});

test('failure tail stays under the serialized byte ceiling even for escape-heavy logs', () => {
  const ansi = '\u001b'.repeat(40);
  const lines = Array.from({ length: 2000 }, (_, i) => `${i} ${ansi.repeat(4)}`);
  lines.push('##[error]Process completed with exit code 1.');
  const result = failureTail(lines.join('\n'));
  const bytes = Buffer.byteLength(JSON.stringify({ phase: 'ci', attempt: 1, failure_tail: result.failure_tail }));
  assert.ok(bytes <= 60000, `serialized ${bytes}`);
  assert.ok(result.failure_tail.length <= 16000);
  assert.ok(result.failure_tail.split('\n').at(-1).includes('##[error]'));
  assert.equal(result.tail_line_range[1], lines.length);
});
