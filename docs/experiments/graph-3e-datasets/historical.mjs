// Separate public historical-head cohort. No historical assignment or model call is inferred.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { dispatchProfile, RULES } from "../graph-step-adoption/protocol.mjs";
import { validateDecisionInput } from "../../../plugins/dotbabel/src/decider.mjs";
import { save, scrub, summarize } from "./prepare.mjs";
import { sanitizeJSON } from "./recovery.mjs";
import { copyEvidenceTree, reconcile, validateBlindPackets } from "./labels.mjs";
import { validateBaselineGold } from "./baseline.mjs";

const execute = promisify(execFile), digest = value => createHash("sha256").update(value).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const jsonl = rows => rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : "");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reviewers = ["architect-reviewer", "security-auditor", "compliance-auditor", "documentation-writer"];

export const HISTORICAL_POLICY = Object.freeze({ version: 1, cohort: "public-historical-review-head-baseline",
  target_rows: 60, maximum_additional_states_per_pr: 1, seed: RULES.seed,
  population: "merged public PR intermediate heads explicitly attached to archived GitHub reviews",
  sampling: "SHA-256(seed:repo#pr:head); first60 complete eligible states, at most one additional state per PR",
  exclusions: "every previously sampled state, regardless of its label; final heads; full profiles",
  facts: "same explicit frozen collection facts as the final-head cohort; no historical applicability claim",
  labels: "separate blind AI annotations and full independent verification before replay",
  numeric_thresholds_changed: false, historical_assignment_claimed: false });
export const historicalPolicyHash = () => digest(JSON.stringify(HISTORICAL_POLICY) + JSON.stringify(RULES) + dispatchProfile.toString() + historyPool.toString() + historicalCase.toString());

export function historyPool(repo, metadata, batches, prior) {
  const snapshots = new Map(metadata.map(r => [r.number, r])), seen = new Set(prior.filter(r => r.repo === repo).map(r => `${r.pr}:${r.head_sha}`)), pool = new Map();
  for (const batch of batches.toSorted((a, b) => a.ref.localeCompare(b.ref))) {
    for (const node of Object.values(batch.value.data?.repository ?? {})) {
      const snapshot = snapshots.get(node?.number);
      if (!snapshot || snapshot.state !== "MERGED" || node.reviews?.pageInfo?.hasNextPage !== false) continue;
      for (const review of node.reviews.nodes) {
        const head = review.commit?.oid, key = `${node.number}:${head}`;
        if (!/^[a-f0-9]{40}$/.test(head ?? "") || head === snapshot.headRefOid || seen.has(key) || pool.has(key)) continue;
        pool.set(key, { repo, pr: node.number, head_sha: head, review_id: review.databaseId,
          review_at: review.submittedAt, review_url: review.url, source_ref: batch.ref });
      }
    }
  }
  const rank = row => digest(`${HISTORICAL_POLICY.seed}:${repo}#${row.pr}:${row.head_sha}`);
  return [...pool.values()].sort((a, b) => rank(a).localeCompare(rank(b)));
}

export function historicalCase(anchor, pr, comparison, facts) {
  if (pr.number !== anchor.pr || !/^[a-f0-9]{40}$/.test(anchor.head_sha ?? "") || !Number.isInteger(anchor.review_id) ||
      !Number.isFinite(Date.parse(anchor.review_at)) || !anchor.review_url?.startsWith(`https://github.com/${anchor.repo}/pull/${anchor.pr}`) ||
      !/^[a-f0-9]{40}$/.test(pr.base?.sha ?? "") || !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? "")) throw new Error("review_head_provenance_missing");
  if (!comparison.files?.length || comparison.files.length >= 100 || comparison.files.some(f => !f.patch) ||
      !/^[a-f0-9]{40}$/.test(comparison.merge_base_commit?.sha ?? "") || comparison.total_commits !== comparison.commits.length ||
      !comparison.commits.some(c => c.sha === anchor.head_sha)) throw new Error("incomplete_historical_diff");
  const files = comparison.files.map(f => f.filename).sort(), changedLines = comparison.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const profile = dispatchProfile(files, changedLines, facts.protected_paths);
  if (profile.reviewers.length === reviewers.length) throw new Error("no_additional_candidate");
  const input = { profile: profile.reviewers, changed_files: files, changed_lines: changedLines,
    candidates: reviewers.filter(r => !profile.reviewers.includes(r)) };
  validateDecisionInput("dispatch", input);
  return { row: { id: `${anchor.repo}#${anchor.pr}:dispatch-historical-baseline:${anchor.head_sha}`,
    repo: anchor.repo, pr: anchor.pr, head_sha: anchor.head_sha, source: `https://github.com/${anchor.repo}/pull/${anchor.pr}`,
    step: "dispatch", input, label: null, label_source: null, labeled_before_replay: false,
    cohort: HISTORICAL_POLICY.cohort, visibility: "public" },
  proof: { repo: anchor.repo, pr: anchor.pr, head_sha: anchor.head_sha, base_sha: pr.base.sha,
    merge_base_sha: comparison.merge_base_commit.sha, current_pr_head_sha: pr.head.sha,
    review_id: anchor.review_id, review_at: anchor.review_at, review_url: anchor.review_url,
    input, profile_kind: HISTORICAL_POLICY.cohort, profile_name: profile.name,
    historical_assignment_claimed: false, decision_head_verified: true, comparison_complete: true,
    policy_hash: historicalPolicyHash() } };
}

