// Public-source collection only. No labels, model calls, reruns, or adoption changes.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { save, scrub } from "./prepare.mjs";

const execute = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = value => /^[a-f0-9]{40}$/.test(value ?? "");
const failed = value => ["failure", "timed_out"].includes(value);
const terminal = value => ["success", "failure", "timed_out", "cancelled", "skipped", "neutral", "action_required", "startup_failure"].includes(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function configuration(input) {
  const config = { page_size: 100, max_pages: 20, max_attempts: 20, ...input };
  if (!Array.isArray(config.runs) || !config.runs.length || config.runs.length > 500 ||
      !Number.isInteger(config.page_size) || config.page_size < 1 || config.page_size > 100 ||
      !Number.isInteger(config.max_pages) || config.max_pages < 1 || config.max_pages > 100 ||
      !Number.isInteger(config.max_attempts) || config.max_attempts < 1 || config.max_attempts > 100 ||
      (config.recover_pr_anchors !== undefined && typeof config.recover_pr_anchors !== "boolean") ||
      config.runs.some(r => !/^[\w.-]+\/[\w.-]+$/.test(r.repo ?? "") || r.repo.split("/").some(p => [".", ".."].includes(p)) ||
        !Number.isSafeInteger(r.run_id) || r.run_id < 1) ||
      new Set(config.runs.map(r => `${r.repo}:${r.run_id}`)).size !== config.runs.length) {
    throw new Error("invalid public collection config");
  }
  return config;
}

async function githubGet(endpoint) {
  const { stdout } = await execute("gh", ["api", "--method", "GET", endpoint], {
    encoding: "buffer", timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function sourceFile(root, relative) {
  if (typeof relative !== "string" || !/^sources\/\d{6}\.(?:json|log)$/.test(relative)) {
    throw new Error("unsafe source path");
  }
  const file = path.join(root, relative);
  if (fs.lstatSync(path.dirname(file)).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) {
    throw new Error("unsafe source path");
  }
  return file;
}

function anchorEndpoint(run, repo) {
  if (run.event === "pull_request") {
    const headRepo = run.head_repository?.full_name;
    if (!/^[\w.-]+\/[\w.-]+$/.test(headRepo ?? "") || typeof run.head_branch !== "string" || !run.head_branch) return null;
    return `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${headRepo.split("/")[0]}:${run.head_branch}`)}&per_page=100`;
  }
  return `repos/${repo}/commits/${run.head_sha}/pulls?per_page=100`;
}

function recoveredAnchor(run, repo, get, config) {
  const endpoint = anchorEndpoint(run, repo);
  if (!endpoint) return null;
  const rows = [];
  let complete = false;
  for (let page = 1; page <= config.max_pages; page++) {
    const data = get(`${endpoint}&page=${page}`);
    if (!Array.isArray(data)) return null;
    rows.push(...data);
    if (data.length < 100) { complete = true; break; }
  }
  if (!complete) return null;
  const matching = rows.filter(p => Number.isSafeInteger(p.number) && p.number > 0 && sha(p.head?.sha) &&
    p.url === `https://api.github.com/repos/${repo}/pulls/${p.number}` && p.base?.repo?.full_name === repo &&
    (run.event === "pull_request"
      ? p.head.sha === run.head_sha && p.head.ref === run.head_branch && p.head.repo?.full_name === run.head_repository?.full_name
      : p.merge_commit_sha === run.head_sha && Number.isFinite(Date.parse(p.merged_at)) &&
        Date.parse(p.merged_at) <= Date.parse(run.created_at)));
  return matching.length === 1 ? matching[0] : null;
}

function traceAssessment(trace, sources, root, config) {
  const issues = [], failures = [], approval_gates = [], prefix = `repos/${trace.repo}`;
  const available = new Map(trace.source_indexes.map(i => [sources[i].endpoint, sources[i]]));
  const get = (endpoint, text = false) => {
    const source = available.get(endpoint);
    if (!source?.ok) { issues.push(`missing source: ${endpoint}`); return null; }
    const body = fs.readFileSync(sourceFile(root, source.path), "utf8");
    if (text) return { text: body, source: source.path };
    try { return JSON.parse(body); } catch { issues.push(`invalid JSON: ${endpoint}`); return null; }
  };
  const repository = get(prefix);
  if (repository?.private !== false || repository?.full_name !== trace.repo) {
    return { complete: false, issues: ["repository not verified public"], failures, approval_gates };
  }
  const run = get(`${prefix}/actions/runs/${trace.run_id}`);
  if (!run || run.id !== trace.run_id || !sha(run.head_sha) ||
      run.repository?.full_name !== trace.repo || !Number.isInteger(run.run_attempt) ||
      run.run_attempt < 1 || run.run_attempt > config.max_attempts || run.status !== "completed" || !terminal(run.conclusion)) {
    return { complete: false, issues: [...issues, "invalid run identity or attempt bound"], failures, approval_gates };
  }
  let anchors = run.pull_requests ?? [];
  if (config.recover_pr_anchors) {
    anchors = anchors.filter(p => p.url === `https://api.github.com/repos/${trace.repo}/pulls/${p.number}` &&
      p.base?.repo?.url === `https://api.github.com/repos/${trace.repo}`);
    if (anchors.length === 0) {
      const recovered = recoveredAnchor(run, trace.repo, get, config);
      anchors = recovered ? [recovered] : [];
    }
  }
  const prs = [...new Set(anchors.map(p => p.number))];
  if (prs.length !== 1 || !Number.isSafeInteger(prs[0]) || prs[0] < 1) issues.push("missing or ambiguous PR anchor");
  if (!sha(anchors[0]?.head?.sha)) issues.push("missing PR-head SHA anchor");
  const histories = new Map(), counters = new Map();
  for (let n = 1; n <= run.run_attempt; n++) {
    const base = `${prefix}/actions/runs/${trace.run_id}/attempts/${n}`;
    const attempt = get(base);
    if (!attempt || attempt.id !== run.id || attempt.head_sha !== run.head_sha || attempt.run_attempt !== n ||
        attempt.status !== "completed" || !terminal(attempt.conclusion)) {
      issues.push(`attempt identity: ${n}`);
    }
    if (attempt?.conclusion === "action_required") approval_gates.push({ repo: trace.repo, run_id: run.id, native_attempt: n, label: null });
    let jobs = [], total;
    for (let page = 1; page <= config.max_pages; page++) {
      const data = get(`${base}/jobs?per_page=${config.page_size}&page=${page}`);
      if (!data || !Array.isArray(data.jobs) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) break;
      if (total !== undefined && total !== data.total_count) { issues.push(`changed pagination total: ${n}`); break; }
      total = data.total_count;
      jobs.push(...data.jobs);
      if (jobs.length >= total || !data.jobs.length) break;
    }
    if (total === undefined || jobs.length !== total) issues.push(`incomplete job pages: ${n}`);
    if (new Set(jobs.map(j => j.id)).size !== jobs.length || new Set(jobs.map(j => j.name)).size !== jobs.length) {
      issues.push(`duplicate job identities or names: ${n}`);
    }
    for (const job of jobs) {
      if (!Number.isSafeInteger(job.id) || job.id < 1 || job.run_id !== run.id || job.run_attempt !== n ||
          job.head_sha !== run.head_sha || typeof job.name !== "string" || !job.name || job.status !== "completed" ||
          !terminal(job.conclusion) || !Number.isFinite(Date.parse(job.completed_at))) {
        issues.push(`job identity or terminal state: ${job.id}`);
        continue;
      }
      const history = [...(histories.get(job.name) ?? [])];
      const state = { native_attempt: n, job_id: job.id, conclusion: job.conclusion, completed_at: job.completed_at };
      if (job.conclusion === "success") counters.set(job.name, 0);
      if (failed(job.conclusion)) {
        const log = get(`${prefix}/actions/jobs/${job.id}/logs`, true);
        if (!log?.text.trim()) issues.push(`missing failure log: ${job.id}`);
        counters.set(job.name, (counters.get(job.name) ?? 0) + 1);
        state.log_ref = log?.source ?? null;
        failures.push({ id: `gha:${trace.repo}#${prs[0]}:${run.id}:${job.id}`,
          scope: "github-actions-run-job", repo: trace.repo, pr: prs[0] ?? null,
          source: `https://github.com/${trace.repo}/actions/runs/${run.id}/job/${job.id}`,
          run_id: run.id, job_id: job.id, head_sha: run.head_sha,
          pr_head_sha: anchors[0]?.head?.sha ?? null,
          workflow_path: run.path, job_name: job.name, native_attempt: n,
          within_run_consecutive_failures: counters.get(job.name),
          history: [...history, state], log_ref: log?.source ?? null, label: null, label_source: null });
      }
      histories.set(job.name, [...history, state]);
    }
  }
  return { complete: issues.length === 0, issues, failures: issues.length ? [] : failures, approval_gates };
}

/** Archive complete native GitHub Actions histories for explicitly selected public runs. */
export async function collectPublicRuns(input, root, fetcher = githubGet) {
  const config = configuration(input);
  fs.mkdirSync(root, { mode: 0o700 });
  const sources = [], traces = [];
  for (const selected of config.runs) {
    const trace = { ...selected, source_indexes: [] }, prefix = `repos/${selected.repo}`;
    const fetch = async (endpoint, log = false) => {
      const index = sources.length;
      const source = { endpoint, url: `https://api.github.com/${endpoint}`, fetched_at: new Date().toISOString(), ok: false };
      trace.source_indexes.push(index);
      sources.push(source);
      try {
        const raw = Buffer.from(await fetcher(endpoint)), body = Buffer.from(scrub(raw.toString("utf8")));
        source.path = `sources/${String(index).padStart(6, "0")}.${log ? "log" : "json"}`;
        source.source_sha256 = hash(raw);
        source.sha256 = hash(body);
        source.bytes = body.length;
        source.redacted = !raw.equals(body);
        save(path.join(root, source.path), body);
        source.ok = true;
        return log ? body.toString("utf8") : JSON.parse(body.toString("utf8"));
      } catch (error) {
        source.ok = false;
        source.error = scrub(String(error.message)).slice(0, 500);
        return null;
      }
    };
    const repository = await fetch(prefix);
    if (repository?.private === false && repository?.full_name === selected.repo) {
      const run = await fetch(`${prefix}/actions/runs/${selected.run_id}`);
      if (run && Number.isInteger(run.run_attempt) && run.run_attempt > 0 && run.run_attempt <= config.max_attempts) {
        if (config.recover_pr_anchors && !(run.pull_requests ?? []).some(p =>
          p.url === `https://api.github.com/${prefix}/pulls/${p.number}` && p.base?.repo?.url === `https://api.github.com/${prefix}`)) {
          const endpoint = anchorEndpoint(run, selected.repo);
          if (endpoint) for (let page = 1; page <= config.max_pages; page++) {
            const data = await fetch(`${endpoint}&page=${page}`);
            if (!Array.isArray(data) || data.length < 100) break;
          }
        }
        for (let n = 1; n <= run.run_attempt; n++) {
          const base = `${prefix}/actions/runs/${selected.run_id}/attempts/${n}`;
          await fetch(base);
          let count = 0;
          for (let page = 1; page <= config.max_pages; page++) {
            const data = await fetch(`${base}/jobs?per_page=${config.page_size}&page=${page}`);
            if (!data || !Array.isArray(data.jobs)) break;
            for (const j of data.jobs) if (failed(j.conclusion)) await fetch(`${prefix}/actions/jobs/${j.id}/logs`, true);
            count += data.jobs.length;
            if (count >= data.total_count || !data.jobs.length) break;
          }
        }
      }
    }
    const assessment = traceAssessment(trace, sources, root, config);
    traces.push({ ...trace, complete: assessment.complete, issues: assessment.issues });
  }
  const assessments = traces.map(t => traceAssessment(t, sources, root, config));
  const manifest = { version: 1, created_at: new Date().toISOString(), scope: "public-source-discovery",
    admission_ready: false, labeling_performed: false, evaluation_performed: false,
    counter_scope: "job name within one GitHub run; not a Dotbabel phase counter",
    config, sources, traces, failures: assessments.flatMap(a => a.failures),
    approval_gates: assessments.flatMap(a => a.approval_gates) };
  save(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  verifyPublicArchive(root);
  return manifest;
}

/** Check archived bytes and independently reconstruct the collected trace summaries. */
export function verifyPublicArchive(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const config = configuration(manifest.config);
  if (!same(manifest.traces.map(t => ({ repo: t.repo, run_id: t.run_id })), config.runs)) {
    throw new Error("configured trace set mismatch");
  }
  for (const source of manifest.sources) if (source.path) {
    const bytes = fs.readFileSync(sourceFile(root, source.path));
    if (hash(bytes) !== source.sha256 || bytes.length !== source.bytes) throw new Error("source hash mismatch");
  }
  const assessments = manifest.traces.map(t => traceAssessment(t, manifest.sources, root, config));
  if (!same(assessments.map(a => ({ complete: a.complete, issues: a.issues })),
      manifest.traces.map(t => ({ complete: t.complete, issues: t.issues }))) ||
      !same(assessments.flatMap(a => a.failures), manifest.failures) ||
      !same(assessments.flatMap(a => a.approval_gates), manifest.approval_gates) ||
      manifest.admission_ready !== false || manifest.labeling_performed !== false || manifest.evaluation_performed !== false) {
    throw new Error("derived archive data mismatch");
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, first, out] = process.argv.slice(2);
    const result = command === "collect" && first && out
      ? await collectPublicRuns(JSON.parse(fs.readFileSync(first, "utf8")), out)
      : command === "verify" && first ? verifyPublicArchive(first) : null;
    if (!result) throw new Error("usage: public-actions.mjs collect CONFIG NEW_OUT | verify OUT");
    console.log(JSON.stringify({ traces: result.traces.length, complete_traces: result.traces.filter(t => t.complete).length,
      failure_candidates: result.failures.length, approval_gates: result.approval_gates.length, admission_ready: false }));
  } catch (error) { console.error(scrub(error.message)); process.exitCode = 1; }
}
