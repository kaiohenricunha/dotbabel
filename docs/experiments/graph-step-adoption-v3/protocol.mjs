// Owner-approved AI-label adoption evidence, version 3. The v2 files stay byte-identical.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RULES, protocolHash as parentHash, sampleHash } from "../graph-step-adoption/protocol.mjs";
import { inspectDataset, protocolHash as v2Hash, sourceBindings as v2Bindings } from "../graph-step-adoption-v2/protocol.mjs";
import { jevRequest } from "../../../plugins/dotbabel/src/jev-adapter.mjs";

export const POLICY = Object.freeze({ version: 3, step: "dispatch", label_source: "ai-annotation-verified",
  evidence_scope: "agreement with separately inspected AI annotations, accepted by the owner as adoption evidence",
  human_labels: false, numeric_rules_changed: false,
  approval: Object.freeze({ by: "owner", date: "2026-10-19", record: "docs/experiments/graph-step-adoption-v3/README.md" }),
  adoption: "ADOPT needs every v1 gate and a stable bootstrap interval; a reviewed pull request then records the thresholds",
  independence: "distinct actors, prediction blindness, exact agreement, full per-candidate inspection; correlated AI errors remain possible",
  consent: "the lock names one public repository; a send needs a second, fresh consent for the same repository",
  live_send_supported: true,
  send: Object.freeze({ payload: "the request field only", visibility: "public at send time", key: "TYPESAFE_API_KEY from the environment" }) });
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const files = ["protocol", "analysis", "send", "run"].map(n => `docs/experiments/graph-step-adoption-v3/${n}.mjs`);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hashFile = file => digest(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const sourceBindings = () => [...v2Bindings(), ...files.map(file => ({ path: file, sha256: hashFile(path.join(repoRoot, file)) }))]
  .toSorted((a, b) => a.path.localeCompare(b.path));
export const protocolHash = () => digest(JSON.stringify({ policy: POLICY, rules: RULES, parent_protocol: parentHash(),
  v2_protocol: v2Hash(), sources: sourceBindings() }));

function summary(dataset) {
  const { rows, binding, adoption_eligible, ...metadata } = dataset;
  return { ...metadata, requests: rows.length };
}

export function createLock(root, out, { repo, at = new Date().toISOString() } = {}) {
  if (fs.existsSync(out)) throw new Error("output must be new");
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.now()) throw new Error("lock timestamp must not be in the future");
  const dataset = inspectDataset(root, at);
  if (!repo || repo !== dataset.repository) throw new Error("explicit public repository consent required");
  const record = { version: 3, locked_at: at, policy: POLICY, rules: RULES, protocol_hash: protocolHash(),
    parent_protocol_hash: parentHash(), v2_protocol_hash: v2Hash(), source_files: sourceBindings(),
    consent_public_repo: repo, dataset: dataset.binding, summary: summary(dataset) };
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { locked: true, protocol_hash: record.protocol_hash, ...record.summary };
}

export function validateLock(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("lock must be a private regular file");
  const record = read(file);
  if (record.version !== 3 || record.protocol_hash !== protocolHash() || record.parent_protocol_hash !== parentHash() ||
      record.v2_protocol_hash !== v2Hash() || !same(record.policy, POLICY) || !same(record.rules, RULES) ||
      !same(record.source_files, sourceBindings()) || Date.parse(record.locked_at) > Date.now()) throw new Error("locked protocol or implementation changed");
  const dataset = inspectDataset(record.dataset.root, record.locked_at);
  if (record.consent_public_repo !== dataset.repository || !same(record.dataset, dataset.binding) || !same(record.summary, summary(dataset))) throw new Error("locked dataset or consent changed");
  return { ...dataset, adoption_eligible: undefined, compatible: true, requests: dataset.rows.length,
    protocol_hash: record.protocol_hash, lock_sha256: hashFile(file) };
}

export function requestPlan(file, consent) {
  const lock = validateLock(file);
  if (!consent || consent !== lock.repository) throw new Error("explicit public repository consent required");
  if (!lock.sample_floors_met) throw new Error("sample floor is not met");
  return lock.rows.map(row => ({ id: row.id, protocol_hash: lock.protocol_hash, lock_sha256: lock.lock_sha256,
    sample_hash: sampleHash(row), request: jevRequest(row.step, row.input) }));
}
