// Versioned AI-proxy compatibility. Does not admit these labels to the human protocol.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RULES, protocolHash as parentHash, sampleHash } from "../graph-step-adoption/protocol.mjs";
import { validatePublicLedger, historicalPolicyHash } from "../graph-3e-datasets/historical.mjs";
import { baselinePolicyHash } from "../graph-3e-datasets/baseline.mjs";
import { jevRequest } from "../../../plugins/dotbabel/src/jev-adapter.mjs";

export const POLICY = Object.freeze({ version: 2, step: "dispatch", label_source: "ai-annotation-verified",
  evidence_scope: "agreement with separately inspected AI annotations; not independent-human accuracy",
  human_labels: false, adoption_eligible: false, promotion: "shadow-only", numeric_rules_changed: false,
  cohorts: Object.freeze(["offline-locked-baseline", "public-historical-review-head-baseline"]),
  selection: "all agreed public rows from both frozen source policies; preserve every unknown",
  independence: "distinct actors, prediction blindness, exact agreement, full per-candidate inspection; correlated AI errors remain possible",
  consent: "one explicitly named public repository; local parent evidence never enters a request",
  live_send_supported: false });
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const files = ["docs/experiments/graph-step-adoption-v2/protocol.mjs", "docs/experiments/graph-step-adoption-v2/analysis.mjs",
  "docs/experiments/graph-step-adoption-v2/run.mjs", "docs/experiments/graph-step-adoption/protocol.mjs",
  ...["historical", "baseline", "labels", "prepare", "recovery"].map(n => `docs/experiments/graph-3e-datasets/${n}.mjs`),
  ...["decider", "decision-value", "jev-adapter", "spec-harness-lib", "lib/debug"].map(n => `plugins/dotbabel/src/${n}.mjs`)];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hashFile = file => digest(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const date = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("invalid provenance timestamp");
  return Date.parse(value);
};
export const sourceBindings = () => files.toSorted().map(file => ({ path: file, sha256: hashFile(path.join(repoRoot, file)) }));
export const protocolHash = () => digest(JSON.stringify({ policy: POLICY, rules: RULES, parent_protocol: parentHash(), sources: sourceBindings() }));

export function checkAnnotationPair(row, a, v, cutoff) {
  if (row.step !== POLICY.step || row.label_source !== POLICY.label_source || row.labeled_before_replay !== true ||
      !Array.isArray(row.label) || !a?.annotator || !v?.verifier || a.annotator === v.verifier ||
      a.status !== "labeled" || v.status !== "agree" || v.disagreements?.length !== 0) throw new Error("invalid checked AI provenance");
  for (const [record, timestamp] of [[a, a.labeled_at], [v, v.verified_at]]) {
    if (record.id !== row.id || record.head_sha !== row.head_sha || !same(record.label, row.label) ||
        record.blind_to_predictions !== true || record.inspection_complete !== true || !record.rationale?.trim() ||
        !record.evidence?.length || date(timestamp) > date(cutoff) || row.input.candidates.some(c =>
          typeof record.per_candidate_reasons?.[c] !== "string" || !record.per_candidate_reasons[c].trim())) throw new Error("incomplete checked AI inspection");
  }
}

function packetTime(root, prefix, cutoff) {
  const packet = read(path.join(root, prefix, "labeling/packet-manifest.json"));
  const input = path.join(root, prefix, "inputs/input-manifest.json"), gold = read(path.join(root, prefix, "gold-manifest.json"));
  const created = date(packet.created_at);
  if (packet.input_manifest_sha256 !== hashFile(input) || created < date(read(input).created_at) ||
      created > date(cutoff) || date(gold.reconciled_at) > date(cutoff)) throw new Error("packet freeze provenance differs");
  return created;
}

