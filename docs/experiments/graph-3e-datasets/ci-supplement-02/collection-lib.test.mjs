import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates, screenLog, structuredScrub, duplicateHistory, prepareArchiveRoot, runContext, discoveryQueries, controlFailure, controlOrder, transientFetchError, continueControl } from './collection-lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectPublicRuns } from './public-actions.mjs';

test('structured redaction keeps escaped quotes valid and removes token strings', () => {
  const value = { message: 'TOKEN="sensitive" and quoted "text"', nested: ['ghp_1234567890123456789012345'] };
  const result = JSON.parse(JSON.stringify(structuredScrub(value)));
  assert.equal(result.message.includes('sensitive'), false);
  assert.equal(result.nested[0], '[REDACTED]');
  assert.equal(result.message.includes('quoted "text"'), true);
});

test('screening distinguishes hints from labels and keeps exact line evidence', () => {
  const text = 'hello\n##[error]HTTP 503 Service Unavailable\nbye';
  const result = screenLog(text);
  assert.ok(result.retry_score > 0);
  assert.equal(result.label, undefined);
  assert.ok(result.matches.some(m => m.line_start === 2 && m.quote === text.split('\n')[1]));
  assert.ok(screenLog('Error: Your credit balance is too low').owner_score > 0);
  assert.equal(screenLog('test timed out').retry_score, 0);
  assert.equal(screenLog('export API_KEY=***').owner_score, 0);
});

test('duplicate logs with equal completion timestamps require quarantine', () => {
  const a = { job_id: 1, completed_at: 'one', log_sha256: 'same' };
  const b = { job_id: 2, completed_at: 'one', log_sha256: 'same' };
  assert.equal(duplicateHistory([a, b]), true);
  assert.equal(duplicateHistory([a, { ...b, completed_at: 'two' }]), false);
});

test('selection excludes reused/private/foreign-anchor PRs and one-attempt successes', () => {
  const repo = 'org/repo';
  const run = { id: 1, repository: { full_name: repo, private: false },
    status: 'completed', conclusion: 'failure', run_attempt: 1, event: 'pull_request',
    head_sha: 'a'.repeat(40), created_at: '2026-10-18T01:00:00Z', path: '.github/workflows/test.yml',
    pull_requests: [{ number: 10, url: `https://api.github.com/repos/${repo}/pulls/10`,
      head: { sha: 'b'.repeat(40) }, base: { repo: { url: `https://api.github.com/repos/${repo}` } } }] };
  const contract = { window_start: '2026-10-05T00:00:00Z', window_end: '2026-10-19T00:00:00Z',
    excluded_repository_prs: [], discovery: { max_native_attempts: 8, max_candidates: 20 } };
  const pick = runs => selectCandidates([{ repo, repository_index: 0, data: { workflow_runs: runs } }], contract);
  assert.equal(pick([run]).length, 1);
  assert.equal(pick([run, { ...run, id: 2 }]).length, 1);
  assert.equal(pick([{ ...run, conclusion: 'success' }]).length, 0);
  assert.equal(pick([{ ...run, conclusion: 'success', run_attempt: 2 }]).length, 1);
  assert.equal(pick([{ ...run, repository: { full_name: repo, private: true } }]).length, 0);
  assert.equal(pick([{ ...run, pull_requests: [{ ...run.pull_requests[0], url: 'https://api.github.com/repos/other/repo/pulls/10' }] }]).length, 0);
  assert.equal(selectCandidates([{ repo, repository_index: 0, data: { workflow_runs: [run] } }], { ...contract, excluded_repository_prs: ['ORG/REPO#10'] }).length, 0);
});

