import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { checkCase, scrub, save, summarize, observedProfile, collect, stage, finalize, seal, validate } from "./prepare.mjs";

const sha = "a".repeat(40);
const row = () => ({ id: `owner/repo#1:retry:${sha}:local-attest:1`, repo: "owner/repo", pr: 1,
  head_sha: sha, source: "https://github.com/owner/repo/pull/1", step: "retry",
  input: { phase: "local-attest", attempt: 1, failure_tail: "Connection reset" },
  label: "retry", label_source: "ai-annotation-verified", labeled_before_replay: true,
  evidence: ["evidence/failure.json"], annotation_ref: "annotations.jsonl", verification_ref: "verification.jsonl" });
const annotation = r => ({ id:r.id, head_sha:sha, label:r.label, annotator:"ai:annotator",
  rationale:"A transport failure needs no code correction.", evidence:r.evidence, blind_to_predictions:true });
const verification = r => ({ ...annotation(r), verifier:"ai:verifier", status:"agree", disagreements:[] });
const proof = { head_sha:sha, repo:"owner/repo", pr:1, decision_head_verified:true,
  failure_link_verified:true, original_log:true, phase:"local-attest", attempt:1, failure_tail:"Connection reset" };

test("accepts checked AI provenance without calling it human", () => {
  const r=row(); assert.deepEqual(checkCase(r, annotation(r), verification(r), proof), []);
  r.label_source="independent-human"; assert.ok(checkCase(r,annotation(r),verification(r),proof).includes("label_source"));
});
test("rejects unknown, cap, invalid label, missing evidence and mismatched head", () => {
  const r=row(); r.input.attempt=3; r.label="continue"; r.evidence=[];
  const errors=checkCase(r,annotation(r),verification(r),{...proof,head_sha:"b".repeat(40)});
  for(const e of ["cap_determined","invalid_label","evidence","commit_provenance"]) assert.ok(errors.includes(e),e);
});
test("dispatch cannot add existing or unavailable reviewers or infer a negative from absence", () => {
  const r={...row(),step:"dispatch",input:{profile:["security-auditor"],candidates:["documentation-writer"],changed_files:["note.md"],changed_lines:1},label:[]};
  const p={...proof,input:r.input,profile_rule_verified:true,historical_profile_verified:true};
  assert.ok(checkCase(r,annotation(r),verification(r),p).includes("negative_evidence"));
  assert.deepEqual(checkCase(r,{...annotation(r),inspection_complete:true},verification(r),p),[]);
  r.label=["security-auditor"]; assert.ok(checkCase(r,annotation(r),verification(r),p).includes("invalid_label"));
});
test("requires separate verifier, resolved agreement, and prediction blindness", () => {
  const r=row(), a=annotation(r), v=verification(r);
  for (const bad of [{...v,verifier:a.annotator},{...v,status:"disagree"},{...v,blind_to_predictions:false}])
    assert.ok(checkCase(r,a,bad,proof).includes("verification"));
});
test("scrubs common secrets before writing and writes private files exclusively", t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"graph-data-test-")); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const secret="ghp_"+"x".repeat(36);
  assert.ok(!scrub(`Authorization: Bearer ${secret}\nAPI_KEY=canary-secret`).includes("canary-secret"));
  assert.ok(!scrub(secret).includes(secret));
  assert.ok(!scrub("password='lowercase-canary'").includes("lowercase-canary"));
  assert.equal(scrub("Provider keys:\n| name | value |"),"Provider keys:\n| name | value |");
  const file=path.join(dir,"nested","record.json"); save(file,"ok");
  assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.throws(()=>save(file,"overwrite"));
});
test("collect, stage, finalize and hash validation work offline and reject changed evidence", async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"graph-prep-integration-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const put=(name,value)=>{const f=path.join(dir,name);save(f,JSON.stringify(value));return f;};
  const facts=put("facts.json",{protected_paths:["protected.mjs"]});
  const metadata=path.join(dir,"prs.json.gz");
  const pr={number:1,headRefOid:sha,files:[{path:"note.md"}],changedFiles:1,additions:1,deletions:0};
  save(metadata,gzipSync(JSON.stringify([pr,{...pr,number:2,files:[{path:"protected.mjs"}]},{...pr,number:3,changedFiles:2}])));
  const receipts=path.join(dir,"receipts");
  save(path.join(receipts,"pr-1.json"),JSON.stringify({pr:1,attempts:[1,2,3].map(n=>({phase:"local-attest",n,head_sha:sha,outcome:"fail",evidence:[]}))}));
  const config=put("config.json",{sources:[],repositories:[{name:"owner/repo",facts,receipts,metadata:[metadata]}]});
  const out=path.join(dir,"out"), summary=await collect(config,out);
  assert.equal(summary.candidates,1);assert.equal(summary.retry_unknown,2);assert.equal(summary.excluded,3);
  const state={repo:"owner/repo",pr:1,head_sha:sha,decision_head_verified:true,comparison_complete:true,
    files:[{filename:"note.md",additions:1,deletions:0,patch:"@@ -0,0 +1 @@\n+hello"}],commits:[{sha}],
    review_anchor:{head_sha:sha},merge_base_sha:"b".repeat(40),
    historical_facts:{commit:"b".repeat(40),facts:{protected_paths:["protected.mjs"]}},
    reviews:[{id:1,commit_id:sha,body:"Fleet: documentation-writer, security-auditor (profile: docs-only)"}]};
  save(path.join(out,"evidence/owner--repo-1-review-state.json"),JSON.stringify(state));
  assert.equal(stage(out).ready_for_annotation,1);
  const r=JSON.parse(fs.readFileSync(path.join(out,"annotation-input.jsonl"),"utf8"));
  const a={...annotation(r),label:[],inspection_complete:true},v={...verification(r),label:[]};
  save(path.join(out,"annotations.jsonl"),JSON.stringify(a)+"\n");
  save(path.join(out,"verification.jsonl"),JSON.stringify(v)+"\n");
  assert.equal(finalize(out).dispatch.rows,1);
  seal(out);const checked=validate(out);
  assert.equal(checked.structural_valid,true);assert.equal(checked.sample_floors_met,false);
  assert.equal(checked.evaluator.dispatch.decision,"INCONCLUSIVE");assert.equal(checked.evaluator.dispatch.labeled,0);
  fs.writeFileSync(path.join(out,"collection.json"),"{}");
  assert.throws(()=>validate(out),/manifest hashes differ/);
});
test("floor checks preserve all locked thresholds and count PR groups", () => {
  const s=summarize([row()]); assert.equal(s.retry.rows,1); assert.equal(s.retry.groups,1);
  assert.deepEqual(s.retry.classes,{retry:1,fix:0,"ask-owner":0});
  assert.equal(s.retry.ready,false); assert.equal(s.dispatch.ready,false);
  assert.equal(s.retry.shortfall.rows,99); assert.equal(s.retry.shortfall.groups,29);
});
test("observed roster excludes reviewer names in findings and rejects a different head", () => {
  const body="Fleet: `documentation-writer`, `security-auditor` (profile: docs-only).\nThe finding says compliance-auditor is missing.";
  assert.deepEqual(observedProfile([{commit_id:sha,body}],sha).reviewers,["documentation-writer","security-auditor"]);
  assert.equal(observedProfile([{commit_id:"b".repeat(40),body}],sha),null);
  assert.equal(observedProfile([{commit_id:sha,body:"No findings from compliance-auditor."}],sha),null);
});
