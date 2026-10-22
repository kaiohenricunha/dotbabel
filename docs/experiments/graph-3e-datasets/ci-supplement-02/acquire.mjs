import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectPublicRuns, verifyPublicArchive } from './public-actions.mjs';
import { scrub } from './prepare.mjs';
import { structuredScrub, selectCandidates, screenLog, duplicateHistory, prepareArchiveRoot, discoveryQueries, controlFailure, controlOrder, transientFetchError, continueControl } from './collection-lib.mjs';

const root = process.env.COHORT_ROOT;
if (!root) throw new Error('Set COHORT_ROOT to the private cohort directory');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'collection-contract.json')));
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const load = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const save = (file, value) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};
let actualRequests = 0;
const cache = new Map();
async function get(endpoint, useCache = false) {
  if (endpoint !== 'rate_limit' && !/^repos\/[\w.-]+\/[\w.-]+(?:$|[/?])/.test(endpoint)) throw new Error('Unexpected read endpoint');
  if (useCache && cache.has(endpoint)) return cache.get(endpoint);
  const promise = fetchWithRetry(endpoint);
  if (useCache) cache.set(endpoint, promise);
  try { return await promise; }
  catch (error) { cache.delete(endpoint); throw error; }
}

// A failed fetch is not evidence about the CI failure, so transient refusals wait and retry.
// The job-log endpoint can report its own exhausted limit while /rate_limit still shows quota,
// so a refusal pauses every worker until that endpoint's own X-Ratelimit-Reset.
let pausedUntil = 0;
async function endpointReset(endpoint) {
  try { await execute('gh', ['api', '-i', '--method', 'GET', endpoint], { encoding: 'utf8', timeout: 45000, maxBuffer: 64 * 1024 * 1024 }); return 0; }
  catch (error) { const match = /x-ratelimit-reset:\s*(\d+)/i.exec(String(error.stdout ?? '')); return match ? Number(match[1]) * 1000 : Date.now() + 120000; }
}
async function fetchWithRetry(endpoint) {
  for (let attempt = 1, limited = 0; ; attempt++) {
    while (Date.now() < pausedUntil) await new Promise(resolve => setTimeout(resolve, Math.min(30000, pausedUntil - Date.now() + 100)));
    if (++actualRequests > contract.maximum_api_gets) throw new Error('Fixed API GET budget exhausted');
    if (endpoint !== 'rate_limit' && actualRequests % 25 === 0) await waitForQuota();
    try {
      return (await execute('gh', ['api', '--method', 'GET', endpoint], { encoding: 'buffer', timeout: 45000, maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (error) {
      const message = scrub(String(error.stderr || error.message)).slice(0, 1000);
      if (/rate limit/i.test(message) && ++limited <= 12) {
        const until = (await endpointReset(endpoint)) + 30000;
        if (until > pausedUntil) { pausedUntil = until; console.log(JSON.stringify({ phase: 'rate-limit-pause', endpoint: endpoint.replace(/\/\d+\/logs$/, '/<job>/logs'), resume_at: new Date(until).toISOString() })); }
        attempt--; continue;
      }
      if (attempt >= 5 || !transientFetchError(message)) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 5000 * 2 ** attempt));
    }
  }
}

// Waiting for the hourly reset keeps rate-limit refusals from being recorded as evidence gaps.
let quotaCheck = null;
async function waitForQuota(limited = false) {
  quotaCheck ??= (async () => {
    const { stdout } = await execute('gh', ['api', 'rate_limit'], { encoding: 'utf8', timeout: 45000 });
    const core = JSON.parse(stdout).resources.core;
    if (core.remaining < contract.quota_floor || (limited && core.remaining < 1000)) {
      const wait = Math.max(0, core.reset * 1000 - Date.now()) + 30000;
      console.log(JSON.stringify({ phase: 'quota-wait', remaining: core.remaining, wait_seconds: Math.round(wait / 1000) }));
      await new Promise(resolve => setTimeout(resolve, wait));
    } else if (limited) await new Promise(resolve => setTimeout(resolve, 90000)); // secondary limit

  })().finally(() => { quotaCheck = null; });
  return quotaCheck;
}

async function workers(items, handler) {
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < items.length) { const index = next++; await handler(items[index], index); }
  }));
}

