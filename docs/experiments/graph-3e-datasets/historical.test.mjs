import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { historyPool, historicalCase, HISTORICAL_POLICY, collectHistorical, validateHistoricalInputs,
  finalizeHistorical, validateHistoricalGold, combinePublic, validatePublicLedger } from "./historical.mjs";
import { save } from "./prepare.mjs";
import { collectBaseline, finalizeBaseline } from "./baseline.mjs";

const head = "a".repeat(40), base = "b".repeat(40), finalHead = "c".repeat(40);
const facts = { protected_paths: ["protected/**"] };
const metadata = [{ number: 1, state: "MERGED", headRefOid: finalHead }];
const anchor = { repo: "owner/repo", pr: 1, head_sha: head, review_id: 7,
  review_at: "2026-10-01T00:00:00Z", review_url: "https://github.com/owner/repo/pull/1#pullrequestreview-7", source_ref: "sources/reviews/batch.json" };
const node = (number, sha) => ({ number, reviews: { pageInfo: { hasNextPage: false }, nodes: [
  { databaseId: 7, submittedAt: anchor.review_at, url: anchor.review_url, commit: { oid: sha } }] } });
const batch = { ref: anchor.source_ref, value: { data: { repository: { pr1: node(1, head) } } } };
const pr = { number: 1, head: { sha: finalHead }, base: { sha: base } };
const comparison = { total_commits: 1, commits: [{ sha: head }], merge_base_commit: { sha: base },
  files: [{ filename: "docs/note.md", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-old\n+new\n+extra" }] };

test("selects only actual unselected intermediate review heads in a deterministic order", () => {
  const extra = { ref: "batch2.json", value: { data: { repository: { final: node(1, finalHead), open: node(2, head) } } } };
  const input = [...metadata, { number: 2, state: "OPEN", headRefOid: finalHead }];
  const one = historyPool("owner/repo", input, [batch, extra], []);
  assert.deepEqual(one.map(r => [r.pr, r.head_sha]), [[1, head]]);
  assert.deepEqual(historyPool("owner/repo", input, [extra, batch], []), one);
  assert.equal(historyPool("owner/repo", input, [batch], [{ repo: "owner/repo", pr: 1, head_sha: head }]).length, 0);
  assert.equal(HISTORICAL_POLICY.maximum_additional_states_per_pr, 1);
  assert.equal(HISTORICAL_POLICY.target_rows, 60);
});

test("pins a historical baseline without rewriting the real current PR head or claiming an assignment", () => {
  const result = historicalCase(anchor, pr, comparison, facts);
  assert.equal(result.row.head_sha, head);
  assert.equal(result.proof.current_pr_head_sha, finalHead);
  assert.equal(result.proof.historical_assignment_claimed, false);
  assert.deepEqual(result.row.input.profile, ["documentation-writer", "security-auditor"]);
  assert.equal(result.row.label, null);
  for (const bad of [{ ...comparison, commits: [] }, { ...comparison, total_commits: 2 },
    { ...comparison, files: [{ ...comparison.files[0], patch: null }] },
    { ...comparison, merge_base_commit: { sha: "short" } }])
    assert.throws(() => historicalCase(anchor, pr, bad, facts));
  assert.throws(() => historicalCase(anchor, { ...pr, number: 2 }, comparison, facts));
});

test("collects source-backed inputs through a real subprocess and detects retained evidence changes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-historical-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), reviews = path.join(root, "reviews"); fs.mkdirSync(bin); fs.mkdirSync(reviews);
  const put = (name, value) => { const file = path.join(root, name); save(file, JSON.stringify(value)); return file; };
  save(path.join(root, "prior.jsonl"), "");
  const config = put("config.json", { repo: "owner/repo", facts: put("facts.json", facts),
    metadata: put("metadata.json", metadata), prior_inputs: path.join(root, "prior.jsonl"), reviews });
  put("reviews/owner--repo-0.json", batch.value);
  const finalComparison = { ...comparison, commits: [{ sha: finalHead }] };
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\nconst e=process.argv.at(-1);process.stdout.write(JSON.stringify(e.endsWith('/pulls/1')?${JSON.stringify(pr)}:e.includes('/compare/')?(e.endsWith('${finalHead}')?${JSON.stringify(finalComparison)}:${JSON.stringify(comparison)}):{full_name:'owner/repo',private:false}));`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const out = path.join(root, "run"), result = await collectHistorical(config, out);
  assert.equal(result.rows, 1); assert.equal(result.groups, 1);
  assert.equal(result.labels_present, false); assert.equal(result.replay_performed, false);
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  assert.equal(validateHistoricalInputs(out).structural_valid, true);
  await assert.rejects(() => collectHistorical(config, out), /output must be new/);
  const manifestPath = path.join(out, "input-manifest.json"), originalManifest = fs.readFileSync(manifestPath, "utf8");
  const inputPath = path.join(out, "annotation-input.jsonl"), originalInput = fs.readFileSync(inputPath, "utf8");
  const reseal = counts => {
    const changed = JSON.parse(originalManifest); changed.counts = counts;
    changed.files = changed.files.map(entry => {
      const data = fs.readFileSync(path.join(out, entry.path));
      return { ...entry, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    });
    fs.writeFileSync(manifestPath, JSON.stringify(changed));
  };
  fs.writeFileSync(inputPath, "");
  reseal({ rows: 0, groups: 0, candidates: 1, unknown: 0, excluded: 0 });
  assert.throws(() => validateHistoricalInputs(out), /historical selection outcome differs/);
  fs.writeFileSync(path.join(out, "unknown.jsonl"), JSON.stringify({ ...historyPool("owner/repo", metadata, [batch], [])[0],
    reason: "historical_source_read_failed", evidence: ["evidence/pr-1.json", `evidence/1-${head}-comparison.json`] }) + "\n");
  reseal({ rows: 0, groups: 0, candidates: 1, unknown: 1, excluded: 0 });
  assert.throws(() => validateHistoricalInputs(out), /historical selection outcome differs/);
  fs.writeFileSync(inputPath, originalInput); fs.writeFileSync(path.join(out, "unknown.jsonl"), "");
  fs.writeFileSync(manifestPath, originalManifest);
  const labeling = (dir, inputRoot) => {
    const cases = fs.readFileSync(path.join(inputRoot, "annotation-input.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    for (const name of ["annotator-input.jsonl", "verifier-input.jsonl"])
      save(path.join(dir, name), cases.map(r => JSON.stringify({ ...r, pinned_files: comparison.files, protected_paths: facts.protected_paths })).join("\n") + "\n");
    const common = cases.map(r => ({ id: r.id, head_sha: r.head_sha, label: [], rationale: "Complete prose inspection needs no extra specialist.",
      evidence: [r.provenance_ref], blind_to_predictions: true, inspection_complete: true }));
    save(path.join(dir, "annotations.jsonl"), common.map(r => JSON.stringify({ ...r, annotator: "a", status: "labeled", labeled_at: "2026-10-18T03:10:00Z" })).join("\n") + "\n");
    save(path.join(dir, "independent-verification.jsonl"), common.map(r => JSON.stringify({ ...r, verifier: "b", status: "independent-label", verified_at: "2026-10-18T03:11:00Z" })).join("\n") + "\n");
  };
  const histLabels = path.join(root, "historical-labels"); labeling(histLabels, out);
  const histGold = path.join(root, "historical-gold");
  assert.equal(finalizeHistorical(out, histLabels, histGold, "2026-10-18T03:12:00Z").datasets.dispatch.rows, 1);
  assert.equal(validateHistoricalGold(histGold).protocol_compatible, false);
  const baseInput = path.join(root, "baseline-input"), baseGold = path.join(root, "baseline-gold"), baseLabels = path.join(root, "baseline-labels");
  const basePrs = put("base-prs.json", [{ number: 1, state: "MERGED", headRefOid: finalHead, additions: 2,
    deletions: 1, changedFiles: 1, files: [{ path: "docs/note.md" }] }]);
  const baseConfig = put("base-config.json", { repositories: [
    { repo: "owner/repo", visibility: "public", facts: path.join(root, "facts.json"), prs: basePrs },
    { repo: "owner/private", visibility: "private", facts: path.join(root, "facts.json"), prs: basePrs }] });
  await collectBaseline(baseConfig, baseInput); labeling(baseLabels, baseInput);
  finalizeBaseline(baseInput, baseLabels, baseGold, "2026-10-18T03:12:00Z");
  const combinedRoot = path.join(root, "public"), combined = combinePublic(baseGold, histGold, combinedRoot);
  assert.equal(combined.datasets.dispatch.rows, 2); assert.equal(combined.datasets.dispatch.groups, 1);
  assert.equal(combined.private_request_rows, 0); assert.equal(combined.sample_floors_met, false);
  assert.equal(validatePublicLedger(combinedRoot).structural_valid, true);
  const exported = fs.readFileSync(path.join(combinedRoot, "public-dispatch.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(exported.length, 2); assert.ok(exported.every(row => row.repo === "owner/repo"));
  const retainedParent = fs.readFileSync(path.join(combinedRoot, "parents/baseline/dispatch.jsonl"), "utf8");
  assert.ok(retainedParent.includes('"repo":"owner/private"'));
  for (const row of exported) for (const ref of [...row.evidence, row.provenance_ref, row.annotation_ref, row.verification_ref])
    assert.ok(fs.existsSync(path.join(combinedRoot, ref)), ref);
  fs.writeFileSync(path.join(combinedRoot, "public-dispatch.jsonl"), "");
  assert.throws(() => validatePublicLedger(combinedRoot), /hashes differ/);
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({full_name:'owner/repo',private:true}));`);
  await assert.rejects(() => collectHistorical(config, path.join(root, "private-repository")), /public repository required/);
  fs.writeFileSync(path.join(out, "annotation-input.jsonl"), "");
  assert.throws(() => validateHistoricalInputs(out), /hashes differ/);
});
