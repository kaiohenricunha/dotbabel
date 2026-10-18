// Research evidence recovery. Reads explicit local sources; never executes their commands.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { save, scrub, observedProfile, validate as validateParent, summarize } from "./prepare.mjs";
import { dispatchProfile, protocolHash } from "../graph-step-adoption/protocol.mjs";
import { validateDecisionInput } from "../../../plugins/dotbabel/src/decider.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const jsonl = rows => rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : "");
const execute = promisify(execFile);

export function sanitizeJSON(value) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(sanitizeJSON);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeJSON(v)]));
  return value;
}

export function toolEvents(source, conflicts) {
  const calls = new Map(), results = new Map(), rejected = new Set();
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!["assistant", "user"].includes(row.type) || !row.timestamp || !Array.isArray(row.message?.content)) continue;
    for (const block of row.message.content) {
      if (block.type === "tool_use" && row.type === "assistant") {
        const prior = calls.get(block.id);
        if (prior && JSON.stringify(prior.input) !== JSON.stringify(block.input)) throw new Error("conflicting tool call");
        calls.set(block.id, { name: block.name, input: block.input, call_line: index + 1, at: row.timestamp,
          cwd: row.cwd ?? null, session_id: row.sessionId ?? null });
      }
      if (block.type !== "tool_result" || row.type !== "user" || typeof block.content !== "string") continue;
      if (rejected.has(block.tool_use_id)) continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;
      const prior = results.get(block.tool_use_id);
      if (prior && prior.output !== scrub(block.content)) {
        if (!conflicts) throw new Error(`conflicting tool result: ${block.tool_use_id}`);
        conflicts.push(block.tool_use_id); rejected.add(block.tool_use_id); results.delete(block.tool_use_id); continue;
      }
      if (prior) continue;
      results.set(block.tool_use_id, { ...call, command: scrub(call.input?.command ?? ""),
        // Only the relevant command is retained. Other arguments can contain private prompts.
        input: undefined, tool_id: block.tool_use_id, result_line: index + 1, result_at: row.timestamp,
        result_uuid: row.uuid ?? null, output: scrub(block.content), output_sha256: digest(block.content),
        cwd: row.serverClassifierContext?.context?.git_state?.cwd ?? row.cwd ?? call.cwd,
        tool_error: block.is_error === true });
    }
  }
  return [...results.values()];
}