function inventory(root, relative = "") {
  if ((fs.statSync(path.join(root, relative)).mode & 0o777) !== 0o700) throw new Error("directory permissions");
  return fs.readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const ref = path.join(relative, name), file = path.join(root, ref), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("symlink in historical evidence");
    if (stat.isDirectory()) return inventory(root, ref);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("file permissions");
    return [{ path: ref, bytes: stat.size, sha256: digest(fs.readFileSync(file)) }];
  });
}

export async function collectHistorical(configFile, root) {
  if (fs.existsSync(root)) throw new Error("output must be new");
  const config = read(configFile);
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo ?? "")) throw new Error("invalid repository");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const get = async (ref, endpoint) => {
    const file = path.join(root, ref);
    if (fs.existsSync(file)) return read(file);
    const { stdout } = await execute("gh", ["api", endpoint], { maxBuffer: 40 * 1024 * 1024 });
    const value = sanitizeJSON(JSON.parse(stdout)); save(file, JSON.stringify(value) + "\n"); return value;
  };
  const repository = await get("sources/repository.json", `repos/${config.repo}`);
  if (repository.private !== false || repository.full_name !== config.repo) throw new Error("public repository required");
  const facts = read(config.facts), metadata = read(config.metadata), prior = lines(config.prior_inputs).filter(r => r.repo === config.repo), batches = [];
  save(path.join(root, "collection-config.json"), JSON.stringify(config, null, 2) + "\n");
  save(path.join(root, "sources/facts.json"), JSON.stringify(facts) + "\n");
  save(path.join(root, "sources/metadata.json"), JSON.stringify(metadata) + "\n");
  save(path.join(root, "sources/prior-inputs.jsonl"), jsonl(prior));
  for (const name of fs.readdirSync(config.reviews).sort().filter(n => n.startsWith(config.repo.replace("/", "--") + "-") && n.endsWith(".json"))) {
    const ref = `sources/reviews/${name}`, value = read(path.join(config.reviews, name));
    save(path.join(root, ref), JSON.stringify(value) + "\n"); batches.push({ ref, value });
  }
  const pool = historyPool(config.repo, metadata, batches, prior);
  save(path.join(root, "selection-policy.json"), JSON.stringify({ policy: HISTORICAL_POLICY, policy_hash: historicalPolicyHash(),
    frozen_at: new Date().toISOString(), prior_input_file_sha256: digest(fs.readFileSync(config.prior_inputs)), ordered_candidates: pool }, null, 2) + "\n");
  const rows = [], unknown = [], excluded = [], selected = new Set();
  for (const anchor of pool) {
    if (rows.length >= HISTORICAL_POLICY.target_rows) break;
    if (selected.has(anchor.pr)) { excluded.push({ ...anchor, reason: "one_additional_state_per_pr" }); continue; }
    const stem = `evidence/${anchor.pr}-${anchor.head_sha}`, prRef = `evidence/pr-${anchor.pr}.json`, comparisonRef = `${stem}-comparison.json`, proofRef = `${stem}-proof.json`;
    try {
      const pr = await get(prRef, `repos/${config.repo}/pulls/${anchor.pr}`);
      const comparison = await get(comparisonRef, `repos/${config.repo}/compare/${pr.base.sha}...${anchor.head_sha}`);
      const result = historicalCase(anchor, pr, comparison, facts);
      save(path.join(root, proofRef), JSON.stringify({ ...result.proof, facts_ref: "sources/facts.json", metadata_ref: "sources/metadata.json",
        pr_ref: prRef, comparison_ref: comparisonRef, review_ref: anchor.source_ref }, null, 2) + "\n");
      rows.push({ ...result.row, evidence: ["sources/facts.json", "sources/metadata.json", prRef, comparisonRef, anchor.source_ref, proofRef], provenance_ref: proofRef });
      selected.add(anchor.pr);
    } catch (error) {
      const reason = ["review_head_provenance_missing", "incomplete_historical_diff", "no_additional_candidate"].includes(error.message) ? error.message : "historical_source_read_failed";
      (reason === "no_additional_candidate" ? excluded : unknown).push({ ...anchor, reason, evidence: [prRef, comparisonRef] });
    }
    if ((rows.length + unknown.length + excluded.length) % 10 === 0) process.stderr.write(`public historical collection: ${rows.length} pinned; ${unknown.length} unknown; ${excluded.length} excluded\n`);
  }
  save(path.join(root, "annotation-input.jsonl"), jsonl(rows));
  save(path.join(root, "unknown.jsonl"), jsonl(unknown)); save(path.join(root, "excluded.jsonl"), jsonl(excluded));
  save(path.join(root, "input-manifest.json"), JSON.stringify({ version: 1, policy: HISTORICAL_POLICY, policy_hash: historicalPolicyHash(),
    created_at: new Date().toISOString(), labels_present: false, replay_performed: false, historical_assignment_claimed: false,
    counts: { rows: rows.length, groups: selected.size, candidates: pool.length, unknown: unknown.length, excluded: excluded.length },
    files: inventory(root) }, null, 2) + "\n");
  return validateHistoricalInputs(root);
}