export function inspectDataset(directory, cutoff = new Date().toISOString()) {
  const root = path.resolve(directory);
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("dataset root must not be a symlink");
  const result = validatePublicLedger(root), manifest = read(path.join(root, "public-manifest.json"));
  const rows = lines(path.join(root, "public-dispatch.jsonl")), unknown = lines(path.join(root, "unknown.jsonl"));
  const am = new Map(lines(path.join(root, "annotations.jsonl")).map(a => [a.id, a]));
  const vm = new Map(lines(path.join(root, "verification.jsonl")).map(v => [v.id, v]));
  const accepted = new Set(), states = new Set(), groups = new Map(), cohorts = Object.fromEntries(POLICY.cohorts.map(c => [c, 0]));
  const packetTimes = Object.fromEntries(POLICY.cohorts.map((c, i) => [c, packetTime(root, i ? "parents/historical" : "parents/baseline", cutoff)]));
  if (am.size !== rows.length || vm.size !== rows.length) throw new Error("checked sidecar coverage differs");
  for (const row of rows) {
    const state = `${row.repo}#${row.pr}:${row.head_sha}`, group = `${row.repo}#${row.pr}`;
    if (row.repo !== result.repository || row.visibility !== "public" || row.source !== `https://github.com/${row.repo}/pull/${row.pr}` ||
        !POLICY.cohorts.includes(row.cohort) || accepted.has(row.id) || states.has(state)) throw new Error("invalid public AI cohort");
    accepted.add(row.id); states.add(state); cohorts[row.cohort]++; groups.set(group, (groups.get(group) ?? 0) + 1);
    const a = am.get(row.id), v = vm.get(row.id); checkAnnotationPair(row, a, v, cutoff);
    if (Math.min(date(a.labeled_at), date(v.verified_at)) < packetTimes[row.cohort]) throw new Error("annotation precedes frozen packet");
  }
  if ([...groups.values()].some(count => count > 2) || unknown.some(r => accepted.has(r.id) || r.label !== null)) throw new Error("unknown or repeated public state admitted");
  const binding = { root, manifest_sha256: hashFile(path.join(root, "public-manifest.json")),
    ledger_sha256: hashFile(path.join(root, "public-dispatch.jsonl")), annotations_sha256: hashFile(path.join(root, "annotations.jsonl")),
    verification_sha256: hashFile(path.join(root, "verification.jsonl")), unknown_sha256: hashFile(path.join(root, "unknown.jsonl")),
    source_policies: { baseline: baselinePolicyHash(), historical: historicalPolicyHash() } };
  return { rows, binding, repository: result.repository, datasets: result.datasets, cohorts, unknown: unknown.length,
    sample_floors_met: result.sample_floors_met, label_source: POLICY.label_source, human_labels: false,
    adoption_eligible: false, private_request_rows: 0, parent_protocol_compatible: manifest.protocol_compatible };
}

function summary(dataset) {
  const { rows, binding, ...metadata } = dataset;
  return { ...metadata, requests: rows.length };
}

export function createLock(root, out, { repo, at = new Date().toISOString() } = {}) {
  if (fs.existsSync(out)) throw new Error("output must be new");
  if (date(at) > Date.now()) throw new Error("lock timestamp must not be in the future");
  const dataset = inspectDataset(root, at);
  if (!repo || repo !== dataset.repository) throw new Error("explicit public repository consent required");
  const record = { version: 2, locked_at: at, policy: POLICY, rules: RULES, protocol_hash: protocolHash(),
    parent_protocol_hash: parentHash(), source_files: sourceBindings(), consent_public_repo: repo,
    dataset: dataset.binding, summary: summary(dataset) };
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { locked: true, protocol_hash: record.protocol_hash, ...record.summary };
}

export function validateLock(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("lock must be a private regular file");
  const record = read(file);
  if (record.version !== 2 || record.protocol_hash !== protocolHash() || record.parent_protocol_hash !== parentHash() ||
      !same(record.policy, POLICY) || !same(record.rules, RULES) || !same(record.source_files, sourceBindings()) || date(record.locked_at) > Date.now()) throw new Error("locked protocol or implementation changed");
  const dataset = inspectDataset(record.dataset.root, record.locked_at);
  if (record.consent_public_repo !== dataset.repository || !same(record.dataset, dataset.binding) || !same(record.summary, summary(dataset))) throw new Error("locked dataset or consent changed");
  return { ...dataset, compatible: true, requests: dataset.rows.length, protocol_hash: record.protocol_hash, lock_sha256: hashFile(file) };
}

export function requestPlan(file, consent) {
  const lock = validateLock(file);
  if (!consent || consent !== lock.repository) throw new Error("explicit public repository consent required");
  if (!lock.sample_floors_met) throw new Error("sample floor is not met");
  return lock.rows.map(row => ({ id: row.id, protocol_hash: lock.protocol_hash, lock_sha256: lock.lock_sha256,
    sample_hash: sampleHash(row), request: jevRequest(row.step, row.input) }));
}