async function discover() {
  if (fs.existsSync(path.join(root, 'candidate-runs.json'))) throw new Error('Discovery already frozen; do not overwrite');
  const rate = JSON.parse(await get('rate_limit')).resources.core;
  if (rate.remaining < 1000) throw new Error(`Insufficient API quota: ${rate.remaining}`);
  save('initial-rate-limit.json', rate);
  const queries = discoveryQueries(contract);
  const documents = [], records = [];
  await workers(queries, async query => {
    const { repo, repository_index, status, slice, created } = query;
    const params = new URLSearchParams({ event: 'pull_request', status, created, per_page: String(contract.discovery.per_query) });
    const endpoint = `repos/${repo}/actions/runs?${params}`;
    const file = `discovery/${String(repository_index).padStart(3, '0')}-${repo.replace('/', '--')}-${status}-w${slice}.json`;
    const row = { repo, repository_index, status, slice, created, endpoint, path: file, fetched_at: new Date().toISOString() };
    try {
      const raw = await get(endpoint);
      const data = JSON.parse(raw);
      const retained = Buffer.from(JSON.stringify(structuredScrub(data)) + '\n');
      save(file, retained);
      Object.assign(row, { ok: true, source_sha256: hash(raw), sha256: hash(retained), bytes: retained.length,
        advertised_runs: data.total_count, inspected_runs: data.workflow_runs.length });
      documents.push({ ...query, path: file, data });
    } catch (error) { Object.assign(row, { ok: false, error: error.message }); }
    records.push(row);
    if (records.length % 40 === 0) console.log(JSON.stringify({ phase: 'discovery', finished: records.length, total: queries.length, api_gets: actualRequests }));
  });
  if (!documents.length) throw new Error('No successful discovery GETs; network access may be blocked');
  const candidates = selectCandidates(documents, contract);
  save('candidate-runs.json', candidates);
  save('discovery-report.json', { api_gets: actualRequests, queries: records.sort((a, b) => a.repository_index - b.repository_index || a.status.localeCompare(b.status) || a.slice - b.slice),
    candidates: candidates.length, repositories: new Set(candidates.map(c => c.repo)).size,
    final_success_discovery_candidates: candidates.filter(c => c.discovery_final_conclusion === 'success').length,
    selection_limit: 'Final outcomes and signature hints are acquisition-only. This enriched cohort cannot estimate population prevalence.' });
  console.log(JSON.stringify({ complete: true, phase: 'discovery', api_gets: actualRequests, candidates: candidates.length, repositories: new Set(candidates.map(c => c.repo)).size }));
}

