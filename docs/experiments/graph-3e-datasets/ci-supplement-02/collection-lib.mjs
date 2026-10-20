import { scrub } from './prepare.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function prepareArchiveRoot(root) {
  for (const directory of ['traces', 'context']) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
}

export function structuredScrub(value) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(structuredScrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structuredScrub(item)]));
  return value;
}

export function selectCandidates(documents, contract) {
  const excluded = new Set(contract.excluded_repository_prs.map(s => s.toLowerCase()));
  const repositories = new Map();
  for (const document of documents) {
    for (const run of document.data?.workflow_runs ?? []) {
      const repo = run.repository?.full_name;
      if (typeof repo !== 'string' || repo.toLowerCase() !== document.repo.toLowerCase() || run.repository.private !== false ||
          run.event !== 'pull_request' || run.status !== 'completed' || !['failure', 'success'].includes(run.conclusion) ||
          !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || run.run_attempt > contract.discovery.max_native_attempts ||
          (run.conclusion === 'success' && run.run_attempt === 1) ||
          !(contract.window_start <= run.created_at && run.created_at <= contract.window_end)) continue;
      const anchors = (run.pull_requests ?? []).filter(p => Number.isSafeInteger(p.number) && p.number > 0 &&
        p.url === `https://api.github.com/repos/${repo}/pulls/${p.number}` && p.base?.repo?.url === `https://api.github.com/repos/${repo}` &&
        /^[a-f0-9]{40}$/.test(p.head?.sha ?? ''));
      if (anchors.length !== 1 || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) continue;
      const pr = anchors[0].number, key = `${repo}#${pr}`.toLowerCase();
      if (excluded.has(key)) continue;
      if (!repositories.has(document.repository_index)) repositories.set(document.repository_index, new Map());
      const bucket = repositories.get(document.repository_index);
      const row = { repo, run_id: run.id, pr, head_sha: run.head_sha, pr_head_sha: anchors[0].head.sha,
        native_attempt: run.run_attempt, created_at: run.created_at, workflow_path: run.path,
        discovery_final_conclusion: run.conclusion, repository_index: document.repository_index,
        discovery_source: document.path };
      const before = bucket.get(key);
      if (!before || row.native_attempt > before.native_attempt ||
          (row.native_attempt === before.native_attempt && row.created_at > before.created_at)) bucket.set(key, row);
    }
  }
  const buckets = [...repositories].sort(([a], [b]) => a - b).map(([, rows]) => [...rows.values()]
    .sort((a, b) => b.native_attempt - a.native_attempt || b.created_at.localeCompare(a.created_at) || a.run_id - b.run_id));
  const selected = [];
  for (let round = 0; round < Math.max(0, ...buckets.map(b => b.length)); round++) {
    for (const bucket of buckets) if (round < bucket.length && selected.length < contract.discovery.max_candidates) selected.push(bucket[round]);
  }
  return selected;
}