test('archive setup creates the missing parent before native collection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-archive-setup-test-'));
  try {
    const target = path.join(root, 'traces', 'one');
    const config = { runs: [{ repo: 'org/repo', run_id: 1 }] };
    const fetcher = async () => Buffer.from(JSON.stringify({ private: true, full_name: 'org/repo' }));
    await assert.rejects(collectPublicRuns(config, target, fetcher), { code: 'ENOENT' });
    prepareArchiveRoot(root);
    const result = await collectPublicRuns(config, target, fetcher);
    assert.equal(result.traces[0].complete, false);
    assert.equal(fs.existsSync(path.join(target, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'context')), true);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('screening ignores signal words inside passing or skipped test output', () => {
  for (const line of [
    '@cline/shared test:      \u001b[33m\u001b[2m✓\u001b[22m stops retrying after the retry budget is exhausted 367ms',
    '        PASS [   0.005s] (8688/9523) ty::tests::credential_missing',
    'ok 11 - client-connection › TLS is enabled by default when apiKey is provided and tls is not',
    '=== RUN   TestSDConfig_Validation/api_key_missing_tenancy',
    '        SKIP [         ] uv::project run::run_remote 503 Service Unavailable',
    '        # Subtest: do not expose token being revoked',
    '  @pytest.mark.skipif(not os.environ.get("OPENAI_API_KEY"), reason="OPENAI_API_KEY not set")',
    '../tests/test_cli.py::TestExtensionsGitHubAccess::test_install_completes_when_the_api_quota_is_exhausted PASSED',
  ]) {
    const result = screenLog(line);
    assert.equal(result.owner_score + result.retry_score, 0, line);
  }
});

test('screening reads only decision lines: setup, error annotations, and the log tail', () => {
  const filler = Array.from({ length: 400 }, (_, i) => `2026-10-10T00:00:00Z step output ${i}`);
  const middle = [...filler.slice(0, 50), '##[group]Run npm test', ...filler.slice(50, 100), 'npm error code ECONNRESET', ...filler.slice(100)];
  assert.equal(screenLog(middle.join('\n')).retry_score, 0);
  const annotated = [...middle.slice(0, 120), '##[error]npm error code ECONNRESET', ...middle.slice(120)];
  assert.ok(screenLog(annotated.join('\n')).retry_score >= 3);
  const setup = ["##[warning]Failed to download action 'https://codeload.github.com/actions/checkout/tar.gz/abc'. Error: Response status code does not indicate success: 429 (Too Many Requests).", '##[group]Run actions/checkout@v4', ...filler];
  assert.ok(screenLog(setup.join('\n')).retry_score >= 3);
  const tail = [...filler, '##[group]Run make', 'Error: GCP_PROD_DB_ACCESS_CREDENTIALS environment variable is not set.'];
  assert.ok(screenLog(tail.join('\n')).owner_score >= 4);
});

test('screening recognises common transient infrastructure errors', () => {
  for (const line of [
    'fatal: unable to access \'https://github.com/org/repo/\': Could not resolve host: github.com',
    'npm error getaddrinfo ENOTFOUND registry.npmjs.org',
    'Get "https://proxy.golang.org/x/@v/list": net/http: TLS handshake timeout',
    'dial tcp 140.82.112.4:443: i/o timeout',
    '##[error]The hosted runner encountered an error while running your job.',
    '##[error]The runner has received a shutdown signal.',
    "##[warning]Failed to download action 'https://api.github.com/repos/actions/setup-node/tarball/v4'. Error: Response status code does not indicate success: 500",
  ]) assert.ok(screenLog(line).retry_score >= 3, line);
  assert.equal(screenLog('Error: Process completed with exit code 1.').retry_score, 0);
});

test('run context reports decision-time event, fork origin, and failed steps', () => {
  const attempt = { event: 'pull_request', repository: { full_name: 'org/repo' }, head_repository: { full_name: 'someone/repo' } };
  const jobs = { jobs: [
    { id: 5, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'failure' }, { name: 'Post', conclusion: 'skipped' }] },
    { id: 6, steps: [{ name: 'Other', conclusion: 'failure' }] }] };
  assert.deepEqual(runContext(attempt, jobs, 5), { event: 'pull_request', base_repository: 'org/repo', head_repository: 'someone/repo',
    head_repository_is_fork: true, failed_steps: ['Run tests'] });
  assert.equal(runContext({ ...attempt, head_repository: { full_name: 'org/repo' } }, jobs, 5).head_repository_is_fork, false);
  assert.equal(runContext({ ...attempt, head_repository: null }, jobs, 5).head_repository_is_fork, null);
  assert.throws(() => runContext(attempt, jobs, 7), /job 7/);
});

test('discovery queries slice the window weekly for every repository and status', () => {
  const contract = { repositories: ['a/b', 'c/d'], window_start: '2026-09-21T00:00:00Z', window_end: '2026-10-05T00:00:00Z',
    discovery: { statuses: ['failure', 'success'], slice_days: 7 } };
  const queries = discoveryQueries(contract);
  assert.equal(queries.length, 8);
  assert.deepEqual(queries[0], { repo: 'a/b', repository_index: 0, status: 'failure', slice: 0,
    created: '2026-09-21T00:00:00Z..2026-09-28T00:00:00Z' });
  assert.equal(queries.at(-1).created, '2026-09-28T00:00:00Z..2026-10-05T00:00:00Z');
  assert.equal(discoveryQueries({ ...contract, window_end: '2026-09-24T00:00:00Z' })[0].created, '2026-09-21T00:00:00Z..2026-09-24T00:00:00Z');
});

