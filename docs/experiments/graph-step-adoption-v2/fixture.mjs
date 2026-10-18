// Synthetic test sources only. Never part of a collected research dataset.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { save } from "../graph-3e-datasets/prepare.mjs";
import { collectBaseline, finalizeBaseline } from "../graph-3e-datasets/baseline.mjs";
import { collectHistorical, finalizeHistorical, combinePublic } from "../graph-3e-datasets/historical.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonl = rows => rows.map(JSON.stringify).join("\n") + "\n";
export async function publicFixture(root, count = 51) {
  const head = "a".repeat(40), base = "b".repeat(40), final = "c".repeat(40);
  const facts = { protected_paths: ["protected/**"] };
  const files = [{ filename: "docs/note.md", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+Read this note." }];
  const put = (name, value) => { const file = path.join(root, name); save(file, JSON.stringify(value)); return file; };
  const metadata = Array.from({ length: count }, (_, i) => ({ number: i + 1, state: "MERGED", headRefOid: final,
    additions: 1, deletions: 0, changedFiles: 1, files: [{ path: files[0].filename }] }));
  const factsFile = put("facts.json", facts), metadataFile = put("metadata.json", metadata);
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\nconst e=process.argv.at(-1),n=Number(e.split('/').at(-1));process.stdout.write(JSON.stringify(e.includes('/pulls/')?{number:n,head:{sha:'${final}'},base:{sha:'${base}'}}:e.includes('/compare/')?{total_commits:1,commits:[{sha:e.endsWith('${final}')?'${final}':'${head}'}],merge_base_commit:{sha:'${base}'},files:${JSON.stringify(files)}}:{full_name:'owner/repo',private:false}));`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const label = (input, out, disagreePr) => {
    const cases = fs.readFileSync(path.join(input, "annotation-input.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const packets = jsonl(cases.map(r => ({ ...r, pinned_files: files, protected_paths: facts.protected_paths })));
    for (const name of ["annotator-input.jsonl", "verifier-input.jsonl"]) save(path.join(out, name), packets);
    save(path.join(out, "packet-manifest.json"), JSON.stringify({ created_at: new Date().toISOString(), case_count: cases.length,
      input_manifest_sha256: digest(fs.readFileSync(path.join(input, "input-manifest.json"))),
      annotator_packet_sha256: digest(packets), verifier_packet_sha256: digest(packets), packets: [] }));
    const common = cases.map(r => ({ id: r.id, head_sha: r.head_sha, label: r.pr % 2 ? ["architect-reviewer"] : [],
      rationale: "Complete synthetic patch inspected for each missing role.", inspection_complete: true,
      per_candidate_reasons: Object.fromEntries(r.input.candidates.map(c => [c, "The full synthetic patch was inspected for this role."])),
      evidence: [r.provenance_ref], blind_to_predictions: true }));
    save(path.join(out, "annotations.jsonl"), jsonl(common.map(r => ({ ...r, annotator: "agent:a", status: "labeled", labeled_at: new Date().toISOString() }))));
    save(path.join(out, "independent-verification.jsonl"), jsonl(common.map((r, i) => ({ ...r, label: cases[i].pr === disagreePr ? (r.label.length ? [] : ["architect-reviewer"]) : r.label,
      verifier: "agent:b", status: "independent-label", verified_at: new Date().toISOString() }))));
  };
  try {
    const baselineInput = path.join(root, "baseline-input"), baselineGold = path.join(root, "baseline-gold");
    await collectBaseline(put("baseline-config.json", { repositories: [{ repo: "owner/repo", visibility: "public", facts: factsFile, prs: metadataFile }] }), baselineInput);
    label(baselineInput, path.join(root, "baseline-labels"), 1);
    finalizeBaseline(baselineInput, path.join(root, "baseline-labels"), baselineGold);
    put("reviews/owner--repo-0.json", { data: { repository: Object.fromEntries(metadata.map(r => [`pr${r.number}`, { number: r.number,
      reviews: { pageInfo: { hasNextPage: false }, nodes: [{ databaseId: r.number, submittedAt: "2026-10-01T00:00:00Z",
        url: `https://github.com/owner/repo/pull/${r.number}#pullrequestreview-${r.number}`, commit: { oid: head } }] } }])) } });
    const historicalInput = path.join(root, "historical-input"), historicalGold = path.join(root, "historical-gold");
    await collectHistorical(put("historical-config.json", { repo: "owner/repo", facts: factsFile, metadata: metadataFile,
      prior_inputs: path.join(baselineInput, "annotation-input.jsonl"), reviews: path.join(root, "reviews") }), historicalInput);
    label(historicalInput, path.join(root, "historical-labels"), 2);
    finalizeHistorical(historicalInput, path.join(root, "historical-labels"), historicalGold);
    const combined = path.join(root, "public"); combinePublic(baselineGold, historicalGold, combined); return combined;
  } finally { process.env.PATH = oldPath; }
}
