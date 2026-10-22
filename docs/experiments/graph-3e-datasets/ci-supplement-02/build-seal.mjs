// node build-seal.mjs <out_dir>: join both blind reviews into the protocol-v4 retry dataset and seal it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { retryRow, validateSeal } from './seal.mjs';
import { checkReview } from './review-check.mjs';

const root = process.env.COHORT_ROOT;
if (!root) throw new Error('Set COHORT_ROOT to the private cohort directory');
const review = path.join(root, 'review');
const outDir = path.resolve(process.argv[2]);
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const jsonl = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// The workspaces must be byte-identical to their pre-review freeze.
const freeze = read(path.join(review, 'review-freeze.json'));
for (const f of freeze.files) if (sha(fs.readFileSync(path.join(review, f.path))) !== f.sha256) throw new Error(`review input changed: ${f.path}`);

const map = read(path.join(review, 'cohort-map.json'));
const strata = new Map(read(path.join(root, 'packet-index.json')).map(r => [r.id, r.selection_stratum]));
const stratumOf = (cohort, id) => ({ c1: 'unselected-prior', c2: 'enriched' }[cohort] ?? strata.get(id));
const tails = new Map(jsonl(path.join(review, 'tails-coordinator.jsonl')).map(t => [t.id, t]));
const log = jsonl(path.join(review, 'batch-log.jsonl'));
const accepted = log.filter(entry => entry.status === 'accepted');
const actor = (role, batch) => {
  const entry = accepted.findLast(e => e.role === role && e.batch === batch);
  if (!entry) throw new Error(`no accepted ${role} run for batch ${batch}`);
  return { id: `claude-opus-5-5/${role}/${entry.agent}`, entry };
};

const rows = [], annotations = [], verification = [], unknown = [];
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null; // dry run on a subset of batches
const batches = fs.readdirSync(path.join(review, 'ws-a')).filter(f => /^batch-\d\d\.json$/.test(f) && (!only || only.has(f.slice(6, 8)))).sort();
for (const file of batches) {
  const batch = file.slice(6, 8);
  const [annotator, verifier] = [actor('annotator', batch), actor('verifier', batch)];
  const outA = new Map(jsonl(path.join(review, 'ws-a/out', `batch-${batch}.jsonl`)).map(r => [r.id, r]));
  const outB = new Map(jsonl(path.join(review, 'ws-b/out', `batch-${batch}.jsonl`)).map(r => [r.id, r]));
  for (const { id, input_dir } of read(path.join(review, 'ws-a', file))) {
    const cohort = path.basename(input_dir);
    const packet = JSON.parse(fs.readFileSync(path.join(input_dir, 'packets.jsonl'), 'utf8').split('\n').find(l => l.includes(`"id": ${JSON.stringify(id)}`)));
    const a = outA.get(id), b = outB.get(id);
    const base = { id, repo: packet.repo, pr: packet.pr, label: null, cohort: map.cohort_names[cohort], selection_stratum: stratumOf(cohort, id),
      annotator_action: a?.recommended_action ?? null, verifier_action: b?.recommended_action ?? null };
    const problems = [...(a ? checkReview(a, packet, input_dir) : ['annotator record missing']), ...(b ? checkReview(b, packet, path.join(review, 'ws-b/inputs', cohort)) : ['verifier record missing'])];
    let reason = null;
    if (problems.length) reason = `review record failed validation: ${problems.join('; ')}`;
    else if (a.recommended_action !== b.recommended_action) reason = `reviewers disagree: ${a.recommended_action} vs ${b.recommended_action}`;
    else if (a.recommended_action === 'unknown') reason = 'both reviewers found the evidence insufficient';
    else if (packet.within_run_consecutive_failures >= 3) reason = 'cap_determined';
    else if (packet.history.some((h, i) => packet.history.slice(0, i).some(p => p.job_id !== h.job_id && p.completed_at === h.completed_at &&
      p.failure_log?.sha256 && p.failure_log.sha256 === h.failure_log?.sha256))) reason = 'duplicate execution identity: identical logs and completion times under different job ids';
    if (reason) { unknown.push({ ...base, reason }); continue; }
    const row = retryRow(packet, a.recommended_action, tails.get(id), { cohort: map.cohort_names[cohort], selection_stratum: stratumOf(cohort, id) });
    const side = (record, key, value, status, timeKey) => ({ id, head_sha: row.head_sha, label: row.label, [key]: value, status,
      ...(status === 'agree' ? { disagreements: [] } : {}), blind_to_predictions: record.blind_to_predictions, inspection_complete: record.inspection_complete,
      rationale: record.rationale, evidence: record.evidence, per_action_reasons: record.per_action_reasons, tail_sufficient: record.tail_sufficient,
      [timeKey]: record.reviewed_at });
    rows.push(row);
    annotations.push(side(a, 'annotator', annotator.id, 'labeled', 'labeled_at'));
    verification.push(side(b, 'verifier', verifier.id, 'agree', 'verified_at'));
  }
}

const frozenTimes = ['c1', 'c2', 'c3'].map(cohort => {
  const f = read(path.join(map[cohort], 'freeze.json')); return f.frozen_at ?? f.created_at;
}).concat(freeze.frozen_at);
const packet_frozen_at = new Date(Math.max(...frozenTimes.map(t => Date.parse(t)))).toISOString();
const sealed_at = new Date().toISOString();
const result = validateSeal({ rows, annotations, verification, unknown, times: { packet_frozen_at, sealed_at } });

fs.mkdirSync(outDir, { mode: 0o700 });
const files = {};
for (const [name, list] of [['retry.jsonl', rows], ['annotations.jsonl', annotations], ['verification.jsonl', verification], ['unknown.jsonl', unknown]]) {
  const body = list.map(item => JSON.stringify(item)).join('\n') + (list.length ? '\n' : '');
  fs.writeFileSync(path.join(outDir, name), body, { mode: 0o600, flag: 'wx' });
  files[name] = sha(Buffer.from(body));
}
const manifest = { version: 1, created_at: sealed_at, packet_frozen_at, sealed_at, label_source: 'ai-annotation-verified',
  repositories: result.repositories, counts: result.counts, files, floors_met: result.floors_met, gaps: result.gaps,
  provenance: { review_freeze_sha256: sha(fs.readFileSync(path.join(review, 'review-freeze.json'))), batch_log_sha256: sha(fs.readFileSync(path.join(review, 'batch-log.jsonl'))),
    seal_contract_sha256: sha(fs.readFileSync(path.join(root, 'seal-contract-v4.json'))) },
  limits: ['Labels are AI labels, not human labels.', 'Annotator and verifier are separate blind runs of the same model family; their agreement is not statistical independence.',
    'Enriched strata were picked by log keywords and cannot estimate prevalence; report results per stratum.',
    `Cohort counters: ${rows.filter(r => r.input.attempt === 2).length} rows have attempt 2; all others have attempt 1.`] };
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ out: outDir, counts: result.counts, floors_met: result.floors_met, gaps: result.gaps }, null, 1));
