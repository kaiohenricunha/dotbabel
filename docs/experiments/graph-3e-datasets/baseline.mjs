// Separate offline-baseline cohort. Profiles are computed, never claimed as historical assignments.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { dispatchProfile, RULES } from "../graph-step-adoption/protocol.mjs";
import { save, scrub, summarize } from "./prepare.mjs";
import { sanitizeJSON } from "./recovery.mjs";
import { copyEvidenceTree, reconcile, validateBlindPackets } from "./labels.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const jsonl = rows => rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : "");
const execute = promisify(execFile);
const reviewers = ["architect-reviewer", "security-auditor", "compliance-auditor", "documentation-writer"];

export const BASELINE_POLICY = Object.freeze({ version: 1, cohort: "offline-locked-baseline",
  target_rows: 180, seed: RULES.seed, population: "merged PR snapshots with complete changed-file metadata",
  sampling: "repository configuration order; SHA-256(seed:repo#pr:head) within each repository; first 180 complete eligible inputs",
  facts: "explicit frozen collection facts; not a historical reviewer assignment",
  unknowns: "preserve incomplete evidence; advance in the fixed order without inspecting labels",
  labels: "separate blind AI annotations and full independent verification before any replay",
  numeric_thresholds_changed: false, historical_assignment_claimed: false });

export const baselinePolicyHash = () => digest(JSON.stringify(BASELINE_POLICY) + JSON.stringify(RULES) + dispatchProfile.toString() + baselineCase.toString() + baselinePool.toString());

export function baselinePool(repo, snapshots, facts) {
  const eligible = [], excluded = [], seen = new Set();
  for (const pr of snapshots) {
    if (!Number.isInteger(pr.number) || seen.has(pr.number)) throw new Error("invalid or duplicate PR snapshot"); seen.add(pr.number);
    let reason;
    if (pr.state !== "MERGED") reason = "not_merged_population";
    else if (!/^[a-f0-9]{40}$/.test(pr.headRefOid ?? "") || !Array.isArray(pr.files) || !pr.files.length ||
      pr.files.length >= 100 || pr.files.length !== pr.changedFiles || !Number.isInteger(pr.additions) ||
      !Number.isInteger(pr.deletions) || pr.additions < 0 || pr.deletions < 0) reason = "incomplete_metadata";
    else if (dispatchProfile(pr.files.map(f => f.path), pr.additions + pr.deletions, facts.protected_paths).reviewers.length === reviewers.length)
      reason = "no_additional_candidate";
    if (reason) excluded.push({ repo, pr: pr.number, head_sha: pr.headRefOid, reason });
    else eligible.push(pr);
  }
  const rank = pr => digest(`${BASELINE_POLICY.seed}:${repo}#${pr.number}:${pr.headRefOid}`);
  eligible.sort((a, b) => rank(a).localeCompare(rank(b)));
  return { eligible, excluded };
}

export function baselineCase(repo, snapshot, facts, pr, comparison) {
  if (pr.head?.sha !== snapshot.headRefOid || !/^[a-f0-9]{40}$/.test(pr.base?.sha ?? "")) throw new Error("snapshot_head_changed");
  if (!comparison.files?.length || comparison.files.length >= 300 || comparison.files.some(f => !f.patch) ||
    comparison.total_commits !== comparison.commits.length || !comparison.commits.some(c => c.sha === snapshot.headRefOid)) throw new Error("incomplete_pinned_diff");
  const files = comparison.files.map(f => f.filename).sort(), lines = comparison.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (JSON.stringify(files) !== JSON.stringify(snapshot.files.map(f => f.path).sort()) || lines !== snapshot.additions + snapshot.deletions) throw new Error("snapshot_diff_disagrees");
  const profile = dispatchProfile(files, lines, facts.protected_paths);
  if (profile.reviewers.length === reviewers.length) throw new Error("no_additional_candidate");
  const input = { profile: profile.reviewers, changed_files: files, changed_lines: lines,
    candidates: reviewers.filter(r => !profile.reviewers.includes(r)) };
  return { row: { id: `${repo}#${snapshot.number}:dispatch-baseline:${snapshot.headRefOid}`, repo, pr: snapshot.number,
    head_sha: snapshot.headRefOid, source: `https://github.com/${repo}/pull/${snapshot.number}`, step: "dispatch",
    input, label: null, label_source: null, labeled_before_replay: false },
  proof: { repo, pr: snapshot.number, head_sha: snapshot.headRefOid, base_sha: pr.base.sha,
    merge_base_sha: comparison.merge_base_commit.sha, input, profile_kind: BASELINE_POLICY.cohort,
    historical_assignment_claimed: false, policy_hash: baselinePolicyHash(), profile_name: profile.name,
    facts_sha256: digest(JSON.stringify(facts)), decision_head_verified: true, comparison_complete: true } };
}