const signals = [
  ['owner', 5, /insufficient_quota|credit balance.{0,70}(?:low|insufficient)|(?:credit|budget|quota).{0,65}(?:exceeded|exhausted)|billing.{0,65}(?:limit|disabled)|account.{0,65}(?:suspended|deactivated)/i],
  ['owner', 4, /(?:api.?key|access.?token|credential|secret|password).{0,90}(?:is required|are required|missing|not (?:set|provided|found|configured)|expired|revoked)|(?:requires?|must provide|please provide).{0,70}(?:api.?key|access.?token|credentials)|(?:token|credential).{0,40}(?:expired|revoked)/i],
  ['owner', 2, /Resource not accessible by integration|(?:organization|repository).{0,60}(?:approval|policy)|(?:permission|access).{0,45}(?:denied|forbidden)|(?:401 Unauthorized|403 Forbidden|Bad credentials)/i],
  ['retry', 4, /(?:HTTP\S*[: ]+|status(?: code)?[: ]+|response[: ]+|returned[: ]+)(?:500|502|503|504)\b|\b(?:500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b|temporarily unavailable|internal server error|INTERNAL_ERROR.{0,40}received from peer|hosted runner encountered an error|runner has received a shutdown signal/i],
  ['retry', 3, /\b(?:ECONNRESET|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED)\b/],
  ['retry', 3, /Connection reset by peer|remote end closed connection|connection was reset|runner.{0,70}lost communication|service.{0,40}unavailable|(?:HTTP|status).{0,20}429\b|\bToo Many Requests\b|Could not resolve host|TLS handshake timeout|\bi\/o timeout|Failed to download action/i],
];

// Test-runner progress lines name test cases; signal words there describe tests, not this failure.
const testOutput = /✓|✔|\bPASS(?:ED)?\b|\bSKIP(?:PED)?\b|^\s*ok \d+ |=== RUN|# Subtest:|@pytest\.mark|\bskipif\b/;
const timestamp = /^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/;
const WINDOW_LINES = 300;

export function screenLog(text) {
  const result = { owner_score: 0, retry_score: 0, matches: [] };
  const lines = text.split(/\r?\n/);
  const firstRun = lines.findIndex(line => line.replace(timestamp, '').startsWith('##[group]Run '));
  const setupEnd = firstRun === -1 ? 0 : firstRun;
  const errors = lines.flatMap((line, index) => line.includes('##[error]') ? [index] : []);
  const nearError = index => errors.some(error => index <= error && error - index <= WINDOW_LINES);
  for (const [index, original] of lines.entries()) {
    const line = original.replace(/\x1b\[[0-9;]*m/g, '');
    const decision = index < setupEnd || index >= lines.length - WINDOW_LINES || nearError(index);
    if (!decision || testOutput.test(line)) continue;
    for (const [kind, score, expression] of signals) if (expression.test(line)) {
      result[`${kind}_score`] = Math.max(result[`${kind}_score`], score);
      if (result.matches.length < 20) result.matches.push({ kind, score, line_start: index + 1, line_end: index + 1, quote: original });
    }
  }
  return result;
}

export function runContext(attempt, jobsPage, jobId) {
  const job = (jobsPage?.jobs ?? []).find(item => item.id === jobId);
  if (!job) throw new Error(`Decision-time record lacks job ${jobId}`);
  const base = attempt.repository?.full_name ?? null, head = attempt.head_repository?.full_name ?? null;
  return { event: attempt.event, base_repository: base, head_repository: head,
    head_repository_is_fork: base && head ? base.toLowerCase() !== head.toLowerCase() : null,
    failed_steps: (job.steps ?? []).filter(step => step.conclusion === 'failure').map(step => step.name) };
}

export function discoveryQueries(contract) {
  const slices = [], step = contract.discovery.slice_days * 86400000, end = Date.parse(contract.window_end);
  const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
  for (let start = Date.parse(contract.window_start); start < end; start += step) slices.push(`${iso(start)}..${iso(Math.min(start + step, end))}`);
  return contract.repositories.flatMap((repo, repository_index) => contract.discovery.statuses.flatMap(status =>
    slices.map((created, slice) => ({ repo, repository_index, status, slice, created }))));
}

export function duplicateHistory(history) {
  return history.some((item, index) => history.slice(0, index).some(previous =>
    previous.job_id !== item.job_id && previous.completed_at === item.completed_at &&
    previous.log_sha256 && previous.log_sha256 === item.log_sha256));
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

// Control cases: no diagnostic hint is used, so they sample everyday failures for comparison.
export function controlFailure(failures, pr, screenedById) {
  const eligible = failures.filter(f => f.pr === pr && [1, 2].includes(f.within_run_consecutive_failures) &&
    screenedById[f.id] && !screenedById[f.id].duplicated_history && !screenedById[f.id].noncausal_history_order);
  eligible.sort((a, b) => a.completed_at.localeCompare(b.completed_at) || sha256(a.id).localeCompare(sha256(b.id)));
  return eligible[0] ?? null;
}

export function controlOrder(entries, salt) {
  return [...entries].sort((a, b) => sha256(salt + a.id).localeCompare(sha256(salt + b.id)));
}

// 404 and 410 mean the evidence is gone; these are failures of the fetch itself.
export function transientFetchError(text) {
  if (/HTTP 410|HTTP 404|Not Found/.test(text)) return false;
  return /rate limit|HTTP 5\d\d|stream error|CANCEL|couldn't respond to your request in time|ETIMEDOUT|ECONNRESET|timed out/i.test(text);
}

// A later draw keeps the earlier order, so the combined sample equals one longer draw.
export function continueControl(entries, salt, chosenIds) {
  return controlOrder(entries, salt).filter(entry => !chosenIds.has(entry.id));
}