function validateSelectionOutcome(root, pool, rows, unknown, excluded) {
  const expectedRows = [], expectedUnknown = [], expectedExcluded = [], selected = new Set();
  const facts = read(path.join(root, "sources/facts.json"));
  for (const anchor of pool) {
    if (expectedRows.length >= HISTORICAL_POLICY.target_rows) break;
    if (selected.has(anchor.pr)) { expectedExcluded.push({ ...anchor, reason: "one_additional_state_per_pr" }); continue; }
    const stem = `evidence/${anchor.pr}-${anchor.head_sha}`, prRef = `evidence/pr-${anchor.pr}.json`, comparisonRef = `${stem}-comparison.json`, proofRef = `${stem}-proof.json`;
    try {
      const pinned = historicalCase(anchor, read(path.join(root, prRef)), read(path.join(root, comparisonRef)), facts);
      expectedRows.push({ ...pinned.row, evidence: ["sources/facts.json", "sources/metadata.json", prRef, comparisonRef, anchor.source_ref, proofRef], provenance_ref: proofRef });
      selected.add(anchor.pr);
    } catch (error) {
      const reason = ["review_head_provenance_missing", "incomplete_historical_diff", "no_additional_candidate"].includes(error.message) ? error.message : "historical_source_read_failed";
      (reason === "no_additional_candidate" ? expectedExcluded : expectedUnknown).push({ ...anchor, reason, evidence: [prRef, comparisonRef] });
    }
  }
  if (!same(rows, expectedRows) || !same(unknown, expectedUnknown) || !same(excluded, expectedExcluded)) throw new Error("historical selection outcome differs");
}