function inventory(root, relative = "") {
  if ((fs.statSync(path.join(root, relative)).mode & 0o777) !== 0o700) throw new Error("directory permissions");
  return fs.readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const ref = path.join(relative, name), file = path.join(root, ref), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("symlink in baseline evidence");
    if (stat.isDirectory()) return inventory(root, ref);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("file permissions");
    return [{ path: ref, bytes: stat.size, sha256: digest(fs.readFileSync(file)) }];
  });
}

export async function collectBaseline(configFile, root) {
  if (fs.existsSync(root)) throw new Error("output must be new");
  const config = read(configFile), pools = [], excluded = [], coverage = [];
  for (const repository of config.repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository.repo) || !["public", "private"].includes(repository.visibility)) throw new Error("invalid repository configuration");
    const facts = read(repository.facts), snapshots = read(repository.prs), pool = baselinePool(repository.repo, snapshots, facts);
    pools.push({ ...repository, facts, eligible: pool.eligible }); excluded.push(...pool.excluded);
    coverage.push({ repo: repository.repo, snapshots: snapshots.length, eligible: pool.eligible.length,
      visibility: repository.visibility, metadata_sha256: digest(fs.readFileSync(repository.prs)), facts_sha256: digest(fs.readFileSync(repository.facts)) });
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  save(path.join(root, "collection-config.json"), JSON.stringify(config, null, 2) + "\n");
  save(path.join(root, "selection-policy.json"), JSON.stringify({ policy: BASELINE_POLICY, policy_hash: baselinePolicyHash(),
    frozen_at: new Date().toISOString(), coverage, ordered_candidates: pools.flatMap(p => p.eligible.map(r => ({ repo: p.repo, pr: r.number, head_sha: r.headRefOid }))) }, null, 2) + "\n");
  const cases = [], unknown = [];
  for (const pool of pools) {
    const slug = pool.repo.replace("/", "--"), factsRef = `sources/${slug}-facts.json`, metadataRef = `sources/${slug}-prs.json`;
    save(path.join(root, factsRef), JSON.stringify(pool.facts) + "\n");
    save(path.join(root, metadataRef), JSON.stringify(read(pool.prs)) + "\n");
    for (const snapshot of pool.eligible) {
      if (cases.length >= BASELINE_POLICY.target_rows) break;
      const stem = `evidence/${slug}-${snapshot.number}-${snapshot.headRefOid}`;
      const refs = { pr: `${stem}-pr.json`, comparison: `${stem}-comparison.json`, proof: `${stem}-proof.json` };
      const get = async (ref, endpoint) => {
        const { stdout } = await execute("gh", ["api", endpoint], { maxBuffer: 40 * 1024 * 1024 });
        const value = sanitizeJSON(JSON.parse(stdout)); save(path.join(root, ref), JSON.stringify(value) + "\n"); return value;
      };
      try {
        const pr = await get(refs.pr, `repos/${pool.repo}/pulls/${snapshot.number}`);
        const comparison = await get(refs.comparison, `repos/${pool.repo}/compare/${pr.base.sha}...${snapshot.headRefOid}`);
        const candidate = baselineCase(pool.repo, snapshot, pool.facts, pr, comparison);
        save(path.join(root, refs.proof), JSON.stringify({ ...candidate.proof, facts_ref: factsRef, metadata_ref: metadataRef,
          pr_ref: refs.pr, comparison_ref: refs.comparison }, null, 2) + "\n");
        cases.push({ ...candidate.row, cohort: BASELINE_POLICY.cohort, visibility: pool.visibility,
          evidence: [factsRef, metadataRef, refs.pr, refs.comparison, refs.proof], provenance_ref: refs.proof });
      } catch (error) {
        const reasons = ["snapshot_head_changed", "incomplete_pinned_diff", "snapshot_diff_disagrees", "no_additional_candidate"];
        unknown.push({ repo: pool.repo, pr: snapshot.number, head_sha: snapshot.headRefOid,
          reason: reasons.includes(error.message) ? error.message : "pinned_source_read_failed", evidence: [refs.pr, refs.comparison] });
      }
      if ((cases.length + unknown.length) % 10 === 0) process.stderr.write(`baseline collection: ${cases.length} pinned; ${unknown.length} unknown\n`);
    }
  }
  save(path.join(root, "annotation-input.jsonl"), jsonl(cases));
  save(path.join(root, "unknown.jsonl"), jsonl(unknown)); save(path.join(root, "excluded.jsonl"), jsonl(excluded));
  const counts = { rows: cases.length, groups: new Set(cases.map(r => `${r.repo}#${r.pr}`)).size,
    by_repo: Object.fromEntries(pools.map(p => [p.repo, cases.filter(r => r.repo === p.repo).length])), unknown: unknown.length, excluded: excluded.length };
  save(path.join(root, "input-manifest.json"), JSON.stringify({ version: 1, policy: BASELINE_POLICY, policy_hash: baselinePolicyHash(),
    created_at: new Date().toISOString(), historical_assignment_claimed: false, replay_performed: false,
    labels_present: false, counts, files: inventory(root) }, null, 2) + "\n");
  return validateBaselineInputs(root);
}

