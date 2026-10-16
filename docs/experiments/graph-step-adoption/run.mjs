#!/usr/bin/env node
// Local research ledger. collect/evaluate/dry-run never contact a model.
// replay --send requires explicit public-repository consent and an environment key.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyze, RULES, protocolHash, sampleHash, dispatchProfile } from "./protocol.mjs";
import { jevRequest } from "../../../plugins/dotbabel/src/jev-adapter.mjs";
import { decide } from "../../../plugins/dotbabel/src/decider.mjs";
import { jevAdapter } from "../../../plugins/dotbabel/src/jev-adapter.mjs";
import { normalizeReceipt } from "../../../plugins/dotbabel/src/run-receipt.mjs";

const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const jsonl = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const write = (file, value) => fs.writeFileSync(file, value, { flag: "wx", mode: 0o600 });
const reviewers = ["architect-reviewer", "security-auditor", "compliance-auditor", "documentation-writer"];
const phaseNames = new Set(["pre-pr", "open-pr", "post-pr-review", "review-pr", "local-attest"]);

function collect(opts) {
  if (!opts.prs || !opts.facts || !opts.receipts || !opts.repo || !opts.out) throw new Error("collect needs --prs --facts --receipts --repo --out");
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error("invalid repository");
  const rows = [], profiles = {}, exclusions = {};
  const exclude = reason => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const protectedPaths = read(opts.facts).protected_paths;
  const prs = read(opts.prs);
  const labels = opts.labels ? read(opts.labels) : {};
  for (const pr of prs) {
    if (!Number.isInteger(pr.number) || pr.number < 1 || !/^[a-f0-9]{40}$/.test(pr.headRefOid ?? "") ||
        !Array.isArray(pr.files) || !pr.files.length || pr.files.length >= 100 ||
        !pr.files.every(f => typeof f.path === "string") || !Number.isInteger(pr.additions) || !Number.isInteger(pr.deletions) ||
        pr.additions < 0 || pr.deletions < 0) { exclude("incomplete_pr_snapshot"); continue; }
    const files = pr.files.map(f => f.path).sort(), lines = pr.additions + pr.deletions;
    const profile = dispatchProfile(files, lines, protectedPaths);
    profiles[profile.name] = (profiles[profile.name] ?? 0) + 1;
    const candidates = reviewers.filter(r => !profile.reviewers.includes(r));
    if (!candidates.length) { exclude("no_additional_candidate"); continue; }
    const row = { id: `${opts.repo}#${pr.number}:dispatch:${pr.headRefOid}`, repo: opts.repo,
      pr: pr.number, head_sha: pr.headRefOid, source: `https://github.com/${opts.repo}/pull/${pr.number}`,
      step: "dispatch", input: { profile: profile.reviewers, changed_files: files, changed_lines: lines, candidates },
      label: null, label_source: null, labeled_before_replay: false };
    const label = labels[row.id];
    if (label) {
      if (label.head_sha !== row.head_sha || label.label_source !== "independent-human" ||
          label.labeled_before_replay !== true || !Array.isArray(label.evidence) || !label.evidence.length ||
          label.evidence.some(e => typeof e !== "string" || !e.startsWith(row.source))) throw new Error("labels need pinned source evidence and independent pre-replay annotation");
      Object.assign(row, { label: label.label, label_source: label.label_source, labeled_before_replay: true, label_evidence: label.evidence });
    }
    rows.push(row);
  }
  let receiptFiles = 0, failedPhases = 0;
  for (const file of fs.readdirSync(opts.receipts).filter(f => /^pr-\d+\.json$/.test(f))) {
    const receipt = normalizeReceipt(read(path.join(opts.receipts, file)));
    receiptFiles++;
    for (const a of receipt.attempts) {
      if (!phaseNames.has(a.phase) || !["fail", "blocked"].includes(a.outcome)) continue;
      failedPhases++;
      // Receipts deliberately omit failure text. A CI failure is not a conductor label.
      exclude("receipt_missing_failure_tail");
    }
  }
  write(opts.out, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  return { protocol_hash: protocolHash(), source_prs: prs.length, profiles,
    receipt_files: receiptFiles, failed_conductor_phases: failedPhases, exclusions,
    collected: rows.length, labeled: rows.filter(r => r.label !== null).length };
}

function evaluate(opts) {
  if (!opts.in) throw new Error("evaluate needs --in");
  const rows = jsonl(opts.in), answers = opts.answers ? jsonl(opts.answers) : [];
  return { protocol_hash: protocolHash(), rules: RULES,
    results: ["retry", "dispatch"].map(step => analyze(step, rows, answers)) };
}

async function replay(opts) {
  if (!opts.in || !opts.out) throw new Error("replay needs --in --out");
  const rows = jsonl(opts.in);
  const eligible = rows.filter(row => analyze(row.step, [row], []).labeled === 1);
  if (!opts.send) {
    write(opts.out, eligible.map(row => JSON.stringify({ id: row.id, protocol_hash: protocolHash(), sample_hash: sampleHash(row), request: jevRequest(row.step, row.input) })).join("\n") + (eligible.length ? "\n" : ""));
    return { dry_run: true, requests: eligible.length, protocol_hash: protocolHash() };
  }
  if (!process.env.TYPESAFE_API_KEY) throw new Error("send requires TYPESAFE_API_KEY in the environment");
  if (!opts["consent-public-repo"] || eligible.some(row => row.repo !== opts["consent-public-repo"])) throw new Error("send requires --consent-public-repo for this public dataset");
  // Never spend requests when the locked sample floor cannot be met.
  for (const step of ["retry", "dispatch"]) {
    const group = eligible.filter(row => row.step === step);
    const classes = step === "retry" ? ["retry", "fix", "ask-owner"].map(a => group.filter(r => r.label === a).length)
      : [group.filter(r => r.label.length).length, group.filter(r => !r.label.length).length];
    if (group.length && (group.length < RULES.minimum_rows || new Set(group.map(r => r.repo + "#" + r.pr)).size < RULES.minimum_prs || classes.some(n => n < RULES.minimum_per_class))) throw new Error("sample floor is not met; collect labels before sending");
  }
  const fd = fs.openSync(opts.out, "wx", 0o600);
  try {
    for (const row of eligible) {
      const result = await decide(row.step, row.input, { config: { adapter: "jev", steps: [row.step] },
        consent: true, key: process.env.TYPESAFE_API_KEY, adapter: jevAdapter(process.env.TYPESAFE_API_KEY), maxAttempts: RULES.max_attempts });
      const shadow = result.shadow;
      const record = { id: row.id, protocol_hash: protocolHash(), sample_hash: sampleHash(row),
        answer: shadow?.answer ?? null, confidence: shadow?.confidence ?? null, fallback: result.fallback || !shadow };
      const serialized = JSON.stringify(record);
      if (serialized.includes(process.env.TYPESAFE_API_KEY)) throw new Error("refusing to persist an API key");
      fs.writeSync(fd, serialized + "\n");
    }
  } finally { fs.closeSync(fd); }
  return { dry_run: false, requests: eligible.length, protocol_hash: protocolHash() };
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries(
    ["in", "out", "prs", "facts", "receipts", "repo", "labels", "answers", "consent-public-repo"].map(k => [k, { type: "string" }]).concat([["send", { type: "boolean", default: false }]])) });
  if (positionals.length !== 1 || !["collect", "evaluate", "replay"].includes(positionals[0])) throw new Error("expected collect, evaluate, or replay");
  const result = positionals[0] === "collect" ? collect(values) : positionals[0] === "evaluate" ? evaluate(values) : await replay(values);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  const key = process.env.TYPESAFE_API_KEY;
  const message = key ? String(error.message).split(key).join("[REDACTED]") : String(error.message);
  process.stderr.write("graph-step-adoption: " + message + "\n");
  process.exitCode = 2;
}