export function validateHistoricalInputs(root) {
  const manifest = read(path.join(root, "input-manifest.json"));
  if (manifest.policy_hash !== historicalPolicyHash() || !same(manifest.policy, HISTORICAL_POLICY) || manifest.labels_present !== false ||
      manifest.replay_performed !== false || manifest.historical_assignment_claimed !== false) throw new Error("historical policy changed");
  if (!same(inventory(root).filter(f => f.path !== "input-manifest.json"), manifest.files)) throw new Error("historical hashes differ");
  const safe = ref => {
    const file = typeof ref === "string" && !path.isAbsolute(ref) ? path.resolve(root, ref) : "";
    if (!file.startsWith(path.resolve(root) + path.sep) || !fs.lstatSync(file).isFile()) throw new Error("unsafe historical reference");
    return file;
  };
  const config = read(path.join(root, "collection-config.json")), repository = read(path.join(root, "sources/repository.json"));
  if (repository.private !== false || repository.full_name !== config.repo) throw new Error("public repository required");
  const batches = fs.readdirSync(path.join(root, "sources/reviews")).sort().map(n => ({ ref: `sources/reviews/${n}`, value: read(safe(`sources/reviews/${n}`)) }));
  const pool = historyPool(config.repo, read(path.join(root, "sources/metadata.json")), batches, lines(path.join(root, "sources/prior-inputs.jsonl")));
  const policy = read(path.join(root, "selection-policy.json"));
  if (!same(policy.policy, HISTORICAL_POLICY) || policy.policy_hash !== historicalPolicyHash() || !same(policy.ordered_candidates, pool)) throw new Error("historical selection changed");
  const rows = lines(path.join(root, "annotation-input.jsonl")), prs = new Set(), ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id) || prs.has(row.pr) || row.repo !== config.repo || row.label !== null || row.label_source !== null || row.labeled_before_replay !== false) throw new Error("duplicate or labeled historical input");
    ids.add(row.id); prs.add(row.pr); for (const ref of row.evidence) safe(ref);
    const proof = read(safe(row.provenance_ref)), anchor = pool.find(a => a.pr === row.pr && a.head_sha === row.head_sha);
    if (!anchor || proof.review_ref !== anchor.source_ref) throw new Error("historical review anchor mismatch");
    const pinned = historicalCase(anchor, read(safe(proof.pr_ref)), read(safe(proof.comparison_ref)), read(safe(proof.facts_ref)));
    for (const [key, value] of Object.entries(pinned.proof)) if (!same(proof[key], value)) throw new Error("historical proof mismatch");
    for (const [key, value] of Object.entries(pinned.row)) if (!same(row[key], value)) throw new Error("historical input mismatch");
  }
  const counts = { rows: rows.length, groups: prs.size, candidates: pool.length,
    unknown: lines(path.join(root, "unknown.jsonl")).length, excluded: lines(path.join(root, "excluded.jsonl")).length };
  if (!same(counts, manifest.counts) || rows.length > HISTORICAL_POLICY.target_rows) throw new Error("historical counts differ");
  validateSelectionOutcome(root, pool, rows, lines(path.join(root, "unknown.jsonl")), lines(path.join(root, "excluded.jsonl")));
  return { structural_valid: true, ...counts, labels_present: false, replay_performed: false, policy_hash: manifest.policy_hash };
}

function historicalGoldResult(inputRoot, labelingRoot, cutoff) {
  validateHistoricalInputs(inputRoot);
  const cases = lines(path.join(inputRoot, "annotation-input.jsonl"));
  validateBlindPackets(cases, labelingRoot);
  for (const name of ["annotator-input.jsonl", "verifier-input.jsonl"]) {
    const packets = new Map(lines(path.join(labelingRoot, name)).map(r => [r.id, r]));
    for (const row of cases) {
      const proof = read(path.join(inputRoot, row.provenance_ref)), packet = packets.get(row.id);
      if (!same(packet.pinned_files, read(path.join(inputRoot, proof.comparison_ref)).files) ||
          !same(packet.protected_paths, read(path.join(inputRoot, proof.facts_ref)).protected_paths)) throw new Error("blind historical patch mismatch");
    }
  }
  const annotations = lines(path.join(labelingRoot, "annotations.jsonl"));
  const independent = lines(path.join(labelingRoot, "independent-verification.jsonl"));
  const result = reconcile(cases, annotations, independent, cutoff), proofs = [];
  const accepted = result.accepted.map(row => {
    const ref = `evidence/${digest(row.id)}.json`, original = read(path.join(inputRoot, row.provenance_ref));
    const proof = Object.fromEntries(Object.entries(original).map(([k, v]) => [k, k.endsWith("_ref") ? `inputs/${v}` : v]));
    proofs.push({ ref, value: { ...proof, original_provenance_ref: `inputs/${row.provenance_ref}` } });
    return { ...row, evidence: [...row.evidence.map(r => `inputs/${r}`), ref], provenance_ref: ref,
      annotation_ref: "annotations.jsonl", verification_ref: "verification.jsonl" };
  });
  const canonical = (source, row, raw, packet) => ({ ...source, label: row.label, source_citations: source.evidence,
    evidence: [`labeling/${raw}`, `labeling/${packet}`, row.provenance_ref] });
  const unknown = result.unknown.map(row => ({ ...row, evidence: row.evidence.map(r => `inputs/${r}`),
    provenance_ref: `inputs/${row.provenance_ref}`, annotation_ref: "labeling/annotations.jsonl", verification_ref: "labeling/independent-verification.jsonl" }));
  return { accepted, unknown, proofs, datasets: summarize(accepted),
    annotations: accepted.map(row => canonical(annotations.find(a => a.id === row.id), row, "annotations.jsonl", "annotator-input.jsonl")),
    verifications: accepted.map(row => canonical(result.verifications.find(v => v.id === row.id), row, "independent-verification.jsonl", "verifier-input.jsonl")) };
}

