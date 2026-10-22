// node blind-audit.mjs <tasks_dir>: flag verifier tool calls that touch annotator outputs or shared scratch files.
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.COHORT_ROOT;
if (!root) throw new Error('Set COHORT_ROOT to the private cohort directory');
const tasks = process.argv[2];
const log = fs.readFileSync(path.join(root, process.env.REVIEW_DIR ?? 'review', 'batch-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const runs = log.filter(e => e.role === 'verifier' && e.status === 'accepted');
const forbidden = [/review2?\/ws-a\b/, /review\/ws-b\b/, /quarantine-scratch/, /tails-coordinator|cohort-map|batch-log|packet-index|control-results|collection-results|acquisition_hints/,
  /graph-3e-datasets\/2026-10-1[89]/, /codex-handover/, /\/scratchpad\b/];
const report = [];
for (const run of runs) {
  const file = path.join(tasks, `${run.agent}.output`);
  if (!fs.existsSync(file)) { report.push({ batch: run.batch, agent: run.agent, status: 'transcript missing' }); continue; }
  const hits = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part.type !== 'tool_use') continue;
      const input = JSON.stringify(part.input);
      for (const pattern of forbidden) if (pattern.test(input)) hits.push({ tool: part.name, pattern: String(pattern), input: input.slice(0, 240) });
    }
  }
  report.push({ batch: run.batch, agent: run.agent, status: hits.length ? 'review' : 'clean', hits });
}
console.log(JSON.stringify(report, null, 1));
