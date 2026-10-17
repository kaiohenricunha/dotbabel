import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { appendAttempt, createReceipt } from "../../../plugins/dotbabel/src/run-receipt.mjs";
const cli = fileURLToPath(new URL("./run.mjs", import.meta.url));
const sha = "a".repeat(40);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-adoption-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name, data) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(data)); return f; };
  const receipts = path.join(dir, "receipts"); fs.mkdirSync(receipts);
  const receipt = appendAttempt(createReceipt({pr: 1}), { phase: "review-pr", outcome: "fail", headSha: sha, reasonCode: "REVIEW_FAILED" });
  fs.writeFileSync(path.join(receipts,"pr-1.json"), JSON.stringify(receipt));
  const prs = put("prs.json", [
    { number: 1, headRefOid: sha, additions: 1, deletions: 0, files: [{path:"notes.md"}] },
    { number: 2, headRefOid: sha, additions: 1, deletions: 0, files: [{path:"README.md"}] },
    { number: 3, headRefOid: sha, additions: 1, deletions: 0, files: Array.from({length:100}, () => ({path:"many.mjs"})) },
  ]);
  const facts = put("facts.json", {protected_paths:["README.md"]});
  const out = path.join(dir, "samples.jsonl");
  const args = ["collect","--prs",prs,"--facts",facts,"--receipts",receipts,"--repo","owner/repo","--out",out];
  const run = (argv, env = {}) => spawnSync(process.execPath, [cli,...argv], { encoding:"utf8", env:{...process.env,TYPESAFE_API_KEY:"",...env} });
  return {dir,put,run,args,out};
}
test("collect reads real files, keeps provenance, and refuses to invent retry inputs", t => {
  const f = fixture(t), r = f.run(f.args);
  assert.equal(r.status,0,r.stderr);
  const summary = JSON.parse(r.stdout), row = JSON.parse(fs.readFileSync(f.out,"utf8"));
  assert.equal(summary.collected,1);
  assert.equal(summary.exclusions.no_additional_candidate,1);
  assert.equal(summary.exclusions.incomplete_pr_snapshot,1);
  assert.equal(summary.exclusions.receipt_missing_failure_tail,1);
  assert.equal(row.label,null);
  assert.equal(row.input.candidates.length,2);
  assert.equal(row.head_sha,sha);
  assert.equal(fs.statSync(f.out).mode & 0o777,0o600);
  assert.equal(f.run(f.args).status,2);
});
test("evaluate and replay dry-run work offline without invented labels or answers", t => {
  const f=fixture(t); assert.equal(f.run(f.args).status,0);
  const r=f.run(["evaluate","--in",f.out]);
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).results.map(r=>r.decision),["INCONCLUSIVE","INCONCLUSIVE"]);
  const out=path.join(f.dir,"requests.jsonl");
  const dry=f.run(["replay","--in",f.out,"--out",out]);
  assert.equal(dry.status,0,dry.stderr);
  assert.equal(JSON.parse(dry.stdout).requests,0);
  assert.equal(fs.readFileSync(out,"utf8"),"");
});
test("replay send refuses a missing key without creating output", t => {
  const f=fixture(t); assert.equal(f.run(f.args).status,0);
  const out=path.join(f.dir,"answers.jsonl");
  const r=f.run(["replay","--in",f.out,"--out",out,"--send"]);
  assert.equal(r.status,2);
  assert.match(r.stderr,/requires TYPESAFE_API_KEY/);
  assert.equal(fs.existsSync(out),false);
});
test("collector rejects labels without independently pinned source evidence", t => {
  const f=fixture(t), id=`owner/repo#1:dispatch:${sha}`;
  const labels=f.put("labels.json",{[id]:{head_sha:sha,label:[],label_source:"model",labeled_before_replay:true,evidence:[]}});
  assert.equal(f.run([...f.args,"--labels",labels]).status,2);
  assert.equal(fs.existsSync(f.out),false);
});
test("replay never sends a single labeled sample below the locked floor", t => {
  const f=fixture(t), id=`owner/repo#1:dispatch:${sha}`;
  const labels=f.put("labels.json",{[id]:{head_sha:sha,label:[],label_source:"independent-human",labeled_before_replay:true,evidence:["https://github.com/owner/repo/pull/1"]}});
  assert.equal(f.run([...f.args,"--labels",labels]).status,0);
  const out=path.join(f.dir,"answers.jsonl");
  const r=f.run(["replay","--in",f.out,"--out",out,"--send","--consent-public-repo","owner/repo"],{TYPESAFE_API_KEY:"dummy-test-key"});
  assert.equal(r.status,2);
  assert.match(r.stderr,/sample floor/);
  assert.equal(fs.existsSync(out),false);
});
test("malformed invocation returns an error", t => {
  const f=fixture(t);
  assert.equal(f.run(["bogus"]).status,2);
  assert.equal(f.run(["collect"]).status,2);
});
test("replay refuses a one-class corpus before calling a model", t => {
  const f=fixture(t), input=path.join(f.dir,"one-class.jsonl");
  const rows=Array.from({length:100},(_,i)=>({id:`case-${i}`,repo:"owner/repo",pr:i+1,head_sha:sha,
    source:`https://github.com/owner/repo/pull/${i+1}`,step:"retry",
    input:{phase:"review-pr",attempt:1,failure_tail:"test failed"},label:"fix",
    label_source:"independent-human",labeled_before_replay:true}));
  fs.writeFileSync(input,rows.map(r=>JSON.stringify(r)).join("\n"));
  const guard=path.join(f.dir,"no-network.mjs");
  fs.writeFileSync(guard,'globalThis.fetch=()=>{throw new Error("network forbidden in fixture")};');
  const out=path.join(f.dir,"answers.jsonl");
  const r=f.run(["replay","--in",input,"--out",out,"--send","--consent-public-repo","owner/repo"],
    {TYPESAFE_API_KEY:"dummy-test-key",NODE_OPTIONS:`--import=${guard}`});
  assert.equal(r.status,2);
  assert.match(r.stderr,/sample floor/);
  assert.equal(fs.existsSync(out),false);
});
