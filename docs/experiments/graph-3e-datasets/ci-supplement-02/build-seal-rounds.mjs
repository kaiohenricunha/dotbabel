// node build-seal-rounds.mjs <parent_dir> <out_dir>: seal v4-01 (round 1) plus the round-2 blind review into one two-round dataset.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { retryRow, validateSeal } from './seal.mjs';
import { checkReview } from './review-check.mjs';

const root = process.env.COHORT_ROOT;
if (!root) throw new Error('Set COHORT_ROOT to the private cohort directory');
const [parentDir, outDir] = process.argv.slice(2).map(p => path.resolve(p));
const review = path.join(root, 'review2');
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const jsonl = file => lines(file).map(line => JSON.parse(line));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const time = value => Date.parse(value);

// Round 1: parent records, unchanged except an appended review_round key on rows and unknowns.
const parentManifest = fs.readFileSync(path.join(parentDir, 'manifest.json'));
const parent = read(path.join(parentDir, 'manifest.json'));
for (const [name, hash] of Object.entries(parent.files)) if (sha(fs.readFileSync(path.join(parentDir, name))) !== hash) throw new Error(`parent file changed: ${name}`);
const withRound = (line, round) => {
  const record = { ...JSON.parse(line), review_round: round };
  const { review_round, ...back } = record;
  if (JSON.stringify(back) !== line) throw new Error('round-1 line does not round-trip byte for byte');
  return record;
};
const rows = lines(path.join(parentDir, 'retry.jsonl')).map(l => withRound(l, 1));
const unknown = lines(path.join(parentDir, 'unknown.jsonl')).map(l => withRound(l, 1));
const annotations = jsonl(path.join(parentDir, 'annotations.jsonl'));
const verification = jsonl(path.join(parentDir, 'verification.jsonl'));
const round1Ids = new Set(rows.map(r => r.id));

// Round 2: the amendment-02 control draw, reviewed in review2/.
const freeze = read(path.join(review, 'review-freeze.json'));
for (const f of freeze.files) if (sha(fs.readFileSync(path.join(review, f.path))) !== f.sha256) throw new Error(`round-2 review input changed: ${f.path}`);
const tails = new Map(jsonl(path.join(review, 'tails-coordinator.jsonl')).map(t => [t.id, t]));
const accepted = jsonl(path.join(review, 'batch-log.jsonl')).filter(e => e.status === 'accepted');
const actor = (role, batch) => {
  const entry = accepted.findLast(e => e.role === role && e.batch === batch);
  if (!entry) throw new Error(`no accepted round-2 ${role} run for batch ${batch}`);
  return `claude-opus-5-5/${role}/${entry.agent}`;
};
const round2 = [];
for (const file of fs.readdirSync(path.join(review, 'ws-a')).filter(f => /^batch-\d\d\.json$/.test(f)).sort()) {
  const batch = file.slice(6, 8);
  const outA = new Map(jsonl(path.join(review, 'ws-a/out', `batch-${batch}.jsonl`)).map(r => [r.id, r]));
  const outB = new Map(jsonl(path.join(review, 'ws-b/out', `batch-${batch}.jsonl`)).map(r => [r.id, r]));
  for (const { id, input_dir } of read(path.join(review, 'ws-a', file))) {
    if (round1Ids.has(id)) throw new Error(`round-2 case already in round 1: ${id}`);
    const packet = JSON.parse(lines(path.join(input_dir, 'packets.jsonl')).find(l => l.includes(`"id": ${JSON.stringify(id)}`)));
    const a = outA.get(id), b = outB.get(id);
    const base = { id, repo: packet.repo, pr: packet.pr, label: null, cohort: 'ci-supplement-02', selection_stratum: 'control',
      annotator_action: a?.recommended_action ?? null, verifier_action: b?.recommended_action ?? null };
    const problems = [...(a ? checkReview(a, packet, input_dir) : ['annotator record missing']),
      ...(b ? checkReview(b, packet, path.join(review, 'ws-b/inputs', path.basename(input_dir))) : ['verifier record missing'])];
    let reason = null;
    if (problems.length) reason = `review record failed validation: ${problems.join('; ')}`;
    else if (a.recommended_action !== b.recommended_action) reason = `reviewers disagree: ${a.recommended_action} vs ${b.recommended_action}`;
    else if (a.recommended_action === 'unknown') reason = 'both reviewers found the evidence insufficient';
    else if (packet.within_run_consecutive_failures >= 3) reason = 'cap_determined';
    if (reason) { unknown.push({ ...base, reason, review_round: 2 }); continue; }
    const row = { ...retryRow(packet, a.recommended_action, tails.get(id), { cohort: 'ci-supplement-02', selection_stratum: 'control' }), review_round: 2 };
    const side = (record, key, value, status, timeKey) => ({ id, head_sha: row.head_sha, label: row.label, [key]: value, status,
      ...(status === 'agree' ? { disagreements: [] } : {}), blind_to_predictions: record.blind_to_predictions, inspection_complete: record.inspection_complete,
      rationale: record.rationale, evidence: record.evidence, per_action_reasons: record.per_action_reasons, tail_sufficient: record.tail_sufficient,
      [timeKey]: record.reviewed_at });
    rows.push(row); round2.push(row);
    annotations.push(side(a, 'annotator', actor('annotator', batch), 'labeled', 'labeled_at'));
    verification.push(side(b, 'verifier', actor('verifier', batch), 'agree', 'verified_at'));
  }
}

