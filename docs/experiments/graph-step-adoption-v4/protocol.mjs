// Owner-approved AI-label adoption for the retry step, version 4: public CI failures from many repositories.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RULES, protocolHash as parentHash, sampleHash } from "../graph-step-adoption/protocol.mjs";
import { protocolHash as v3Hash, sourceBindings as v3Bindings } from "../graph-step-adoption-v3/protocol.mjs";
import { validateDecisionInput } from "../../../plugins/dotbabel/src/decider.mjs";
import { jevRequest } from "../../../plugins/dotbabel/src/jev-adapter.mjs";

export const ACTIONS = Object.freeze(["retry", "fix", "ask-owner"]);
export const STRATA = Object.freeze(["enriched", "control", "unselected-prior"]);
export const POLICY = Object.freeze({ version: 4, step: "retry", label_source: "ai-annotation-verified",
  evidence_scope: "agreement with separately inspected AI annotations, accepted by the owner as adoption evidence",
  human_labels: false, numeric_rules_changed: false,
  approval: Object.freeze({ by: "owner", date: "2026-10-19", record: "docs/experiments/graph-step-adoption-v3/README.md" }),
  adoption: "ADOPT needs every v1 gate; only ADOPT with a stable bootstrap interval is review-required, and a reviewed pull request then records the thresholds",
  population: "public GitHub Actions job failures from many repositories; phase is the fixed string ci; attempt is the within-run consecutive failure count",
  input: Object.freeze({ phase: "ci", failure_tail_max_chars: 16000,
    failure_tail: "the last characters of the redacted log up to the end of the last ##[error] line, or up to the log end without one" }),
  tail_sufficient: "both reviewers record whether the tail alone supports the label; the subset is reported, never a gate",
  independence: "distinct actors, prediction blindness, exact agreement, a reason for every action; correlated AI errors remain possible",
  consent: "the lock binds the sorted repository list; a send needs fresh consent that names the hash of that list",
  live_send_supported: true,
  send: Object.freeze({ payload: "the request field only", visibility: "every locked repository is public at send time", key: "TYPESAFE_API_KEY from the environment" }) });
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const files = ["protocol", "analysis", "send", "run"].map(n => `docs/experiments/graph-step-adoption-v4/${n}.mjs`);
const DATA_FILES = ["retry.jsonl", "annotations.jsonl", "verification.jsonl", "unknown.jsonl"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hashFile = file => digest(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Key order is not meaning: compare counts with every object's keys sorted.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const unique = (records, what) => {
  const map = new Map(records.map(r => [r.id, r]));
  if (map.size !== records.length) throw new Error(`duplicate ${what} id`);
  return map;
};
const text = value => typeof value === "string" && value.trim().length > 0;
const date = (value, what = "provenance") => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${what} timestamp`);
  return Date.parse(value);
};
export const sourceBindings = () => [...v3Bindings(), ...files.map(file => ({ path: file, sha256: hashFile(path.join(repoRoot, file)) }))]
  .toSorted((a, b) => a.path.localeCompare(b.path));
export const protocolHash = () => digest(JSON.stringify({ policy: POLICY, rules: RULES, parent_protocol: parentHash(),
  v3_protocol: v3Hash(), sources: sourceBindings() }));
export const repositoriesHash = repos => digest(JSON.stringify(repos));

function privateTree(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new Error("dataset root must be a private directory");
  for (const name of ["manifest.json", ...DATA_FILES]) {
    const file = fs.lstatSync(path.join(root, name));
    if (!file.isFile() || (file.mode & 0o777) !== 0o600) throw new Error(`${name} must be a private regular file`);
  }
}

function checkRow(row) {
  if (typeof row.id !== "string" || !row.id || row.step !== "retry" || !/^[\w.-]+\/[\w.-]+$/.test(row.repo ?? "") ||
      !Number.isInteger(row.pr) || row.pr < 1 || !/^[a-f0-9]{40}$/.test(row.head_sha ?? "") || row.visibility !== "public" ||
      typeof row.source !== "string" || !row.source.startsWith(`https://github.com/${row.repo}/`) ||
      !STRATA.includes(row.selection_stratum) || !text(row.cohort) || !["last-error", "log-end"].includes(row.tail_rule) ||
      !Array.isArray(row.tail_line_range) || row.tail_line_range.length !== 2 || !row.tail_line_range.every(Number.isInteger) ||
      row.tail_line_range[0] < 1 || row.tail_line_range[0] > row.tail_line_range[1]) throw new Error("invalid retry provenance");
  validateDecisionInput("retry", row.input);
  const tail = row.input.failure_tail, tailLines = tail.split("\n").filter(Boolean);
  if (row.input.phase !== POLICY.input.phase || tail.length > POLICY.input.failure_tail_max_chars || !tail.trim()) throw new Error("invalid retry input");
  // last-error: the tail ends on an error line; log-end: the log has no error line at all.
  if ((row.tail_rule === "last-error" ? !tailLines.at(-1)?.includes("##[error]") : tail.includes("##[error]")) ||
      tailLines.length > row.tail_line_range[1] - row.tail_line_range[0] + 1) throw new Error("failure tail differs from its tail rule");
  if (!ACTIONS.includes(row.label) || row.label_source !== POLICY.label_source || row.labeled_before_replay !== true) throw new Error("invalid retry label");
}