function saveResult(root, result, ledger = "dispatch.jsonl") {
  for (const proof of result.proofs) save(path.join(root, proof.ref), JSON.stringify(proof.value, null, 2) + "\n");
  save(path.join(root, ledger), jsonl(result.accepted)); save(path.join(root, "unknown.jsonl"), jsonl(result.unknown));
  save(path.join(root, "annotations.jsonl"), jsonl(result.annotations)); save(path.join(root, "verification.jsonl"), jsonl(result.verifications));
}

function checkResult(root, result, ledger = "dispatch.jsonl") {
  for (const proof of result.proofs) if (!same(read(path.join(root, proof.ref)), proof.value)) throw new Error("canonical historical proof changed");
  for (const [file, rows] of [[ledger, result.accepted], ["unknown.jsonl", result.unknown], ["annotations.jsonl", result.annotations], ["verification.jsonl", result.verifications]])
    if (fs.readFileSync(path.join(root, file), "utf8") !== jsonl(rows)) throw new Error("historical label export differs");
}

export function finalizeHistorical(inputRoot, labelingRoot, root, cutoff = new Date().toISOString()) {
  if (fs.existsSync(root)) throw new Error("output must be new");
  const result = historicalGoldResult(inputRoot, labelingRoot, cutoff);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); copyEvidenceTree(inputRoot, path.join(root, "inputs"));
  copyEvidenceTree(labelingRoot, path.join(root, "labeling")); saveResult(root, result);
  save(path.join(root, "gold-manifest.json"), JSON.stringify({ version: 1, policy_hash: historicalPolicyHash(), rules: RULES,
    reconciled_at: cutoff, human_labels: false, label_source: "ai-annotation-verified", protocol_compatible: false,
    replay_performed: false, datasets: result.datasets, unknown: result.unknown.length, files: inventory(root) }, null, 2) + "\n");
  return validateHistoricalGold(root);
}

export function validateHistoricalGold(root) {
  const manifest = read(path.join(root, "gold-manifest.json"));
  if (manifest.policy_hash !== historicalPolicyHash() || !same(manifest.rules, RULES) || manifest.human_labels !== false ||
      manifest.label_source !== "ai-annotation-verified" || manifest.protocol_compatible !== false || manifest.replay_performed !== false) throw new Error("historical gold policy changed");
  if (!same(inventory(root).filter(f => f.path !== "gold-manifest.json"), manifest.files)) throw new Error("historical gold hashes differ");
  const result = historicalGoldResult(path.join(root, "inputs"), path.join(root, "labeling"), manifest.reconciled_at);
  checkResult(root, result);
  if (!same(manifest.datasets, result.datasets) || manifest.unknown !== result.unknown.length) throw new Error("historical gold counts differ");
  return { structural_valid: true, datasets: result.datasets, unknown: result.unknown.length,
    protocol_compatible: false, replay_performed: false, hashed_files: manifest.files.length };
}

function publicResult(baselineRoot, historicalRoot) {
  validateBaselineGold(baselineRoot); validateHistoricalGold(historicalRoot);
  const repo = read(path.join(historicalRoot, "inputs/collection-config.json")).repo;
  const accepted = [], unknown = [], proofs = [], annotations = [], verifications = [], states = new Set();
  for (const [prefix, sourceRoot] of [["parents/baseline", baselineRoot], ["parents/historical", historicalRoot]]) {
    const am = new Map(lines(path.join(sourceRoot, "annotations.jsonl")).map(r => [r.id, r]));
    const vm = new Map(lines(path.join(sourceRoot, "verification.jsonl")).map(r => [r.id, r]));
    for (const row of lines(path.join(sourceRoot, "dispatch.jsonl")).filter(r => r.repo === repo)) {
      const state = `${row.repo}#${row.pr}:${row.head_sha}`;
      if (states.has(state)) throw new Error("duplicate public decision head"); states.add(state);
      const ref = `evidence/${digest(row.id)}.json`, original = read(path.join(sourceRoot, row.provenance_ref));
      const proof = Object.fromEntries(Object.entries(original).map(([k, v]) => [k, k.endsWith("_ref") ? `${prefix}/${v}` : v]));
      proofs.push({ ref, value: { ...proof, source_proof_ref: `${prefix}/${row.provenance_ref}` } });
      accepted.push({ ...row, evidence: [...row.evidence.map(r => `${prefix}/${r}`), ref], provenance_ref: ref,
        annotation_ref: "annotations.jsonl", verification_ref: "verification.jsonl" });
      const canonical = (source, file) => ({ ...source, evidence: [...source.evidence.map(r => `${prefix}/${r}`), ref],
        source_sidecar_ref: `${prefix}/${file}` });
      annotations.push(canonical(am.get(row.id), "annotations.jsonl")); verifications.push(canonical(vm.get(row.id), "verification.jsonl"));
    }
    unknown.push(...lines(path.join(sourceRoot, "unknown.jsonl")).filter(r => r.repo === repo).map(row => ({ ...row,
      evidence: row.evidence.map(r => `${prefix}/${r}`), provenance_ref: `${prefix}/${row.provenance_ref}`,
      annotation_ref: `${prefix}/${row.annotation_ref}`, verification_ref: `${prefix}/${row.verification_ref}` })));
  }
  return { repo, accepted, unknown, proofs, annotations, verifications, datasets: summarize(accepted) };
}