export function validateBaselineInputs(root) {
  const manifest = read(path.join(root, "input-manifest.json"));
  if (manifest.policy_hash !== baselinePolicyHash() || JSON.stringify(manifest.policy) !== JSON.stringify(BASELINE_POLICY) || manifest.labels_present !== false || manifest.replay_performed !== false || manifest.historical_assignment_claimed !== false) throw new Error("baseline policy changed");
  if (JSON.stringify(inventory(root).filter(f => f.path !== "input-manifest.json")) !== JSON.stringify(manifest.files)) throw new Error("baseline evidence hashes differ");
  const safe = ref => {
    if (typeof ref !== "string" || path.isAbsolute(ref)) throw new Error("unsafe baseline evidence reference");
    const file = path.resolve(root, ref);
    if (!file.startsWith(path.resolve(root) + path.sep) || !fs.lstatSync(file).isFile()) throw new Error("unsafe baseline evidence reference");
    return file;
  };
  const rows = fs.readFileSync(path.join(root, "annotation-input.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse), ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id) || row.label !== null || row.label_source !== null || row.labeled_before_replay !== false) throw new Error("duplicate or labeled baseline input"); ids.add(row.id);
    for (const ref of row.evidence) safe(ref);
    const proof = read(safe(row.provenance_ref)), metadata = read(safe(proof.metadata_ref));
    const pinned = baselineCase(row.repo, metadata.find(p => p.number === row.pr), read(safe(proof.facts_ref)),
      read(safe(proof.pr_ref)), read(safe(proof.comparison_ref)));
    if (proof.policy_hash !== baselinePolicyHash() || !equivalentInput(pinned.row.input, row.input) ||
      pinned.row.id !== row.id || pinned.row.head_sha !== row.head_sha || pinned.row.source !== row.source || row.step !== "dispatch" ||
      row.cohort !== BASELINE_POLICY.cohort || proof.historical_assignment_claimed !== false) throw new Error("baseline input provenance mismatch");
  }
  const config = read(path.join(root, "collection-config.json")), countLines = name => fs.readFileSync(path.join(root, name), "utf8").split("\n").filter(Boolean).length;
  const counts = { rows: rows.length, groups: new Set(rows.map(r => `${r.repo}#${r.pr}`)).size,
    by_repo: Object.fromEntries(config.repositories.map(p => [p.repo, rows.filter(r => r.repo === p.repo).length])),
    unknown: countLines("unknown.jsonl"), excluded: countLines("excluded.jsonl") };
  if (JSON.stringify(manifest.counts) !== JSON.stringify(counts)) throw new Error("baseline counts differ");
  return { structural_valid: true, ...manifest.counts, labels_present: false, replay_performed: false, policy_hash: manifest.policy_hash };
}

function equivalentInput(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function baselineGoldResult(inputRoot, labelingRoot, cutoff) {
  validateBaselineInputs(inputRoot);
  const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const cases = lines(path.join(inputRoot, "annotation-input.jsonl"));
  validateBlindPackets(cases, labelingRoot);
  for (const name of ["annotator-input.jsonl", "verifier-input.jsonl"]) {
    const packets = new Map(lines(path.join(labelingRoot, name)).map(r => [r.id, r]));
    for (const row of cases) {
      const proof = read(path.join(inputRoot, row.provenance_ref)), packet = packets.get(row.id);
      if (!equivalentInput(packet.pinned_files, read(path.join(inputRoot, proof.comparison_ref)).files) ||
          !equivalentInput(packet.protected_paths, read(path.join(inputRoot, proof.facts_ref)).protected_paths))
        throw new Error("blind patch evidence mismatch");
    }
  }
  const annotations = lines(path.join(labelingRoot, "annotations.jsonl"));
  const independent = lines(path.join(labelingRoot, "independent-verification.jsonl"));
  const routingFile = path.join(labelingRoot, "verification-routing.json");
  if (fs.existsSync(routingFile)) {
    const routing = read(routingFile), assignments = new Map(routing.routing.map(r => [r.id, r.actor]));
    if (routing.labels_consulted !== false || !routing.reason || !Number.isFinite(Date.parse(routing.created_at)) ||
        Date.parse(routing.created_at) > Date.parse(cutoff) || assignments.size !== cases.length ||
        routing.routing.length !== cases.length || independent.some(v => assignments.get(v.id) !== v.verifier))
      throw new Error("verification routing mismatch");
  }
  const result = reconcile(cases, annotations, independent, cutoff);
  const proofs = [];
  const accepted = result.accepted.map(row => {
    const proof = read(path.join(inputRoot, row.provenance_ref)), ref = `evidence/${digest(row.id)}.json`;
    for (const key of ["facts_ref", "metadata_ref", "pr_ref", "comparison_ref"]) proof[key] = `inputs/${proof[key]}`;
    proofs.push({ ref, value: { ...proof, original_provenance_ref: `inputs/${row.provenance_ref}` } });
    return { ...row, evidence: [...row.evidence.map(r => `inputs/${r}`), ref], provenance_ref: ref,
      annotation_ref: "annotations.jsonl", verification_ref: "verification.jsonl" };
  });
  const canonical = (source, row, raw, packet) => ({ ...source, label: row.label, source_citations: source.evidence,
    evidence: [`labeling/${raw}`, `labeling/${packet}`, row.provenance_ref] });
  const canonicalAnnotations = accepted.map(row => canonical(annotations.find(a => a.id === row.id), row, "annotations.jsonl", "annotator-input.jsonl"));
  const canonicalVerifications = accepted.map(row => canonical(result.verifications.find(v => v.id === row.id), row, "independent-verification.jsonl", "verifier-input.jsonl"));
  const unknown = result.unknown.map(row => ({ ...row, evidence: row.evidence.map(ref => `inputs/${ref}`),
    provenance_ref: `inputs/${row.provenance_ref}`, annotation_ref: "labeling/annotations.jsonl", verification_ref: "labeling/independent-verification.jsonl" }));
  const datasets = summarize(accepted);
  const repositories = read(path.join(inputRoot, "collection-config.json")).repositories;
  const byRepo = Object.fromEntries(repositories.map(p => [p.repo, summarize(accepted.filter(r => r.repo === p.repo)).dispatch]));
  return { ...result, accepted, unknown, proofs, annotations: canonicalAnnotations, verifications: canonicalVerifications, datasets, by_repo: byRepo,
    sample_floors_met: datasets.dispatch.ready };
}

export function finalizeBaseline(inputRoot, labelingRoot, root, cutoff = new Date().toISOString()) {
  if (fs.existsSync(root)) throw new Error("output must be new");
  const result = baselineGoldResult(inputRoot, labelingRoot, cutoff);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  copyEvidenceTree(inputRoot, path.join(root, "inputs"));
  const names = fs.readdirSync(labelingRoot).filter(name => name.endsWith(".jsonl") || ["packet-manifest.json", "verification-routing.json"].includes(name));
  for (const name of names) save(path.join(root, "labeling", name), fs.readFileSync(path.join(labelingRoot, name)));
  if (fs.existsSync(path.join(labelingRoot, "packets"))) copyEvidenceTree(path.join(labelingRoot, "packets"), path.join(root, "labeling/packets"));
  for (const proof of result.proofs) save(path.join(root, proof.ref), JSON.stringify(proof.value, null, 2) + "\n");
  save(path.join(root, "dispatch.jsonl"), jsonl(result.accepted));
  save(path.join(root, "unknown.jsonl"), jsonl(result.unknown));
  save(path.join(root, "annotations.jsonl"), jsonl(result.annotations));
  save(path.join(root, "verification.jsonl"), jsonl(result.verifications));
  save(path.join(root, "gold-manifest.json"), JSON.stringify({ version: 1, cohort: BASELINE_POLICY.cohort,
    policy_hash: baselinePolicyHash(), rules: RULES, reconciled_at: cutoff,
    input_manifest_sha256: digest(fs.readFileSync(path.join(inputRoot, "input-manifest.json"))),
    human_labels: false, label_source: "ai-annotation-verified", protocol_compatible: false, replay_performed: false,
    sample_floors_met: result.sample_floors_met, datasets: result.datasets, by_repo: result.by_repo,
    unknown: result.unknown.length, files: inventory(root) }, null, 2) + "\n");
  return validateBaselineGold(root);
}

export function validateBaselineGold(root) {
  const manifest = read(path.join(root, "gold-manifest.json"));
  if (manifest.policy_hash !== baselinePolicyHash() || !equivalentInput(manifest.rules, RULES) || manifest.human_labels !== false ||
      manifest.protocol_compatible !== false || manifest.replay_performed !== false || manifest.label_source !== "ai-annotation-verified") throw new Error("baseline gold policy changed");
  if (!equivalentInput(inventory(root).filter(f => f.path !== "gold-manifest.json"), manifest.files)) throw new Error("baseline gold hashes differ");
  if (manifest.input_manifest_sha256 !== digest(fs.readFileSync(path.join(root, "inputs/input-manifest.json")))) throw new Error("input manifest changed");
  const result = baselineGoldResult(path.join(root, "inputs"), path.join(root, "labeling"), manifest.reconciled_at);
  const rows = fs.readFileSync(path.join(root, "dispatch.jsonl"), "utf8");
  for (const proof of result.proofs) if (!equivalentInput(read(path.join(root, proof.ref)), proof.value)) throw new Error("canonical baseline proof changed");
  if (rows !== jsonl(result.accepted) || fs.readFileSync(path.join(root, "annotations.jsonl"), "utf8") !== jsonl(result.annotations) ||
      fs.readFileSync(path.join(root, "verification.jsonl"), "utf8") !== jsonl(result.verifications) ||
      fs.readFileSync(path.join(root, "unknown.jsonl"), "utf8") !== jsonl(result.unknown) ||
      !equivalentInput(manifest.datasets, result.datasets) || !equivalentInput(manifest.by_repo, result.by_repo) ||
      manifest.unknown !== result.unknown.length || manifest.sample_floors_met !== result.sample_floors_met) throw new Error("baseline gold counts differ");
  return { structural_valid: true, cohort: manifest.cohort, sample_floors_met: result.sample_floors_met,
    protocol_compatible: false, replay_performed: false, datasets: result.datasets, by_repo: result.by_repo,
    unknown: result.unknown.length, hashed_files: manifest.files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const result = command === "collect" ? await collectBaseline(...args) : command === "validate" ? validateBaselineInputs(...args) : command === "finalize" ? finalizeBaseline(...args) : command === "validate-gold" ? validateBaselineGold(...args) : null;
    if (!result) throw new Error("expected collect CONFIG NEW_OUT, validate INPUT_RUN, finalize INPUT_RUN LABELS NEW_OUT [CUTOFF], or validate-gold GOLD_RUN");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) { process.stderr.write(scrub(error.message) + "\n"); process.exitCode = 2; }
}