export function rosterCalls(events, repo) {
  const rows = [];
  for (const event of events) {
    const matches = event.command?.matchAll(/post-pr-review-post-receipt\.sh["']?\s+(\d+)\s+--sha\s+([a-f0-9]{40})[^\n]*?--agents\s+([\w,-]+)/g) ?? [];
    for (const match of matches) rows.push({ repo, pr: Number(match[1]), head_sha: match[2],
      reviewers: [...new Set(match[3].split(","))], confirmed: false, tool_id: event.tool_id,
      reason: "literal_request_requires_pinned_GitHub_review_confirmation" });
  }
  return rows;
}

export function linkFailure(receipt, invocation, log) {
  if (!/^[a-f0-9]{40}$/.test(receipt.head_sha ?? "") || receipt.phase !== "local-attest" ||
      !Number.isInteger(receipt.attempt) || receipt.attempt < 1 || receipt.attempt >= 3) throw new Error("invalid receipt or cap");
  if (!Number.isFinite(Date.parse(invocation.at)) || !Number.isFinite(Date.parse(receipt.at)) ||
      Date.parse(invocation.at) > Date.parse(receipt.at)) throw new Error("execution after receipt");
  if (!new RegExp(`--pr\\s+${receipt.pr}\\b`).test(invocation.command) ||
      !/(?:dotbabel local-attest|npm run attest|run-local-attest\.mjs)/.test(invocation.command) ||
      /--(?:only|from)\b/.test(invocation.command) || /Diagnostic run:/.test(log.body)) throw new Error("wrong execution or diagnostic run");
  if (!log.path || !invocation.command.includes(log.path)) throw new Error("log not linked to execution");
  const banner = (log.head_body ?? log.body).match(/Attesting PR #(\d+) \(([^)]+)\) at ([a-f0-9]{7,40})\./);
  const inlineHead = invocation.command.includes("git rev-parse") ? log.body.match(/^([a-f0-9]{7,40})\s*\n/) : null;
  if (banner ? Number(banner[1]) !== receipt.pr || banner[2] !== receipt.repo || !receipt.head_sha.startsWith(banner[3]) :
    !inlineHead || !receipt.head_sha.startsWith(inlineHead[1])) throw new Error("original log head mismatch");
  if (!/\b[1-9]\d* hard leg\(s\) failed:/.test(log.body)) throw new Error("original failure summary missing");
  return { id: receipt.id ?? `${receipt.repo}#${receipt.pr}:retry:${receipt.head_sha}:${receipt.phase}:${receipt.receipt_n}`,
    repo: receipt.repo, pr: receipt.pr, head_sha: receipt.head_sha,
    source: `https://github.com/${receipt.repo}/pull/${receipt.pr}`, step: "retry",
    input: { phase: receipt.phase, attempt: receipt.attempt, failure_tail: scrub(log.body).slice(-60000) },
    label: null, label_source: null, labeled_before_replay: false };
}

export function scan(configFile, out) {
  if (fs.existsSync(out)) throw new Error("output must be new");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  save(path.join(out, "recovery-config.json"), JSON.stringify(config, null, 2) + "\n");
  const sources = [], events = [], rosters = [], conflicts = [], logs = new Map(), scratchDirs = new Set();
  for (const repository of config.repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository.repo)) throw new Error("invalid repository");
    for (const root of repository.session_roots) {
      if (!path.isAbsolute(root) || !fs.statSync(root).isDirectory()) throw new Error("explicit session root required");
      for (const name of fs.readdirSync(root).filter(n => /^[a-f0-9-]{36}\.jsonl$/.test(n)).sort()) {
        const file = path.join(root, name), bytes = fs.readFileSync(file);
        const sourceRef = `sources/${repository.repo.replace("/", "--")}-${name}.json`;
        const metadata = { original_path: file, bytes: bytes.length, sha256: digest(bytes), repo: repository.repo };
        save(path.join(out, sourceRef), JSON.stringify(metadata) + "\n"); sources.push(metadata);
        const rejected = [], parsed = toolEvents(bytes.toString(), rejected);
        conflicts.push(...rejected.map(tool_id => ({ source_ref: sourceRef, tool_id, reason: "conflicting_tool_results" })));
        for (const event of parsed) {
          for (const match of event.command.matchAll(/\/tmp\/claude-1000\/[^\s;"'<>]*\/scratchpad\b/g)) scratchDirs.add(match[0]);
          if (!/attest|post-pr-review-post-receipt/.test(event.command + event.output)) continue;
          const selected = { ...event, repo: repository.repo, source_ref: sourceRef };
          events.push(selected);
        }
        rosters.push(...rosterCalls(parsed, repository.repo).map(r => ({ ...r, source_ref: sourceRef })));
      }
    }
  }
  for (const dir of scratchDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter(n => /^attest[^/]*\.log$/.test(n))) {
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) continue;
      const body = fs.readFileSync(file, "utf8"), hash = digest(body), ref = `logs/${hash}.log`;
      if (!logs.has(hash)) { save(path.join(out, ref), scrub(body)); logs.set(hash, { ref, sha256: hash, original_paths: [] }); }
      logs.get(hash).original_paths.push(file);
    }
  }
  save(path.join(out, "tool-events.jsonl"), jsonl(events));
  save(path.join(out, "roster-requests.jsonl"), jsonl(rosters));
  save(path.join(out, "conflicts.jsonl"), jsonl(conflicts));
  save(path.join(out, "original-logs.json"), JSON.stringify([...logs.values()], null, 2) + "\n");
  const result = { sessions: sources.length, retained_tool_events: events.length, roster_requests: rosters.length,
    retained_original_logs: logs.size, failure_outputs: events.filter(e => /\d+ hard leg\(s\) failed:/.test(e.output)).length,
    conflicting_results_excluded: conflicts.length, replay_performed: false, labels_created: 0 };
  save(path.join(out, "scan.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

export function linkMapped(root, parent, linksFile) {
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const events = lines(path.join(root, "tool-events.jsonl"));
  const pending = lines(path.join(parent, "retry-unknown.jsonl"));
  const logs = read(path.join(root, "original-logs.json")), recovered = [];
  const event = id => {
    const matches = events.filter(e => e.tool_id === id);
    if (matches.length !== 1) throw new Error("missing or ambiguous tool event");
    return matches[0];
  };
  for (const link of read(linksFile)) {
    const row = pending.find(r => r.id === link.id);
    if (!row || recovered.some(r => r.id === row.id)) throw new Error("missing or duplicate receipt case");
    const receiptRef = row.evidence[0], receipt = read(path.join(parent, receiptRef));
    const attempt = receipt.attempts.find(a => a.phase === row.phase && a.n === row.receipt_n && a.head_sha === row.head_sha);
    if (!attempt || attempt.outcome !== "fail") throw new Error("receipt attempt mismatch");
    const invocation = event(link.invocation_tool_id);
    let log, evidence = ["tool-events.jsonl", invocation.source_ref, receiptRef];
    if (link.log_ref) {
      const retained = logs.find(l => l.ref === link.log_ref);
      if (!retained) throw new Error("retained original log missing");
      const originalPath = retained.original_paths.find(p => invocation.command.includes(p));
      log = { path: originalPath, body: fs.readFileSync(path.join(root, retained.ref), "utf8") };
      evidence.push(retained.ref);
    } else {
      const failure = event(link.failure_tool_id), header = link.header_tool_id ? event(link.header_tool_id) : null;
      if (Date.parse(failure.result_at) > Date.parse(attempt.at)) throw new Error("failure output follows receipt");
      const logPath = link.original_log_path;
      const taskPath = invocation.output.match(/Output is being written to: (\S+)/)?.[1]?.replace(/\.$/, "");
      if (!failure.command.includes(logPath) && !(taskPath && failure.command.includes(taskPath))) throw new Error("failure read does not match original execution");
      if (header && (!header.command.includes(logPath) || Date.parse(header.result_at) > Date.parse(attempt.at))) throw new Error("header read mismatch");
      log = { path: logPath, body: failure.output, head_body: header?.output };
      evidence.push(failure.source_ref, ...(header ? [header.source_ref] : []));
    }
    const linked = linkFailure({ ...row, at: attempt.at }, invocation, log);
    if (!fs.existsSync(path.join(root, receiptRef))) save(path.join(root, receiptRef), fs.readFileSync(path.join(parent, receiptRef)));
    const proofRef = `evidence/retry-${digest(row.id)}.json`;
    save(path.join(root, proofRef), JSON.stringify({ repo: row.repo, pr: row.pr, head_sha: row.head_sha,
      decision_head_verified: true, failure_link_verified: true, original_log: true,
      phase: row.phase, attempt: row.attempt, receipt_n: row.receipt_n, receipt_at: attempt.at,
      failure_tail: linked.input.failure_tail, invocation_tool_id: link.invocation_tool_id,
      failure_tool_id: link.failure_tool_id ?? null, header_tool_id: link.header_tool_id ?? null,
      original_log_path: log.path, retained_log_ref: link.log_ref ?? null, receipt_ref: receiptRef,
      parent_manifest_sha256: digest(fs.readFileSync(path.join(parent, "manifest.json"))) }, null, 2) + "\n");
    recovered.push({ ...linked, evidence: [...new Set([...evidence, proofRef])], provenance_ref: proofRef });
  }
  save(path.join(root, "retry-annotation-input.jsonl"), jsonl(recovered));
  save(path.join(root, "retry-still-unlinked.jsonl"), jsonl(pending.filter(p => !recovered.some(r => r.id === p.id))));
  save(path.join(root, "retry-links.json"), JSON.stringify(read(linksFile), null, 2) + "\n");
  return { recovered_original_failures: recovered.length, groups: new Set(recovered.map(r => `${r.repo}#${r.pr}`)).size,
    still_unlinked: pending.length - recovered.length, verified_labels_added: 0, replay_performed: false };
}

export function reviewOpportunities(repo, pr, reviews, prior) {
  const rows = [];
  for (const head of new Set(reviews.map(r => r.commit_id).filter(h => /^[a-f0-9]{40}$/.test(h ?? "")))) {
    if (prior.some(r => r.repo === repo && r.pr === pr && r.head_sha === head)) continue;
    const roster = observedProfile(reviews, head);
    const allowed = ["architect-reviewer", "security-auditor", "compliance-auditor", "documentation-writer"];
    if (!roster || roster.reviewers.length >= allowed.length || roster.reviewers.some(r => !allowed.includes(r))) continue;
    const anchor = reviews.filter(r => r.commit_id === head && r.id === roster.review_id)[0];
    rows.push({ id: `${repo}#${pr}:dispatch:${head}`, repo, pr, head_sha: head,
      source: `https://github.com/${repo}/pull/${pr}`, step: "dispatch", label: null,
      roster_evidence: roster, review_anchor: { id: anchor.id, head_sha: head, url: anchor.url, at: anchor.submitted_at } });
  }
  return rows;
}

export async function expandDispatch(root, parent) {
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  const prior = fs.readFileSync(path.join(parent, "dispatch.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const config = read(path.join(parent, "collection-config.json")), opportunities = [], unknown = [];
  let inspected = 0;
  for (const repository of config.repositories) {
    const [owner, name] = repository.name.split("/"), slug = repository.name.replace("/", "--");
    const prs = read(path.join(parent, `sources/${slug}-prs.json`));
    for (let offset = 0; offset < prs.length; offset += 20) {
      const batch = prs.slice(offset, offset + 20);
      const fields = batch.map(p => `pr${p.number}:pullRequest(number:${p.number}){number reviews(first:100){pageInfo{hasNextPage} nodes{databaseId body submittedAt url commit{oid}}}}`).join(" ");
      const query = `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${fields}}}`;
      const ref = `expanded-reviews/${slug}-${offset}.json`, file = path.join(root, ref);
      let response;
      if (fs.existsSync(file)) response = read(file);
      else {
        try {
          const { stdout } = await execute("gh", ["api", "graphql", "-f", `query=${query}`], { maxBuffer: 40 * 1024 * 1024 });
          response = JSON.parse(stdout);
          save(file, JSON.stringify(sanitizeJSON(response)) + "\n");
          response = read(file);
        } catch (error) {
          response = { reason: "github_batch_read_failed", exit_code: error.code ?? null };
          save(file, JSON.stringify(response) + "\n");
        }
      }
      for (const item of batch) {
        inspected++;
        const node = response.data?.repository?.[`pr${item.number}`];
        if (!node || node.reviews.pageInfo.hasNextPage) {
          unknown.push({ repo: repository.name, pr: item.number, reason: !node ? "review_batch_unavailable" : "review_pagination_incomplete", evidence: [ref] }); continue;
        }
        const reviews = node.reviews.nodes.map(r => ({ id: r.databaseId, body: r.body ?? "", commit_id: r.commit?.oid,
          submitted_at: r.submittedAt, url: r.url }));
        opportunities.push(...reviewOpportunities(repository.name, item.number, reviews, prior).map(r => ({ ...r, evidence: [ref], reviews })));
      }
      process.stderr.write(`review expansion: ${slug} ${Math.min(offset + 20, prs.length)}/${prs.length}; new heads ${opportunities.length}\n`);
    }
  }
  save(path.join(root, "dispatch-recovery-opportunities.jsonl"), jsonl(opportunities));
  save(path.join(root, "dispatch-expansion-unknown.jsonl"), jsonl(unknown));
  return { archived_prs_inspected: inspected, new_review_heads: opportunities.length,
    groups: new Set(opportunities.map(r => `${r.repo}#${r.pr}`)).size, unknown: unknown.length,
    verified_labels_added: 0, replay_performed: false };
}

export function retrySourceCandidates(repo, node, ref) {
  const sources = [{ kind: "body", url: node.url, body: node.body ?? "" },
    ...(node.comments?.nodes ?? []).map(c => ({ kind: "comment", url: c.url, body: c.body ?? "", comment_id: c.databaseId }))];
  return sources.filter(s => /local-attest|npm run attest|pre-pr|open-pr|post-pr-review|review-pr/i.test(s.body) &&
    /hard leg\(s\) failed|\bFAIL(?:ED)?\b|Error:|exit(?:ed)?[ =:]+[1-9]/i.test(s.body)).map(s => ({
      repo, pr: node.number, kind: s.kind, url: s.url, comment_id: s.comment_id,
      body_sha256: digest(s.body), evidence: [ref], eligible: false,
      reason: "requires_original_log_head_phase_and_consecutive_counter_audit" }));
}

export async function collectRetrySources(parent, root) {
  if (fs.existsSync(root)) throw new Error("output must be new");
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  const config = read(path.join(parent, "collection-config.json"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const coverage = [], unknown = [], candidates = [];
  for (const repository of config.repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository.name)) throw new Error("invalid repository");
    const [owner, name] = repository.name.split("/"), slug = repository.name.replace("/", "--");
    const bytes = fs.readFileSync(path.join(parent, `sources/${slug}-prs.json`)), prs = JSON.parse(bytes);
    if (prs.some(p => !Number.isInteger(p.number) || p.number < 1) || new Set(prs.map(p => p.number)).size !== prs.length) throw new Error("invalid PR source");
    save(path.join(root, `sources/${slug}-prs.json`), bytes);
    for (let offset = 0; offset < prs.length; offset += 20) {
      const batch = prs.slice(offset, offset + 20), ref = `batches/${slug}-${offset}.json`;
      const fields = batch.map(p => `pr${p.number}:pullRequest(number:${p.number}){number url body comments(first:100){pageInfo{hasNextPage} nodes{databaseId url body createdAt updatedAt}}}`).join(" ");
      const query = `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${fields}}}`;
      let response;
      try {
        const { stdout } = await execute("gh", ["api", "graphql", "-f", `query=${query}`], { maxBuffer: 40 * 1024 * 1024 });
        response = sanitizeJSON(JSON.parse(stdout));
      } catch { response = { reason: "github_retry_source_read_failed" }; }
      save(path.join(root, ref), JSON.stringify(response) + "\n");
      for (const pr of batch) {
        const node = response.data?.repository?.[`pr${pr.number}`];
        const complete = Boolean(node?.comments?.pageInfo && !node.comments.pageInfo.hasNextPage);
        coverage.push({ repo: repository.name, pr: pr.number, evidence: [ref], complete,
          comments: node?.comments?.nodes?.length ?? 0, metadata_sha256: digest(bytes) });
        if (!complete) unknown.push({ repo: repository.name, pr: pr.number, evidence: [ref],
          reason: node ? "retry_comments_pagination_incomplete" : "retry_source_unavailable" });
        if (node) candidates.push(...retrySourceCandidates(repository.name, node, ref));
      }
      process.stderr.write(`retry sources: ${slug} ${Math.min(offset + 20, prs.length)}/${prs.length}; possible sources ${candidates.length}\n`);
    }
  }
  save(path.join(root, "coverage.jsonl"), jsonl(coverage));
  save(path.join(root, "possible-sources.jsonl"), jsonl(candidates));
  save(path.join(root, "unknown.jsonl"), jsonl(unknown));
  const result = { inspected_prs: coverage.length, complete_prs: coverage.filter(r => r.complete).length,
    comments: coverage.reduce((n, r) => n + r.comments, 0), possible_sources: candidates.length,
    unknown: unknown.length, verified_labels_added: 0, replay_performed: false };
  save(path.join(root, "source-manifest.json"), JSON.stringify({ version: 1, collected_at: new Date().toISOString(),
    ...result, eligibility: "source index only; no inferred attempts or labels", files: inventory(root) }, null, 2) + "\n");
  return result;
}

export function pinnedDispatch(opportunity, pr, comparison, facts) {
  if (!comparison.files?.length || comparison.files.length >= 300 || comparison.files.some(f => !f.patch) ||
      comparison.total_commits !== comparison.commits.length || !comparison.commits.some(c => c.sha === opportunity.head_sha))
    throw new Error("incomplete_pinned_diff");
  if (!Array.isArray(facts?.facts?.protected_paths) || facts.commit !== comparison.merge_base_commit.sha)
    throw new Error("historical_protected_paths_unavailable");
  const roster = observedProfile(opportunity.reviews, opportunity.head_sha);
  if (!roster || JSON.stringify(roster) !== JSON.stringify(opportunity.roster_evidence)) throw new Error("original_roster_mismatch");
  const files = comparison.files.map(f => f.filename).sort();
  const changedLines = comparison.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const baseline = dispatchProfile(files, changedLines, facts.facts.protected_paths);
  const reviewers = ["architect-reviewer", "security-auditor", "compliance-auditor", "documentation-writer"];
  const input = { profile: roster.reviewers, changed_files: files, changed_lines: changedLines,
    candidates: reviewers.filter(r => !roster.reviewers.includes(r)) };
  const { reviews, roster_evidence, review_anchor, ...row } = opportunity;
  const state = { repo: row.repo, pr: row.pr, head_sha: row.head_sha, decision_head_verified: true,
    historical_facts: facts, merge_base_sha: comparison.merge_base_commit.sha, base_sha: pr.base?.sha,
    review_anchor, reviews, files: comparison.files, commits: comparison.commits.map(c => ({ sha: c.sha })),
    comparison_complete: true };
  return { row: { ...row, input, label_source: null, labeled_before_replay: false }, state,
    proof: { repo: row.repo, pr: row.pr, head_sha: row.head_sha, decision_head_verified: true, input,
      profile_rule_verified: true, historical_profile_verified: true, profile_name: baseline.name,
      baseline_profile: baseline.reviewers, profile_kind: "observed-original-review-roster",
      roster_evidence, historical_facts_commit: facts.commit } };
}

export async function pinExpanded(root) {
  const opportunities = fs.readFileSync(path.join(root, "dispatch-recovery-opportunities.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(JSON.parse), ready = [], unknown = [];
  async function cached(ref, args) {
    const file = path.join(root, ref);
    if (!fs.existsSync(file)) {
      const { stdout } = await execute("gh", args, { maxBuffer: 40 * 1024 * 1024 });
      save(file, JSON.stringify(sanitizeJSON(JSON.parse(stdout))) + "\n");
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  for (const row of opportunities) {
    const stem = `expanded-evidence/${row.repo.replace("/", "--")}-${row.pr}-${row.head_sha}`;
    const refs = { pr: `${stem}-pr.json`, comparison: `${stem}-comparison.json`, facts: `${stem}-facts.json`,
      state: `${stem}-state.json`, proof: `${stem}-provenance.json` };
    try {
      const pr = await cached(refs.pr, ["api", `repos/${row.repo}/pulls/${row.pr}`]);
      const comparison = await cached(refs.comparison, ["api", `repos/${row.repo}/compare/${pr.base.sha}...${row.head_sha}`]);
      const content = await cached(refs.facts, ["api", `repos/${row.repo}/contents/docs/repo-facts.json?ref=${comparison.merge_base_commit.sha}`]);
      const facts = { commit: comparison.merge_base_commit.sha, blob_sha: content.sha,
        facts: JSON.parse(Buffer.from(content.content, "base64").toString("utf8")) };
      const pinned = pinnedDispatch(row, pr, comparison, facts);
      save(path.join(root, refs.state), JSON.stringify(pinned.state) + "\n");
      save(path.join(root, refs.proof), JSON.stringify({ ...pinned.proof, review_state_ref: refs.state }) + "\n");
      ready.push({ ...pinned.row, evidence: [...row.evidence, refs.pr, refs.comparison, refs.facts, refs.state, refs.proof], provenance_ref: refs.proof });
    } catch (error) {
      const reason = ["incomplete_pinned_diff", "historical_protected_paths_unavailable", "original_roster_mismatch"].includes(error.message) ? error.message : "pinned_evidence_read_failed";
      unknown.push({ id: row.id, repo: row.repo, pr: row.pr, head_sha: row.head_sha, reason, evidence: row.evidence });
    }
  }
  save(path.join(root, "dispatch-annotation-input.jsonl"), jsonl(ready));
  save(path.join(root, "dispatch-pinning-unknown.jsonl"), jsonl(unknown));
  return { original_review_heads: opportunities.length, pinned_inputs: ready.length,
    groups: new Set(ready.map(r => `${r.repo}#${r.pr}`)).size, unknown: unknown.length, verified_labels_added: 0 };
}

function inventory(root, relative = "") {
  if ((fs.statSync(path.join(root, relative)).mode & 0o777) !== 0o700) throw new Error("directory permissions");
  return fs.readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const ref = path.join(relative, name), file = path.join(root, ref), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("symlink in recovery evidence");
    if (stat.isDirectory()) return inventory(root, ref);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("file permissions");
    return [{ path: ref, bytes: stat.size, sha256: digest(fs.readFileSync(file)) }];
  });
}

function recoveryCounts(root, parent) {
  const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  try { validateParent(parent); } catch { throw new Error("parent dataset validation failed"); }
  const verified = [...lines(path.join(parent, "retry.jsonl")), ...lines(path.join(parent, "dispatch.jsonl"))];
  const pending = [...lines(path.join(root, "retry-annotation-input.jsonl")), ...lines(path.join(root, "dispatch-annotation-input.jsonl"))];
  const ids = new Set(verified.map(r => r.id));
  for (const row of pending) {
    if (ids.has(row.id)) throw new Error("duplicate recovered case"); ids.add(row.id);
    if (row.label !== null || row.label_source !== null || row.labeled_before_replay !== false) throw new Error("unverified label in recovery inputs");
    validateDecisionInput(row.step, row.input);
    if (!/^[a-f0-9]{40}$/.test(row.head_sha) || !Number.isInteger(row.pr) || row.pr < 1 ||
        row.source !== `https://github.com/${row.repo}/pull/${row.pr}`) throw new Error("case provenance");
    for (const ref of [...row.evidence, row.provenance_ref]) {
      const file = path.resolve(root, ref);
      if (!file.startsWith(path.resolve(root) + path.sep) || !fs.statSync(file).isFile()) throw new Error("unsafe evidence reference");
    }
    const proof = JSON.parse(fs.readFileSync(path.join(root, row.provenance_ref)));
    if (proof.repo !== row.repo || proof.pr !== row.pr || proof.head_sha !== row.head_sha || proof.decision_head_verified !== true) throw new Error("proof mismatch");
    if (row.step === "retry") {
      if (row.input.attempt >= 3 || proof.failure_link_verified !== true || proof.original_log !== true ||
          proof.failure_tail !== row.input.failure_tail || proof.phase !== row.input.phase || proof.attempt !== row.input.attempt) throw new Error("retry proof mismatch");
    } else {
      const state = JSON.parse(fs.readFileSync(path.join(root, proof.review_state_ref)));
      const pinned = pinnedDispatch({ ...row, reviews: state.reviews, roster_evidence: proof.roster_evidence, review_anchor: state.review_anchor },
        { base: { sha: state.base_sha } }, { files: state.files, commits: state.commits, total_commits: state.commits.length,
          merge_base_commit: { sha: state.merge_base_sha } }, state.historical_facts);
      if (JSON.stringify(pinned.row.input) !== JSON.stringify(row.input)) throw new Error("dispatch input mismatch");
    }
  }
  return { verified: summarize(verified), pending: Object.fromEntries(["retry", "dispatch"].map(step => {
    const rows = pending.filter(r => r.step === step), combined = [...verified.filter(r => r.step === step), ...rows];
    return [step, { rows: rows.length, groups: new Set(rows.map(r => `${r.repo}#${r.pr}`)).size,
      total_rows_if_verified: combined.length, total_groups_if_verified: new Set(combined.map(r => `${r.repo}#${r.pr}`)).size }];
  })) };
}

export function sealRecovery(root, parent) {
  const counts = recoveryCounts(root, parent);
  const floorsMet = Object.values(counts.verified).every(step => step.ready);
  save(path.join(root, "recovery-manifest.json"), JSON.stringify({ version: 1, created_at: new Date().toISOString(),
    protocol_hash: protocolHash(), parent_manifest_sha256: digest(fs.readFileSync(path.join(parent, "manifest.json"))),
    replay_performed: false, verified_labels_added: 0, sample_floors_met: floorsMet, counts,
    files: inventory(root) }, null, 2) + "\n");
  return validateRecovery(root, parent);
}

export function validateRecovery(root, parent) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "recovery-manifest.json")));
  if (manifest.parent_manifest_sha256 !== digest(fs.readFileSync(path.join(parent, "manifest.json")))) throw new Error("parent manifest changed");
  if (manifest.protocol_hash !== protocolHash() || manifest.replay_performed !== false || manifest.verified_labels_added !== 0) throw new Error("recovery protocol mismatch");
  const files = inventory(root).filter(f => f.path !== "recovery-manifest.json");
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error("recovery hashes differ");
  const counts = recoveryCounts(root, parent);
  if (JSON.stringify(counts) !== JSON.stringify(manifest.counts)) throw new Error("recovery counts differ");
  const floorsMet = Object.values(counts.verified).every(step => step.ready);
  if (manifest.sample_floors_met !== floorsMet) throw new Error("recovery floor counts differ");
  return { structural_valid: true, sample_floors_met: floorsMet, replay_performed: false, ...counts, hashed_files: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const result = command === "scan" ? scan(...args) : command === "link" ? linkMapped(...args) : command === "expand-dispatch" ? await expandDispatch(...args) : command === "retry-sources" ? await collectRetrySources(...args) : command === "pin-dispatch" ? await pinExpanded(...args) : command === "seal" ? sealRecovery(...args) : command === "validate" ? validateRecovery(...args) : null;
    if (!result) throw new Error("expected scan CONFIG NEW_OUT, link SCAN_ROOT PARENT_RUN LINKS, expand-dispatch SCAN_ROOT PARENT_RUN, retry-sources HISTORY_ROOT NEW_OUT, pin-dispatch SCAN_ROOT, seal SCAN_ROOT PARENT_RUN, or validate SCAN_ROOT PARENT_RUN");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) { process.stderr.write(scrub(error.message) + "\n"); process.exitCode = 2; }
}
