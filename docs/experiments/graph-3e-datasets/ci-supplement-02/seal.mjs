// Builds and checks the protocol-v4 retry dataset (seal-contract-v4.json).
export const ACTIONS = ['retry', 'fix', 'ask-owner'];
export const STRATA = ['enriched', 'control', 'unselected-prior'];
const FLOORS = { rows: 100, prs: 30, perClass: 20 };
const MAX_TAIL = 16000;

const text = value => typeof value === 'string' && value.trim().length > 0;
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`invalid timestamp ${value}`);
  return Date.parse(value);
};

// Escape-heavy logs serialize to up to 6 bytes per character, so the tail also keeps the
// whole decide() input under a byte ceiling below the 64 KiB runtime limit.
const MAX_INPUT_BYTES = 60000;
const inputBytes = tail => Buffer.byteLength(JSON.stringify({ phase: 'ci', attempt: 2, failure_tail: tail }));

export function failureTail(log, limit = MAX_TAIL, maxBytes = MAX_INPUT_BYTES) {
  const lines = log.split(/\r?\n/);
  let end = lines.findLastIndex(line => line.includes('##[error]'));
  const tail_rule = end === -1 ? 'log-end' : 'last-error';
  if (end === -1) { end = lines.length - 1; while (end > 0 && lines[end] === '') end--; }
  let start = end, size = lines[end].length;
  while (start > 0 && size + 1 + lines[start - 1].length <= limit) size += 1 + lines[--start].length;
  while (start < end && inputBytes(lines.slice(start, end + 1).join('\n')) > maxBytes) start++;
  let tail = lines.slice(start, end + 1).join('\n');
  if (tail.length > limit) tail = tail.slice(-limit);
  while (tail.length > 0 && inputBytes(tail) > maxBytes) tail = tail.slice(Math.ceil(tail.length / 10));
  return { failure_tail: tail, tail_rule, tail_line_range: [start + 1, end + 1] };
}

export function retryRow(packet, label, tail, { cohort, selection_stratum }) {
  if (!ACTIONS.includes(label)) throw new Error(`invalid label ${label}`);
  if (!STRATA.includes(selection_stratum)) throw new Error(`invalid stratum ${selection_stratum}`);
  const attempt = packet.within_run_consecutive_failures;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt >= 3) throw new Error('cap_determined or invalid counter');
  return { id: packet.id, step: 'retry', repo: packet.repo, pr: packet.pr, head_sha: packet.execution_sha, source: packet.source,
    visibility: 'public', selection_stratum, cohort, tail_rule: tail.tail_rule, tail_line_range: tail.tail_line_range,
    input: { phase: 'ci', attempt, failure_tail: tail.failure_tail }, label, label_source: 'ai-annotation-verified', labeled_before_replay: true };
}

function checkSidecar(row, record, actorKey, status, timeKey, frozen, sealed) {
  if (!record) throw new Error(`missing ${actorKey} sidecar for ${row.id}`);
  if (record.id !== row.id || record.head_sha !== row.head_sha) throw new Error(`sidecar identity differs for ${row.id}`);
  if (record.label !== row.label) throw new Error(`sidecar label differs for ${row.id}`);
  if (!text(record[actorKey]) || record.status !== status) throw new Error(`invalid ${actorKey} status for ${row.id}`);
  if (record.blind_to_predictions !== true || record.inspection_complete !== true || !text(record.rationale) ||
      !Array.isArray(record.evidence) || record.evidence.length === 0) throw new Error(`incomplete inspection for ${row.id}`);
  if (!ACTIONS.every(action => text(record.per_action_reasons?.[action]))) throw new Error(`per_action_reasons incomplete for ${row.id}`);
  if (typeof record.tail_sufficient !== 'boolean') throw new Error(`tail_sufficient missing for ${row.id}`);
  const at = time(record[timeKey]);
  if (at <= frozen) throw new Error(`label precedes frozen packet for ${row.id}`);
  if (at >= sealed) throw new Error(`label follows seal for ${row.id}`);
}