export function checkAnnotationPair(row, a, v, frozen, sealed) {
  if (!a?.annotator || !v?.verifier || a.annotator === v.verifier || a.status !== "labeled" || v.status !== "agree" ||
      !Array.isArray(v.disagreements) || v.disagreements.length !== 0) throw new Error("invalid checked AI provenance");
  for (const [record, timestamp] of [[a, a.labeled_at], [v, v.verified_at]]) {
    const at = date(timestamp);
    if (record.id !== row.id || record.head_sha !== row.head_sha || record.label !== row.label ||
        record.blind_to_predictions !== true || record.inspection_complete !== true || typeof record.tail_sufficient !== "boolean" || !text(record.rationale) ||
        !Array.isArray(record.evidence) || !record.evidence.length || at < frozen || at > sealed ||
        ACTIONS.some(action => !text(record.per_action_reasons?.[action]))) throw new Error("incomplete checked AI inspection");
  }
  if (date(v.verified_at) < date(a.labeled_at)) throw new Error("verification precedes its annotation");
}

/** Reconstruct and check the whole sealed retry dataset. Cap-determined cases are counted, never admitted. */
export function inspectDataset(directory, cutoff = new Date().toISOString()) {
  const root = path.resolve(directory);
  privateTree(root);
  const manifest = read(path.join(root, "manifest.json"));
  const hashes = Object.fromEntries(DATA_FILES.map(name => [name, hashFile(path.join(root, name))]));
  if (DATA_FILES.some(name => manifest.files?.[name] !== hashes[name])) throw new Error("dataset file hashes differ");
  if (manifest.label_source !== POLICY.label_source) throw new Error("dataset label source differs");
  const frozen = date(manifest.packet_frozen_at), sealed = date(manifest.sealed_at), created = date(manifest.created_at);
  if (!(created <= frozen && frozen <= sealed && sealed <= date(cutoff))) throw new Error("dataset chronology differs");
  const all = lines(path.join(root, "retry.jsonl")), unknown = lines(path.join(root, "unknown.jsonl"));
  const am = unique(lines(path.join(root, "annotations.jsonl")), "annotation");
  const vm = unique(lines(path.join(root, "verification.jsonl")), "verification");
  unique(unknown, "unknown");
  // GitHub repository names ignore case; one repository must have one spelling, so groups and consent agree.
  const spelling = new Map();
  for (const r of [...all, ...unknown]) {
    if (typeof r.repo !== "string") continue;
    const key = r.repo.toLowerCase();
    if (spelling.has(key) && spelling.get(key) !== r.repo) throw new Error("repository spelled two ways");
    spelling.set(key, r.repo);
  }
  if (am.size !== all.length || vm.size !== all.length) throw new Error("checked sidecar coverage differs");
  const ids = new Set(), groups = new Map(), strata = Object.fromEntries(STRATA.map(s => [s, 0])), cohorts = {}, rows = [];
  let capDetermined = 0, tailSufficient = 0;
  for (const row of all) {
    checkRow(row);
    if (ids.has(row.id)) throw new Error("duplicate retry id");
    ids.add(row.id); strata[row.selection_stratum]++; cohorts[row.cohort] = (cohorts[row.cohort] ?? 0) + 1;
    const group = `${row.repo}#${row.pr}`; groups.set(group, (groups.get(group) ?? 0) + 1);
    checkAnnotationPair(row, am.get(row.id), vm.get(row.id), frozen, sealed);
    if (row.input.attempt >= RULES.max_attempts) { capDetermined++; continue; }
    rows.push(row);
    if (am.get(row.id).tail_sufficient && vm.get(row.id).tail_sufficient) tailSufficient++;
  }
  if ([...groups.values()].some(count => count > 2)) throw new Error("more than two cases from one pull request");
  if (unknown.some(r => typeof r.id !== "string" || ids.has(r.id) || r.label !== null || !text(r.reason))) throw new Error("unknown or repeated case admitted");
  const repositories = [...new Set(all.map(r => r.repo))].sort();
  if (!same(manifest.repositories, repositories)) throw new Error("manifest repositories differ");
  const classes = Object.fromEntries(ACTIONS.map(a => [a, all.filter(r => r.label === a).length]));
  if (!same(canonical(manifest.counts), canonical({ rows: all.length, prs: groups.size, classes, unknown: unknown.length, strata, cohorts }))) throw new Error("manifest counts differ");
  const eligible = Object.fromEntries(ACTIONS.map(a => [a, rows.filter(r => r.label === a).length]));
  const prs = new Set(rows.map(r => `${r.repo}#${r.pr}`)).size;
  const floors = rows.length >= RULES.minimum_rows && prs >= RULES.minimum_prs && ACTIONS.every(a => eligible[a] >= RULES.minimum_per_class);
  const binding = { root, manifest_sha256: hashFile(path.join(root, "manifest.json")),
    files: hashes };
  return { rows, binding, repositories, repositories_sha256: repositoriesHash(repositories), label_source: POLICY.label_source,
    human_labels: false, collected: all.length + unknown.length, cap_determined: capDetermined, unknown: unknown.length, strata, cohorts,
    tail_sufficient_both: tailSufficient, eligible: { rows: rows.length, prs, classes: eligible }, shortfall: { rows: Math.max(0, RULES.minimum_rows - rows.length),
      prs: Math.max(0, RULES.minimum_prs - prs), classes: Object.fromEntries(ACTIONS.map(a => [a, Math.max(0, RULES.minimum_per_class - eligible[a])])) },
    sample_floors_met: floors };
}