async function context(candidate, failure, slug) {
  const evidence = [];
  const endpoints = [`repos/${candidate.repo}/commits/${failure.head_sha}`, `repos/${candidate.repo}/contents/${failure.workflow_path}?ref=${failure.head_sha}`];
  for (const [index, endpoint] of endpoints.entries()) {
    const raw = await get(endpoint, true), doc = JSON.parse(raw);
    const file = `context/${slug}/${index === 0 ? 'execution-commit.json' : 'workflow-source.json'}`;
    if (index === 0 && doc.sha !== failure.head_sha) throw new Error('Execution commit identity mismatch');
    const body = Buffer.from(JSON.stringify(structuredScrub(doc), null, 2) + '\n');
    save(file, body);
    const row = { endpoint, path: file, source_sha256: hash(raw), sha256: hash(body), redacted: !raw.equals(body), fetched_at: new Date().toISOString() };
    if (index === 1) {
      if (doc.encoding !== 'base64' || typeof doc.content !== 'string') throw new Error('Workflow contents unavailable');
      const source = Buffer.from(doc.content, 'base64');
      const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${source.length}\0`), source])).digest('hex');
      if (blob !== doc.sha) throw new Error('Workflow blob SHA mismatch');
      const retained = Buffer.from(scrub(source.toString('utf8'))), decoded = `context/${slug}/workflow.yml`;
      save(decoded, retained);
      Object.assign(row, { git_blob_sha: blob, decoded_path: decoded, decoded_source_sha256: hash(source), decoded_retained_sha256: hash(retained), decoded_redacted: !source.equals(retained) });
    }
    evidence.push(row);
  }
  save(`context/${slug}/evidence.json`, evidence);
  return evidence;
}

async function collect() {
  if (fs.existsSync(path.join(root, 'collection-results.json'))) throw new Error('Collection already complete; do not overwrite');
  const discovery = load('discovery-report.json');
  actualRequests = discovery.api_gets + (fs.existsSync(path.join(root, 'failed-local-setup/audit.json')) ? 1 : 0);
  prepareArchiveRoot(root);
  const candidates = load('candidate-runs.json');
  const rate = JSON.parse(await get('rate_limit')).resources.core;
  save('collection-start-rate-limit.json', rate);
  if (rate.remaining < 1000) throw new Error(`Insufficient API quota: ${rate.remaining}`);
  const all = [];
  await workers(candidates, async (candidate, index) => {
    const slug = `${String(index + 1).padStart(3, '0')}-${candidate.repo.replace('/', '--')}-${candidate.run_id}`;
    const traceDir = path.join(root, 'traces', slug);
    const result = { index, candidate, trace_path: `traces/${slug}`, status: 'pending' };
    try {
      const manifest = fs.existsSync(path.join(traceDir, 'manifest.json')) ? verifyPublicArchive(traceDir)
        : await collectPublicRuns({ page_size: 100, max_pages: 20, max_attempts: contract.discovery.max_native_attempts, recover_pr_anchors: true,
          runs: [{ repo: candidate.repo, run_id: candidate.run_id }] }, traceDir,
        endpoint => get(endpoint, !endpoint.endsWith('/logs')));
      result.trace_complete = manifest.traces[0].complete;
      result.issues = manifest.traces[0].issues;
      result.archived_failure_jobs = manifest.failures.length;
      const sourceByPath = new Map(manifest.sources.map(source => [source.path, source]));
      const failures = [];
      result.screened_failures = [];
      for (const failure of manifest.failures) {
        if (failure.pr !== candidate.pr || ![1, 2].includes(failure.within_run_consecutive_failures)) continue;
        const history = failure.history.map(state => ({ ...state, log_sha256: sourceByPath.get(state.log_ref)?.sha256 }));
        const duplicated = duplicateHistory(history);
        const future = history.some(state => state.completed_at > history.at(-1).completed_at);
        const text = fs.readFileSync(path.join(traceDir, failure.log_ref), 'utf8');
        const hints = screenLog(text);
        const info = { id: failure.id, counter: failure.within_run_consecutive_failures, duplicated_history: duplicated, noncausal_history_order: future, ...hints };
        result.screened_failures.push(info);
        if (!duplicated && !future && Math.max(hints.owner_score, hints.retry_score) >= contract.screening.min_hint_score) failures.push({ failure, hints });
      }
      failures.sort((a, b) => Math.max(b.hints.owner_score, b.hints.retry_score) - Math.max(a.hints.owner_score, a.hints.retry_score)
        || a.failure.native_attempt - b.failure.native_attempt || hash(a.failure.id).localeCompare(hash(b.failure.id)));
      if (!result.trace_complete) result.status = 'excluded-incomplete-evidence';
      else if (!failures.length) result.status = 'retained-no-strong-diagnostic-hint';
      else {
        const selected = failures[0];
        result.selected_failure = selected.failure;
        result.acquisition_hints = selected.hints;
        result.context = await context(candidate, selected.failure, slug);
        result.status = 'evidence-ready-unlabeled';
      }
    } catch (error) { result.status = 'excluded-error'; result.error = scrub(error.message).slice(0, 1200); }
    all.push(result);
    save('collection-progress.json', { finished: all.length, total: candidates.length, api_gets: actualRequests,
      ready: all.filter(r => r.status === 'evidence-ready-unlabeled').length, results: [...all].sort((a, b) => a.index - b.index) });
    console.log(JSON.stringify({ phase: 'collection', finished: all.length, total: candidates.length, repo: candidate.repo, pr: candidate.pr, status: result.status,
      ready: all.filter(r => r.status === 'evidence-ready-unlabeled').length, api_gets: actualRequests }));
  });
  save('collection-results.json', all.sort((a, b) => a.index - b.index));
  save('collection-totals.json', { completed: all.length, candidates: candidates.length, api_gets: actualRequests,
    ready: all.filter(r => r.status === 'evidence-ready-unlabeled').length, labels_assigned: 0, external_writes: 0 });
  console.log(JSON.stringify({ complete: true, phase: 'collection', candidates: candidates.length, ready: all.filter(r => r.status === 'evidence-ready-unlabeled').length, api_gets: actualRequests }));
}

// control [amendment] [output] [earlier control results...]: draw a control sample in the amendment-01 hash order.
async function control(amendmentFile = 'contract-amendment-01.json', outputFile = 'control-results.json', ...earlier) {
  if (fs.existsSync(path.join(root, outputFile))) throw new Error('Control sample already frozen; do not overwrite');
  const amendment = load(amendmentFile).control_sample;
  const chosenIds = new Set(earlier.flatMap(file => load(file).chosen.map(c => c.selected_failure.id)));
  const results = load('collection-results.json');
  actualRequests = load('collection-totals.json').api_gets;
  const entries = [];
  for (const result of results) {
    if (result.status !== 'retained-no-strong-diagnostic-hint' || !result.trace_complete) continue;
    const manifest = verifyPublicArchive(path.join(root, result.trace_path));
    const screened = Object.fromEntries(result.screened_failures.map(item => [item.id, item]));
    const failures = manifest.failures.map(f => ({ ...f, completed_at: f.history.at(-1).completed_at }));
    const failure = controlFailure(failures, result.candidate.pr, screened);
    if (failure) entries.push({ id: failure.id, index: result.index, failure });
  }
  const chosen = [], skipped = [];
  for (const entry of continueControl(entries, 'control-01:', chosenIds)) {
    if (chosen.length >= amendment.size) break;
    const result = results[entry.index];
    const slug = path.basename(result.trace_path);
    try { chosen.push({ index: entry.index, candidate: result.candidate, trace_path: result.trace_path, selected_failure: entry.failure,
      context: await context(result.candidate, entry.failure, slug), status: 'evidence-ready-unlabeled', selection_stratum: 'control' }); }
    catch (error) { skipped.push({ index: entry.index, id: entry.id, error: scrub(error.message).slice(0, 600) }); }
  }
  save(outputFile, { amendment_file: amendmentFile, amendment_sha256: hash(fs.readFileSync(path.join(root, amendmentFile))),
    excluded_earlier: [...chosenIds], eligible: entries.length, chosen, skipped, api_gets: actualRequests });
  console.log(JSON.stringify({ complete: true, phase: 'control', eligible: entries.length, chosen: chosen.length, skipped: skipped.length, api_gets: actualRequests }));
}

try {
  const command = process.argv[2];
  if (command === 'discover') await discover();
  else if (command === 'collect') await collect();
  else if (command === 'control') await control(...process.argv.slice(3));
  else throw new Error('usage: acquire.mjs discover|collect|control');
} catch (error) { console.error(scrub(error.message)); process.exitCode = 1; }