export function combinePublic(baselineRoot, historicalRoot, root) {
  if (fs.existsSync(root)) throw new Error("output must be new");
  const result = publicResult(baselineRoot, historicalRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  copyEvidenceTree(baselineRoot, path.join(root, "parents/baseline")); copyEvidenceTree(historicalRoot, path.join(root, "parents/historical"));
  saveResult(root, result, "public-dispatch.jsonl");
  save(path.join(root, "public-manifest.json"), JSON.stringify({ version: 1, created_at: new Date().toISOString(),
    repository: result.repo, source_cohorts: ["offline-locked-baseline", HISTORICAL_POLICY.cohort],
    local_parent_evidence_may_include_private_data: true, model_request_ledger: "public-dispatch.jsonl", private_request_rows: 0,
    rules: RULES, human_labels: false, protocol_compatible: false, replay_performed: false,
    sample_floors_met: result.datasets.dispatch.ready, datasets: result.datasets, unknown: result.unknown.length,
    files: inventory(root) }, null, 2) + "\n");
  return validatePublicLedger(root);
}

export function validatePublicLedger(root) {
  const manifest = read(path.join(root, "public-manifest.json"));
  if (!same(manifest.rules, RULES) || manifest.human_labels !== false || manifest.protocol_compatible !== false || manifest.replay_performed !== false ||
      manifest.model_request_ledger !== "public-dispatch.jsonl" || manifest.private_request_rows !== 0 || manifest.local_parent_evidence_may_include_private_data !== true) throw new Error("public ledger policy changed");
  if (!same(inventory(root).filter(f => f.path !== "public-manifest.json"), manifest.files)) throw new Error("public ledger hashes differ");
  const result = publicResult(path.join(root, "parents/baseline"), path.join(root, "parents/historical")); checkResult(root, result, "public-dispatch.jsonl");
  if (manifest.repository !== result.repo || result.accepted.some(r => r.repo !== result.repo) || !same(manifest.datasets, result.datasets) ||
      !same(manifest.source_cohorts, ["offline-locked-baseline", HISTORICAL_POLICY.cohort]) || manifest.unknown !== result.unknown.length ||
      manifest.sample_floors_met !== result.datasets.dispatch.ready) throw new Error("public ledger counts differ");
  return { structural_valid: true, repository: result.repo, datasets: result.datasets, unknown: result.unknown.length,
    private_request_rows: 0, sample_floors_met: result.datasets.dispatch.ready, protocol_compatible: false,
    replay_performed: false, hashed_files: manifest.files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const result = command === "collect" ? await collectHistorical(...args) : command === "validate" ? validateHistoricalInputs(...args) :
      command === "finalize" ? finalizeHistorical(...args) : command === "validate-gold" ? validateHistoricalGold(...args) :
      command === "combine-public" ? combinePublic(...args) : command === "validate-public" ? validatePublicLedger(...args) : null;
    if (!result) throw new Error("expected collect CONFIG NEW_OUT, validate INPUT_RUN, finalize INPUT_RUN LABELS NEW_OUT [CUTOFF], validate-gold GOLD_RUN, combine-public BASELINE_GOLD HISTORICAL_GOLD NEW_OUT, or validate-public PUBLIC_RUN");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) { process.stderr.write(scrub(error.message) + "\n"); process.exitCode = 2; }
}