export function validateSeal({ rows, annotations, verification, unknown, times }) {
  const frozen = time(times.packet_frozen_at), sealed = time(times.sealed_at);
  const byId = list => new Map(list.map(item => [item.id, item]));
  const am = byId(annotations), vm = byId(verification), ids = new Set(), prs = new Set();
  for (const [name, list] of [['annotations', annotations], ['verification', verification], ['unknown', unknown]])
    if (new Set(list.map(item => item.id)).size !== list.length) throw new Error(`duplicate id in ${name}`);
  const spelling = new Map();
  for (const item of [...rows, ...unknown]) {
    const seen = spelling.get(String(item.repo).toLowerCase());
    if (seen && seen !== item.repo) throw new Error(`repository spelling differs: ${seen} and ${item.repo}`);
    spelling.set(String(item.repo).toLowerCase(), item.repo);
  }
  if (am.size !== rows.length || vm.size !== rows.length || annotations.length !== rows.length || verification.length !== rows.length) throw new Error('sidecar coverage differs');
  const classes = Object.fromEntries(ACTIONS.map(a => [a, 0])), strata = Object.fromEntries(STRATA.map(s => [s, 0])), cohorts = {};
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`duplicate id ${row.id}`);
    const pr = `${row.repo}#${row.pr}`.toLowerCase();
    if (prs.has(pr)) throw new Error(`more than one case for PR ${pr}`);
    ids.add(row.id); prs.add(pr);
    if (row.step !== 'retry' || !/^[\w.-]+\/[\w.-]+$/.test(row.repo) || !Number.isInteger(row.pr) || row.pr < 1 || !/^[0-9a-f]{40}$/.test(row.head_sha) ||
        !row.source?.startsWith(`https://github.com/${row.repo}/`) || row.visibility !== 'public' || !text(row.cohort) ||
        !STRATA.includes(row.selection_stratum) || !['last-error', 'log-end'].includes(row.tail_rule) || row.tail_line_range?.length !== 2 ||
        !ACTIONS.includes(row.label) || row.label_source !== 'ai-annotation-verified' || row.labeled_before_replay !== true) throw new Error(`invalid row ${row.id}`);
    const keys = Object.keys(row.input ?? {}).sort();
    if (keys.join() !== 'attempt,failure_tail,phase' || row.input.phase !== 'ci' || ![1, 2].includes(row.input.attempt) ||
        !text(row.input.failure_tail) || row.input.failure_tail.length > MAX_TAIL || Buffer.byteLength(JSON.stringify(row.input)) >= 65536) throw new Error(`invalid input for ${row.id}`);
    const tail = row.input.failure_tail.split('\n').filter(line => line.trim() !== '');
    const [first, last] = row.tail_line_range;
    if (row.tail_rule === 'last-error' ? !tail.at(-1)?.includes('##[error]') : row.input.failure_tail.includes('##[error]')) throw new Error(`tail rule inconsistent for ${row.id}`);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || tail.length > last - first + 1) throw new Error(`tail line range inconsistent for ${row.id}`);
    const a = am.get(row.id), v = vm.get(row.id);
    checkSidecar(row, a, 'annotator', 'labeled', 'labeled_at', frozen, sealed);
    checkSidecar(row, v, 'verifier', 'agree', 'verified_at', frozen, sealed);
    if (time(v.verified_at) < time(a.labeled_at)) throw new Error(`verified_at precedes labeled_at for ${row.id}`);
    if (a.annotator === v.verifier) throw new Error(`annotator and verifier must be distinct for ${row.id}`);
    if (!Array.isArray(v.disagreements) || v.disagreements.length !== 0) throw new Error(`verifier disagreements for ${row.id}`);
    classes[row.label]++; strata[row.selection_stratum]++; cohorts[row.cohort] = (cohorts[row.cohort] ?? 0) + 1;
  }
  for (const item of unknown) {
    if (ids.has(item.id) || item.label !== null || !text(item.reason) || !text(item.repo) || !Number.isInteger(item.pr)) throw new Error(`invalid unknown entry ${item.id}`);
  }
  const counts = { rows: rows.length, prs: prs.size, classes, unknown: unknown.length, strata, cohorts };
  const gaps = { rows: Math.max(0, FLOORS.rows - counts.rows), prs: Math.max(0, FLOORS.prs - counts.prs),
    ...Object.fromEntries(ACTIONS.map(a => [a, Math.max(0, FLOORS.perClass - classes[a])])) };
  return { counts, gaps, floors_met: Object.values(gaps).every(g => g === 0),
    repositories: [...new Set(rows.map(r => r.repo))].sort() };
}
