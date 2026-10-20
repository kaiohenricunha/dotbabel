// node check-batch.mjs <workspace> <NN> <dispatched_at> <returned_at>: validate one reviewer batch output.
import fs from 'node:fs';
import path from 'node:path';
import { checkReview } from './review-check.mjs';

const [workspace, batch, dispatched, returned] = process.argv.slice(2);
const entries = JSON.parse(fs.readFileSync(path.join(workspace, `batch-${batch}.json`), 'utf8'));
const out = path.join(workspace, 'out', `batch-${batch}.jsonl`);
const records = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const byId = new Map(records.map(r => [r.id, r]));
const report = { batch, workspace: path.basename(workspace), expected: entries.length, records: records.length, missing: [], duplicates: records.length - byId.size, problems: {}, actions: {} };
const from = Date.parse(dispatched), to = Date.parse(returned);
for (const { id, input_dir } of entries) {
  const review = byId.get(id);
  if (!review) { report.missing.push(id); continue; }
  const line = fs.readFileSync(path.join(input_dir, 'packets.jsonl'), 'utf8').split('\n').find(l => l.includes(`"id": ${JSON.stringify(id)}`));
  const problems = checkReview(review, JSON.parse(line), input_dir);
  const at = Date.parse(review.reviewed_at);
  if (!Number.isFinite(at) || at < from || at > to) problems.push('reviewed_at outside the batch window');
  if (problems.length) report.problems[id] = problems;
  report.actions[review.recommended_action] = (report.actions[review.recommended_action] ?? 0) + 1;
}
console.log(JSON.stringify(report, null, 1));
process.exitCode = report.missing.length || Object.keys(report.problems).length || report.duplicates ? 1 : 0;
