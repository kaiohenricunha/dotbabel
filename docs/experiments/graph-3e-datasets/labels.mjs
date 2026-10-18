// Offline integration of separately produced blind labels. No model client.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { checkCase, save, seal, summarize, validate } from "./prepare.mjs";
import { validateRecovery } from "./recovery.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const jsonl = rows => rows.map(JSON.stringify).join("\n") + (rows.length ? "\n" : "");
const equivalent = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function index(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.id || map.has(row.id)) throw new Error("duplicate or missing label ID");
    map.set(row.id, row);
  }
  return map;
}

function canonicalLabel(row, label) {
  if (label === null) return null;
  if (row.step === "retry") {
    if (!["retry", "fix", "ask-owner"].includes(label)) throw new Error("invalid retry label");
    return label;
  }
  if (!Array.isArray(label) || new Set(label).size !== label.length ||
      label.some(r => !row.input.candidates.includes(r) || row.input.profile.includes(r))) throw new Error("invalid dispatch label");
  return row.input.candidates.filter(r => label.includes(r));
}

export function reconcile(cases, annotations, independent, cutoff) {
  const cm = index(cases), am = index(annotations), vm = index(independent);
  if (am.size !== cm.size || vm.size !== cm.size || [...am.keys(), ...vm.keys()].some(id => !cm.has(id))) throw new Error("label coverage mismatch");
  const accepted = [], unknown = [], verifications = [];
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error("invalid reconciliation time");
  for (const row of cases) {
    const a = am.get(row.id), v = vm.get(row.id);
    if (!a.annotator || !v.verifier || a.annotator === v.verifier || a.head_sha !== row.head_sha || v.head_sha !== row.head_sha ||
        a.blind_to_predictions !== true || v.blind_to_predictions !== true || !a.rationale || !v.rationale ||
        !a.evidence?.length || !v.evidence?.length) throw new Error("invalid independent provenance");
    for (const time of [a.labeled_at, v.verified_at]) {
      if (!Number.isFinite(Date.parse(time)) || Date.parse(time) > Date.parse(cutoff)) throw new Error("invalid label time");
    }
    const left = canonicalLabel(row, a.label), right = canonicalLabel(row, v.label);
    if (left === null || right === null) {
      unknown.push({ ...row, reason: "insufficient_evidence", label: null,
        annotation_status: a.status, verification_status: v.status }); continue;
    }
    if (a.status !== "labeled" || v.status !== "independent-label") throw new Error("unexpected blind label status");
    if (row.step === "dispatch" && !left.length && (a.inspection_complete !== true || v.inspection_complete !== true)) throw new Error("incomplete negative inspection");
    if (!equivalent(left, right)) {
      unknown.push({ ...row, reason: "independent_labels_disagree", label: null,
        annotation_label: left, verification_label: right }); continue;
    }
    accepted.push({ ...row, label: left, label_source: "ai-annotation-verified", labeled_before_replay: true,
      annotation_ref: "annotations.jsonl", verification_ref: "verification.jsonl" });
    verifications.push({ ...v, label: right, status: "agree", disagreements: [], reconciled_at: cutoff,
      reconciliation: "exact agreement between separately completed blind labels" });
  }
  return { accepted, unknown, verifications };
}

export function copyEvidenceTree(source, target, skip = new Set(), relative = "") {
  for (const name of fs.readdirSync(path.join(source, relative))) {
    const ref = path.join(relative, name);
    if (skip.has(ref)) continue;
    const file = path.join(source, ref), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("symlink in source evidence");
    if (stat.isDirectory()) copyEvidenceTree(source, target, skip, ref);
    else save(path.join(target, ref), fs.readFileSync(file));
  }
}

export function validateBlindPackets(cases, labeling) {
  for (const name of ["annotator-input.jsonl", "verifier-input.jsonl"]) {
    const packet = index(lines(path.join(labeling, name)));
    if (packet.size !== cases.length || cases.some(r => packet.get(r.id)?.head_sha !== r.head_sha || !equivalent(packet.get(r.id).input, r.input))) throw new Error("blind packet input mismatch");
  }
  const manifestFile = path.join(labeling, "packet-manifest.json");
  if (fs.existsSync(manifestFile)) {
    const manifest = read(manifestFile);
    for (const [name, key] of [["annotator-input.jsonl", "annotator_packet_sha256"], ["verifier-input.jsonl", "verifier_packet_sha256"]])
      if (digest(fs.readFileSync(path.join(labeling, name))) !== manifest[key]) throw new Error("blind packet hash changed");
    if (manifest.case_count !== cases.length) throw new Error("blind packet count changed");
    for (const packet of manifest.packets) {
      const file = path.resolve(labeling, packet.file);
      if (!file.startsWith(path.resolve(labeling) + path.sep) || fs.lstatSync(file).isSymbolicLink() || digest(fs.readFileSync(file)) !== packet.sha256) throw new Error("blind shard changed");
    }
  }
}