// Per-round chronology: freeze_k <= labels_from_k <= labeled_at <= verified_at <= labels_to_k <= sealed_at.
const am = new Map(annotations.map(a => [a.id, a])), vm = new Map(verification.map(v => [v.id, v]));
const sealed_at = new Date().toISOString();
const freezes = { 1: parent.packet_frozen_at, 2: new Date(time(freeze.frozen_at)).toISOString() };
const rounds = {};
for (const k of [1, 2]) {
  const ids = rows.filter(r => r.review_round === k).map(r => r.id);
  const from = Math.min(...ids.map(id => time(am.get(id).labeled_at))), to = Math.max(...ids.map(id => time(vm.get(id).verified_at)));
  rounds[k] = { packet_frozen_at: freezes[k], labels_from: new Date(from).toISOString(), labels_to: new Date(to).toISOString() };
  for (const id of ids) {
    const l = time(am.get(id).labeled_at), v = time(vm.get(id).verified_at);
    if (!(time(freezes[k]) <= from && from <= l && l <= v && v <= to && to <= time(sealed_at))) throw new Error(`round ${k} chronology differs for ${id}`);
  }
}
// The shared validator checks every other v4 rule; its single freeze is the earliest round freeze.
const result = validateSeal({ rows, annotations, verification, unknown, times: { packet_frozen_at: freezes[1], sealed_at } });
if (unknown.some(u => ![1, 2].includes(u.review_round)) || rows.some(r => ![1, 2].includes(r.review_round))) throw new Error('review_round missing');

fs.mkdirSync(outDir, { mode: 0o700 });
const files = {};
for (const [name, list] of [['retry.jsonl', rows], ['annotations.jsonl', annotations], ['verification.jsonl', verification], ['unknown.jsonl', unknown]]) {
  const body = list.map(item => JSON.stringify(item)).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, name), body, { mode: 0o600, flag: 'wx' });
  files[name] = sha(Buffer.from(body));
}
for (const name of ['annotations.jsonl', 'verification.jsonl']) {
  const parentBody = fs.readFileSync(path.join(parentDir, name), 'utf8');
  if (!fs.readFileSync(path.join(outDir, name), 'utf8').startsWith(parentBody)) throw new Error(`${name} round-1 lines changed`);
}
const gateWords = /\blabel\b|do-not-merge|backport|hold/i;
const ownerGates = round2.filter(r => r.label === 'ask-owner' && gateWords.test(am.get(r.id).rationale)).length;
const counts = { ...result.counts, rounds: { 1: rows.filter(r => r.review_round === 1).length, 2: round2.length } };
const manifest = { version: 2, created_at: sealed_at, packet_frozen_at: freezes[2], sealed_at, label_source: 'ai-annotation-verified',
  parent_manifest_sha256: sha(parentManifest), rounds, repositories: result.repositories, counts, files,
  floors_met: result.floors_met, gaps: result.gaps,
  round1_rule: 'annotations.jsonl and verification.jsonl start with the parent files byte for byte; each round-1 retry.jsonl and unknown.jsonl line equals the parent line with "review_round":1 appended as its last key.',
  provenance: { ...parent.provenance, round2_review_freeze_sha256: sha(fs.readFileSync(path.join(review, 'review-freeze.json'))),
    round2_batch_log_sha256: sha(fs.readFileSync(path.join(review, 'batch-log.jsonl'))), round2_amendment_sha256: sha(fs.readFileSync(path.join(root, 'contract-amendment-02.json'))),
    rounds_contract_sha256: sha(fs.readFileSync(path.join(root, 'seal-contract-v4-rounds.json'))) },
  limits: [...parent.limits, `Round 2 is a 100-case control draw (contract-amendment-02) reviewed by a fresh blind pair; ${ownerGates} of its ${round2.filter(r => r.label === 'ask-owner').length} ask-owner rows are PR label or merge gates (do-not-merge, backport, hold), which any keyword rule can match; report them as a subgroup.`] };
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ out: outDir, counts, gaps: result.gaps, floors_met: result.floors_met, rounds, round2_ask_owner_gate_rows: ownerGates }, null, 1));