test('screening reads the lines leading to each error annotation, not post-job output', () => {
  const filler = n => Array.from({ length: n }, (_, i) => `2026-10-10T00:00:00Z output ${i}`);
  const lines = ['##[group]Run make test', ...filler(500), 'Error: STRIPE_API_KEY is not set', ...filler(250),
    '##[error]Process completed with exit code 1.', ...filler(400)];
  assert.ok(screenLog(lines.join('\n')).owner_score >= 4);
  const far = ['##[group]Run make test', 'Error: STRIPE_API_KEY is not set', ...filler(400), '##[error]Process completed with exit code 1.', ...filler(400)];
  assert.equal(screenLog(far.join('\n')).owner_score, 0);
});

test('errno codes match only as whole upper-case tokens', () => {
  assert.equal(screenLog("E   ModuleNotFoundError: No module named 'tests.common'").retry_score, 0);
  assert.equal(screenLog('Error: connect etimedout_handler missing').retry_score, 0);
  assert.ok(screenLog('##[error]Unable to make request: ENOTFOUND').retry_score >= 3);
});

test('control failure is the earliest in-scope causal failure of the candidate PR', () => {
  const f = (id, completed_at, extra = {}) => ({ id, pr: 7, within_run_consecutive_failures: 1, completed_at, ...extra });
  const screened = { b: { duplicated_history: false, noncausal_history_order: false }, a: { duplicated_history: false, noncausal_history_order: false },
    c: { duplicated_history: true, noncausal_history_order: false } };
  const failures = [f('b', '2026-10-02T00:00:00Z'), f('a', '2026-10-03T00:00:00Z'), f('c', '2026-10-01T00:00:00Z'),
    f('d', '2026-10-01T00:00:00Z', { pr: 8 }), f('e', '2026-10-01T00:00:00Z', { within_run_consecutive_failures: 3 })];
  assert.equal(controlFailure(failures, 7, screened).id, 'b');
  assert.equal(controlFailure([f('x', 't'), f('y', 't')], 7, { x: {}, y: {} }).id,
    controlFailure([f('y', 't'), f('x', 't')], 7, { x: {}, y: {} }).id);
  assert.equal(controlFailure([f('c', 't')], 7, screened), null);
});

test('control order is a salted hash order independent of input order', () => {
  const ids = ['gha:a/b#1:1:1', 'gha:a/b#2:2:2', 'gha:c/d#3:3:3'];
  const one = controlOrder(ids.map(id => ({ id })), 'control-01:').map(x => x.id);
  const two = controlOrder([...ids].reverse().map(id => ({ id })), 'control-01:').map(x => x.id);
  assert.deepEqual(one, two);
  assert.notDeepEqual(controlOrder(ids.map(id => ({ id })), 'other:').map(x => x.id).join(), 'unchanged-salt-check');
  assert.equal(one.length, 3);
});

test('transient fetch errors are retried; missing or expired evidence is not', () => {
  for (const text of ['gh: API rate limit exceeded for user ID 1. (HTTP 403)', 'You have exceeded a secondary rate limit',
    'gh: Server Error (HTTP 502)', 'gh: HTTP 503', 'stream error: stream ID 1; CANCEL; received from peer',
    "gh: We couldn't respond to your request in time. Sorry about that.", 'Command failed: gh api ... ETIMEDOUT'])
    assert.equal(transientFetchError(text), true, text);
  for (const text of ['gh: Not Found (HTTP 404)', 'gh: HTTP 404', 'gh: Server Error (HTTP 410)', 'gh: Resource not accessible (HTTP 403)'])
    assert.equal(transientFetchError(text), false, text);
});

test('a later control draw continues the same hash order and skips chosen cases', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, index: id }));
  const ordered = controlOrder(entries, 'control-01:').map(e => e.id);
  const first = ordered.slice(0, 2);
  const next = continueControl(entries, 'control-01:', new Set(first)).map(e => e.id);
  assert.deepEqual(next, ordered.slice(2));
  assert.equal(next.some(id => first.includes(id)), false);
});
