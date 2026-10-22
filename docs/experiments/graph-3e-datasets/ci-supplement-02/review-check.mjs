// Checks one blind review record against its frozen packet and the cohort input files.
import fs from 'node:fs';
import path from 'node:path';

const ACTIONS = ['retry', 'fix', 'ask-owner', 'unknown'];
const text = value => typeof value === 'string' && value.trim().length > 0;

export function rebuildCounter(history) {
  let count = 0;
  for (const { conclusion } of history) {
    if (conclusion === 'failure' || conclusion === 'timed_out') count++;
    else if (conclusion === 'success') count = 0;
  }
  return count;
}

export function checkReview(review, packet, inputDir) {
  const problems = [];
  if (review.id !== packet.id) problems.push('id differs');
  if (!ACTIONS.includes(review.recommended_action)) problems.push('invalid action');
  if (review.counter !== rebuildCounter(packet.history) || review.counter !== packet.within_run_consecutive_failures) problems.push('counter differs');
  if (!text(review.rationale)) problems.push('rationale empty');
  if (review.inspection_complete !== true || review.blind_to_predictions !== true) problems.push('inspection or blindness flag');
  if (typeof review.tail_sufficient !== 'boolean') problems.push('tail_sufficient missing');
  if (!['retry', 'fix', 'ask-owner'].every(a => text(review.per_action_reasons?.[a]))) problems.push('per_action_reasons incomplete');
  if (review.recommended_action === 'unknown' && !(Array.isArray(review.missing_evidence) && review.missing_evidence.length)) problems.push('missing_evidence empty for unknown');
  const evidence = Array.isArray(review.evidence) ? review.evidence : [];
  // The brief asks for "the counter field citation" without a path; the counter is rebuilt from history, so either field counts.
  if (!evidence.some(e => e.kind === 'field' && /^(?:\$\.)?(?:within_run_consecutive_failures|history)\b/.test(e.field_path ?? ''))) problems.push('counter field citation missing');
  const quoted = evidence.filter(e => e.kind === 'log' || e.kind === 'context');
  if (!quoted.length) problems.push('no log or context quote');
  // Evidence must come from this packet's own files, so a record cannot borrow another case's quotes.
  const own = new Set([packet.failure_log?.path, ...(packet.history ?? []).map(h => h.failure_log?.path), ...(packet.source_context ?? []).map(c => c.path)].filter(Boolean));
  for (const e of quoted) {
    if (!own.has(e.path)) { problems.push(`evidence path not referenced by this packet: ${e.path}`); continue; }
    const file = path.resolve(inputDir, e.path ?? '');
    if (!file.startsWith(path.resolve(inputDir) + path.sep) || !fs.existsSync(file)) { problems.push(`bad evidence path ${e.path}`); continue; }
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    if (!Number.isInteger(e.line_start) || !Number.isInteger(e.line_end) || e.line_start < 1 || e.line_end < e.line_start ||
        lines.slice(e.line_start - 1, e.line_end).join('\n') !== e.quote) problems.push(`quote differs at ${e.path}:${e.line_start}`);
  }
  return problems;
}