function summary(dataset) {
  const { rows, binding, ...metadata } = dataset;
  return { ...metadata, requests: rows.length };
}

export function createLock(root, out, { at = new Date().toISOString() } = {}) {
  if (fs.existsSync(out)) throw new Error("output must be new");
  if (date(at, "lock") > Date.now()) throw new Error("lock timestamp must not be in the future");
  const dataset = inspectDataset(root, at);
  const record = { version: 4, locked_at: at, policy: POLICY, rules: RULES, protocol_hash: protocolHash(),
    parent_protocol_hash: parentHash(), v3_protocol_hash: v3Hash(), source_files: sourceBindings(),
    dataset: dataset.binding, summary: summary(dataset) };
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { locked: true, protocol_hash: record.protocol_hash, ...record.summary };
}

export function validateLock(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("lock must be a private regular file");
  const record = read(file);
  if (record.version !== 4 || record.protocol_hash !== protocolHash() || record.parent_protocol_hash !== parentHash() ||
      record.v3_protocol_hash !== v3Hash() || !same(record.policy, POLICY) || !same(record.rules, RULES) ||
      !same(record.source_files, sourceBindings()) || date(record.locked_at, "lock") > Date.now()) throw new Error("locked protocol or implementation changed");
  const dataset = inspectDataset(record.dataset.root, record.locked_at);
  if (!same(record.dataset, dataset.binding) || !same(record.summary, summary(dataset))) throw new Error("locked dataset changed");
  return { ...dataset, compatible: true, requests: dataset.rows.length, protocol_hash: record.protocol_hash, lock_sha256: hashFile(file) };
}

/** The request plan of an already validated lock. */
export function planFor(lock) {
  if (!lock.sample_floors_met) throw new Error("sample floor is not met");
  return lock.rows.map(row => ({ id: row.id, protocol_hash: lock.protocol_hash, lock_sha256: lock.lock_sha256,
    sample_hash: sampleHash(row), request: jevRequest(row.step, row.input) }));
}

export const requestPlan = file => planFor(validateLock(file));
