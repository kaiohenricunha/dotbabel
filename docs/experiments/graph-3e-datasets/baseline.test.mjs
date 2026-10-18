import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { baselineCase, baselinePool, BASELINE_POLICY, baselinePolicyHash, collectBaseline, validateBaselineInputs, finalizeBaseline, validateBaselineGold } from "./baseline.mjs";

const head = "a".repeat(40), base = "b".repeat(40);
const snapshot = { number: 1, headRefOid: head, state: "MERGED", changedFiles: 1,
  files: [{ path: "docs/note.md" }], additions: 2, deletions: 1 };
const comparison = { total_commits: 1, commits: [{ sha: head }], merge_base_commit: { sha: base },
  files: [{ filename: "docs/note.md", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-old\n+new\n+extra" }] };
const facts = { protected_paths: ["protected/**"] };

test("constructs a declared offline baseline from a real pinned snapshot without inventing a roster", () => {
  const result = baselineCase("owner/repo", snapshot, facts, { head: { sha: head }, base: { sha: base } }, comparison);
  assert.equal(result.row.head_sha, head);
  assert.equal(result.row.label, null);
  assert.equal(result.proof.profile_kind, "offline-locked-baseline");
  assert.equal(result.proof.historical_assignment_claimed, false);
  assert.deepEqual(result.row.input.profile, ["documentation-writer", "security-auditor"]);
  assert.deepEqual(result.row.input.candidates, ["architect-reviewer", "compliance-auditor"]);
  assert.equal(result.proof.policy_hash, baselinePolicyHash());
});

test("rejects changed heads, missing patches, truncated comparisons and metadata disagreement", () => {
  for (const c of [{ ...comparison, total_commits: 2 }, { ...comparison, commits: [] },
    { ...comparison, files: [{ ...comparison.files[0], patch: null }] },
    { ...comparison, files: [{ ...comparison.files[0], additions: 3 }] }])
    assert.throws(() => baselineCase("owner/repo", snapshot, facts, { head: { sha: head }, base: { sha: base } }, c));
  assert.throws(() => baselineCase("owner/repo", snapshot, facts, { head: { sha: base }, base: { sha: base } }, comparison));
});

test("freezes complete eligible merged snapshots before labels and applies fixed selection order", () => {
  const candidates = [snapshot, { ...snapshot, number: 2, files: [{ path: "protected/a.mjs" }] },
    { ...snapshot, number: 3, state: "OPEN" }, { ...snapshot, number: 4, changedFiles: 2 },
    { ...snapshot, number: 5 }];
  const one = baselinePool("owner/repo", candidates, facts), two = baselinePool("owner/repo", candidates.toReversed(), facts);
  assert.deepEqual(one.eligible.map(r => r.number), two.eligible.map(r => r.number));
  assert.equal(one.eligible.length, 2);
  assert.equal(one.excluded.length, 3);
  assert.equal(BASELINE_POLICY.target_rows, 180);
  assert.equal(BASELINE_POLICY.numeric_thresholds_changed, false);
  assert.equal(baselinePolicyHash().length, 64);
});

test("collects through a real offline gh subprocess and seals only complete original inputs", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-baseline-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const executable = path.join(bin, "gh");
  const pr = { head: { sha: head }, base: { sha: base } };
  fs.writeFileSync(executable, `#!${process.execPath}\nconst endpoint=process.argv.at(-1);\nif(endpoint.endsWith('/pulls/2')){process.stderr.write('Authorization: Bearer canary-private-value');process.exit(1);}\nprocess.stdout.write(JSON.stringify(endpoint.includes('/compare/')?${JSON.stringify(comparison)}:${JSON.stringify(pr)}));\n`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const put = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const config = put("config.json", { repositories: [{ repo: "owner/repo", visibility: "public", facts: put("facts.json", facts),
    prs: put("prs.json", [snapshot, { ...snapshot, number: 2 }]) }] });
  const out = path.join(root, "run"), summary = await collectBaseline(config, out);
  assert.equal(summary.rows, 1); assert.equal(summary.unknown, 1);
  assert.equal(summary.labels_present, false);
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(out, "annotation-input.jsonl")).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(out, "unknown.jsonl"), "utf8").includes("canary-private-value"));
  assert.equal(validateBaselineInputs(out).structural_valid, true);
  await assert.rejects(() => collectBaseline(config, out), /output must be new/);
  const cases = fs.readFileSync(path.join(out, "annotation-input.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const labeled = cases[0], labeling = path.join(root, "labeling"); fs.mkdirSync(labeling, { mode: 0o700 });
  for (const name of ["annotator-input.jsonl", "verifier-input.jsonl"])
    fs.writeFileSync(path.join(labeling, name), JSON.stringify({ ...labeled, pinned_files: comparison.files,
      protected_paths: facts.protected_paths }) + "\n", { mode: 0o600 });
  const common = { id: labeled.id, head_sha: head, label: [], rationale: "The complete documentation patch needs no additional specialist.",
    evidence: [labeled.provenance_ref], blind_to_predictions: true, inspection_complete: true };
  fs.writeFileSync(path.join(labeling, "annotations.jsonl"), JSON.stringify({ ...common, annotator: "agent:a", status: "labeled", labeled_at: "2026-10-18T03:10:00Z" }) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(labeling, "independent-verification.jsonl"), JSON.stringify({ ...common, verifier: "agent:b", status: "independent-label", verified_at: "2026-10-18T03:11:00Z" }) + "\n", { mode: 0o600 });
  const routing = { created_at: "2026-10-18T03:09:00Z", labels_consulted: false,
    reason: "Assign an unexposed verifier before comparing labels.", routing: [{ id: labeled.id, actor: "agent:wrong" }] };
  const routingPath = path.join(labeling, "verification-routing.json");
  fs.writeFileSync(routingPath, JSON.stringify(routing), { mode: 0o600 });
  assert.throws(() => finalizeBaseline(out, labeling, path.join(root, "wrong-verifier"), "2026-10-18T03:12:00Z"), /verification routing/);
  routing.routing[0].actor = "agent:b";
  fs.writeFileSync(routingPath, JSON.stringify(routing));
  const packetPath = path.join(labeling, "verifier-input.jsonl"), originalPacket = fs.readFileSync(packetPath, "utf8");
  fs.writeFileSync(packetPath, JSON.stringify({ ...JSON.parse(originalPacket), pinned_files: [{ ...comparison.files[0], patch: "+unrelated patch" }] }) + "\n");
  assert.throws(() => finalizeBaseline(out, labeling, path.join(root, "wrong-patch"), "2026-10-18T03:12:00Z"), /blind patch evidence/);
  fs.writeFileSync(packetPath, originalPacket);
  const goldRoot = path.join(root, "gold"), gold = finalizeBaseline(out, labeling, goldRoot, "2026-10-18T03:12:00Z");
  assert.equal(gold.datasets.dispatch.rows, 1);
  assert.equal(gold.datasets.dispatch.classes.none, 1);
  assert.equal(gold.sample_floors_met, false);
  assert.equal(gold.protocol_compatible, false);
  assert.equal(validateBaselineGold(goldRoot).structural_valid, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(goldRoot, "labeling/verification-routing.json"), "utf8")), routing);
  const exported = JSON.parse(fs.readFileSync(path.join(goldRoot, "dispatch.jsonl"), "utf8"));
  for (const ref of [...exported.evidence, exported.provenance_ref, exported.annotation_ref, exported.verification_ref])
    assert.ok(fs.existsSync(path.join(goldRoot, ref)), ref);
  const exportedProof = JSON.parse(fs.readFileSync(path.join(goldRoot, exported.provenance_ref), "utf8"));
  for (const ref of [exportedProof.facts_ref, exportedProof.metadata_ref, exportedProof.pr_ref, exportedProof.comparison_ref])
    assert.ok(fs.existsSync(path.join(goldRoot, ref)), ref);
  assert.throws(() => finalizeBaseline(out, labeling, goldRoot), /output must be new/);
  const manifestPath = path.join(out, "input-manifest.json"), manifest = fs.readFileSync(manifestPath, "utf8");
  const changed = JSON.parse(manifest); changed.counts.by_repo["owner/repo"] = 99;
  fs.writeFileSync(manifestPath, JSON.stringify(changed));
  assert.throws(() => validateBaselineInputs(out), /counts differ/);
  fs.writeFileSync(manifestPath, manifest);
  const differentPolicy = JSON.parse(manifest); differentPolicy.policy = { ...differentPolicy.policy, target_rows: 1 };
  fs.writeFileSync(manifestPath, JSON.stringify(differentPolicy));
  assert.throws(() => validateBaselineInputs(out), /policy changed/);
  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(path.join(out, "annotation-input.jsonl"), "");
  assert.throws(() => validateBaselineInputs(out), /hashes differ/);
});