export function integrate(parent, recovery, labeling, out, cutoff = new Date().toISOString()) {
  if (fs.existsSync(out)) throw new Error("output must be new");
  validate(parent); validateRecovery(recovery, parent);
  const cases = [...lines(path.join(recovery, "retry-annotation-input.jsonl")), ...lines(path.join(recovery, "dispatch-annotation-input.jsonl"))];
  const am = lines(path.join(labeling, "annotations.jsonl")), vm = lines(path.join(labeling, "independent-verification.jsonl"));
  validateBlindPackets(cases, labeling);
  const result = reconcile(cases, am, vm, cutoff), originalAnnotations = index(am), checked = index(result.verifications);
  const skip = new Set(["manifest.json", "retry.jsonl", "dispatch.jsonl", "annotations.jsonl", "verification.jsonl", "unknown.jsonl",
    "retry-unknown.jsonl", "dispatch-unknown.jsonl", "annotation-input.jsonl", "verification-unknown.jsonl"]);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  copyEvidenceTree(parent, out, skip); copyEvidenceTree(recovery, path.join(out, "recovery"));
  for (const name of ["annotations.jsonl", "independent-verification.jsonl", "annotator-input.jsonl", "verifier-input.jsonl"])
    save(path.join(out, "labeling", name), fs.readFileSync(path.join(labeling, name)));
  save(path.join(out, "parents/preparation-manifest.json"), fs.readFileSync(path.join(parent, "manifest.json")));
  const prior = [...lines(path.join(parent, "retry.jsonl")), ...lines(path.join(parent, "dispatch.jsonl"))];
  const annotations = lines(path.join(parent, "annotations.jsonl")), verifications = lines(path.join(parent, "verification.jsonl"));
  const added = [];
  for (const row of result.accepted) {
    const proof = read(path.join(recovery, row.provenance_ref)), proofRef = `evidence/checked-${digest(row.id)}.json`;
    if (proof.review_state_ref) proof.review_state_ref = `recovery/${proof.review_state_ref}`;
    save(path.join(out, proofRef), JSON.stringify({ ...proof, original_provenance_ref: `recovery/${row.provenance_ref}` }, null, 2) + "\n");
    const evidence = [...row.evidence.map(ref => `recovery/${ref}`), proofRef];
    const a = originalAnnotations.get(row.id), v = checked.get(row.id);
    const canon = (source, packet, raw) => ({ ...source, label: row.label, source_citations: source.evidence,
      evidence: [`labeling/${packet}`, `labeling/${raw}`, proofRef], adjudication_actor: "main:offline-integrator" });
    const annotation = canon(a, "annotator-input.jsonl", "annotations.jsonl");
    const verification = canon(v, "verifier-input.jsonl", "independent-verification.jsonl");
    const accepted = { ...row, evidence, provenance_ref: proofRef };
    const errors = checkCase(accepted, annotation, verification, proof);
    if (errors.length) throw new Error(`integrated case rejected: ${errors.join(",")}`);
    added.push(accepted); annotations.push(annotation); verifications.push(verification);
  }
  index([...prior, ...added]);
  const caseIDs = new Set(cases.map(r => r.id));
  const unresolved = result.unknown.map(r => ({ ...r, evidence: r.evidence.map(ref => `recovery/${ref}`),
    provenance_ref: `recovery/${r.provenance_ref}`, annotation_ref: "labeling/annotations.jsonl", verification_ref: "labeling/independent-verification.jsonl" }));
  const unknown = [...lines(path.join(parent, "unknown.jsonl")).filter(r => !caseIDs.has(r.id)), ...unresolved];
  for (const step of ["retry", "dispatch"]) save(path.join(out, `${step}.jsonl`), jsonl([...prior, ...added].filter(r => r.step === step)));
  save(path.join(out, "annotations.jsonl"), jsonl(annotations)); save(path.join(out, "verification.jsonl"), jsonl(verifications));
  save(path.join(out, "annotation-input.jsonl"), jsonl([...prior, ...cases]));
  save(path.join(out, "unknown.jsonl"), jsonl(unknown));
  save(path.join(out, "retry-unknown.jsonl"), jsonl(unknown.filter(r => r.step === "retry")));
  save(path.join(out, "dispatch-unknown.jsonl"), jsonl(unknown.filter(r => r.step === "dispatch")));
  save(path.join(out, "verification-unknown.jsonl"), jsonl(unresolved));
  save(path.join(out, "label-integration.json"), JSON.stringify({ reconciled_at: cutoff,
    source_manifest_sha256: digest(fs.readFileSync(path.join(parent, "manifest.json"))),
    recovery_manifest_sha256: digest(fs.readFileSync(path.join(recovery, "recovery-manifest.json"))),
    actors: { annotators: [...new Set(am.map(a => a.annotator))], verifiers: [...new Set(vm.map(v => v.verifier))] },
    agreed: result.accepted.length, unknown: result.unknown.length, human_labels: false, replay_performed: false,
    label_source: "ai-annotation-verified", datasets: summarize([...prior, ...added]) }, null, 2) + "\n");
  seal(out);
  return { ...validate(out), new_agreed_labels: added.length, new_unknown: unresolved.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command !== "integrate") throw new Error("expected integrate PARENT RECOVERY LABELING NEW_OUT [CUTOFF]");
    process.stdout.write(JSON.stringify(integrate(...args), null, 2) + "\n");
  } catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 2; }
}
