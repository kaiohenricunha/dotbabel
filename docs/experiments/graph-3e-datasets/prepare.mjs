// Offline validation and read-only GitHub collection. No model client or replay.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { validateDecisionInput } from "../../../plugins/dotbabel/src/decider.mjs";
import { dispatchProfile, RULES, analyze, protocolHash } from "../graph-step-adoption/protocol.mjs";

const execute = promisify(execFile);
const reviewers = ["architect-reviewer", "security-auditor", "compliance-auditor", "documentation-writer"];
const phases = ["pre-pr", "open-pr", "post-pr-review", "review-pr", "local-attest"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const lines = file => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
const clean = value => typeof value === "string" ? scrub(value) : Array.isArray(value) ? value.map(clean) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)])) : value;
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);

export function scrub(text) {
  return text.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})/g,"[REDACTED]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)\S+/gi,"$1[REDACTED]")
    .replace(/(\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|API_KEY|TOKEN|SECRET|PASSWORD)["']?[^\S\n]*[:=][^\S\n]*["']?)[^\s,"'}]+/gi,"$1[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,"[REDACTED PRIVATE KEY]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,"$1[REDACTED]@");
}

export function save(file, value) {
  const parent=path.dirname(file);
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  fs.writeFileSync(file,value,{flag:"wx",mode:0o600});
}

export function checkCase(row, annotation, verification, proof) {
  const errors=[];
  try { validateDecisionInput(row.step,row.input); } catch { errors.push("input_schema"); }
  if (!Number.isInteger(row.pr) || row.pr<1 || !/^[\w.-]+\/[\w.-]+$/.test(row.repo??"") ||
      !/^[a-f0-9]{40}$/.test(row.head_sha??"") || row.source!==`https://github.com/${row.repo}/pull/${row.pr}` ||
      typeof row.id!=="string" || !row.id) errors.push("provenance_schema");
  if (row.label_source!=="ai-annotation-verified") errors.push("label_source");
  if (row.labeled_before_replay!==true) errors.push("label_timing");
  if (!Array.isArray(row.evidence) || !row.evidence.length || !row.annotation_ref || !row.verification_ref) errors.push("evidence");
  if (!proof || proof.head_sha!==row.head_sha || proof.repo!==row.repo || proof.pr!==row.pr || proof.decision_head_verified!==true) errors.push("commit_provenance");
  if (!annotation || annotation.id!==row.id || annotation.head_sha!==row.head_sha || !equal(annotation.label,row.label) ||
      !annotation.annotator || !annotation.rationale || annotation.blind_to_predictions!==true || !annotation.evidence?.length) errors.push("annotation");
  if (!verification || verification.id!==row.id || verification.head_sha!==row.head_sha || !equal(verification.label,row.label) ||
      !verification.verifier || verification.verifier===annotation?.annotator || verification.status!=="agree" ||
      verification.blind_to_predictions!==true || !verification.rationale || !verification.evidence?.length || !Array.isArray(verification.disagreements)) errors.push("verification");
  if(row.step==="retry") {
    if(row.input.attempt>=RULES.max_attempts) errors.push("cap_determined");
    if(!["retry","fix","ask-owner"].includes(row.label)) errors.push("invalid_label");
    if(!phases.includes(row.input.phase) || !row.input.failure_tail?.trim() || proof?.failure_link_verified!==true || proof?.original_log!==true ||
       proof.phase!==row.input.phase || proof.attempt!==row.input.attempt || proof.failure_tail!==row.input.failure_tail) errors.push("failure_provenance");
  } else if(row.step==="dispatch") {
    if(!row.input.candidates.some(c=>!row.input.profile.includes(c))) errors.push("no_additional_candidate");
    if(!Array.isArray(row.label) || new Set(row.label).size!==row.label.length ||
        row.label.some(c=>!row.input.candidates.includes(c)||row.input.profile.includes(c))) errors.push("invalid_label");
    if(!equal(proof?.input,row.input)||proof?.profile_rule_verified!==true||proof?.historical_profile_verified!==true) errors.push("dispatch_provenance");
    if(Array.isArray(row.label)&&!row.label.length&&annotation?.inspection_complete!==true) errors.push("negative_evidence");
  } else errors.push("step");
  return errors;
}

export function summarize(rows) {
  return Object.fromEntries(["retry","dispatch"].map(step=>{
    const subset=rows.filter(r=>r.step===step), groups=new Set(subset.map(r=>`${r.repo}#${r.pr}`)).size;
    const classes=step==="retry"?Object.fromEntries(["retry","fix","ask-owner"].map(a=>[a,subset.filter(r=>r.label===a).length])):
      {additions:subset.filter(r=>r.label.length>0).length,none:subset.filter(r=>r.label.length===0).length};
    const shortfall={rows:Math.max(0,RULES.minimum_rows-subset.length),groups:Math.max(0,RULES.minimum_prs-groups),
      classes:Object.fromEntries(Object.entries(classes).map(([k,n])=>[k,Math.max(0,RULES.minimum_per_class-n)]))};
    return [step,{rows:subset.length,groups,classes,shortfall,ready:!shortfall.rows&&!shortfall.groups&&Object.values(shortfall.classes).every(n=>!n)}];
  }));
}

function safeRef(root,ref) {
  if(typeof ref!=="string"||path.isAbsolute(ref)) throw new Error("invalid evidence reference");
  const resolved=path.resolve(root,ref);
  if(!resolved.startsWith(path.resolve(root)+path.sep)||!fs.statSync(resolved).isFile()||fs.lstatSync(resolved).isSymbolicLink()) throw new Error("unsafe evidence reference");
  return resolved;
}

function inventory(root,relative="") {
  return fs.readdirSync(path.join(root,relative)).flatMap(name=>{
    const ref=path.join(relative,name), file=path.join(root,ref), stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()) throw new Error("symlink in evidence");
    if((stat.mode&0o777)!==(stat.isDirectory()?0o700:0o600)) throw new Error(`incorrect permissions: ${ref}`);
    return stat.isDirectory()?inventory(root,ref):[{path:ref,bytes:stat.size,sha256:digest(fs.readFileSync(file))}];
  });
}

export function validate(root) {
  if((fs.statSync(root).mode&0o777)!==0o700) throw new Error("root permissions");
  const rows=[...lines(path.join(root,"retry.jsonl")),...lines(path.join(root,"dispatch.jsonl"))];
  const annotations=lines(path.join(root,"annotations.jsonl")), verifications=lines(path.join(root,"verification.jsonl"));
  const unique=list=>{const map=new Map();for(const r of list){if(!r.id||map.has(r.id))throw new Error("duplicate or missing ID");map.set(r.id,r);}return map;};
  unique(rows); const am=unique(annotations), vm=unique(verifications), states=new Set();
  for(const row of rows) {
    const key=JSON.stringify([row.repo,row.pr,row.head_sha,row.step,row.input]);
    if(states.has(key))throw new Error("duplicate decision state"); states.add(key);
    const proof=read(safeRef(root,row.provenance_ref));
    const errors=checkCase(row,am.get(row.id),vm.get(row.id),proof);
    if(errors.length)throw new Error(`${row.id}: ${errors.join(",")}`);
    if(row.step==="dispatch") {
      const state=read(safeRef(root,proof.review_state_ref));
      const roster=observedProfile(state.reviews,state.head_sha);
      const files=state.files.map(f=>f.filename).sort(), n=state.files.reduce((v,f)=>v+f.additions+f.deletions,0);
      const baseline=dispatchProfile(files,n,state.historical_facts.facts.protected_paths);
      if(state.repo!==row.repo||state.pr!==row.pr||state.head_sha!==row.head_sha||
         !state.comparison_complete||!state.files.length||state.files.some(f=>!f.patch)||
         !state.commits.some(c=>c.sha===row.head_sha)||state.review_anchor.head_sha!==row.head_sha||
         !roster||!equal(roster,proof.roster_evidence)||!equal(roster.reviewers,row.input.profile)||
         !equal(files,row.input.changed_files)||n!==row.input.changed_lines||
         !equal(reviewers.filter(c=>!roster.reviewers.includes(c)),row.input.candidates)||
         proof.historical_profile_verified!==true||!equal(baseline.reviewers,proof.baseline_profile)||
         state.historical_facts.commit!==state.merge_base_sha||proof.historical_facts_commit!==state.merge_base_sha)
        throw new Error("original dispatch state does not match evidence");
    }
    for(const ref of [...row.evidence,...am.get(row.id).evidence,...vm.get(row.id).evidence,row.annotation_ref,row.verification_ref])safeRef(root,ref);
  }
  const files=inventory(root).filter(f=>f.path!=="manifest.json");
  const manifest=read(path.join(root,"manifest.json"));
  if(manifest.protocol_hash!==protocolHash()||!equal(manifest.rules,RULES))throw new Error("protocol changed");
  if(!equal(manifest.files,files))throw new Error("manifest hashes differ");
  const counts=summarize(rows);
  if(!equal(manifest.datasets,counts))throw new Error("manifest counts differ");
  const evaluation=Object.fromEntries(["retry","dispatch"].map(s=>[s,analyze(s,rows.filter(r=>r.step===s),[])]));
  if(Object.values(evaluation).some(r=>r.decision!=="INCONCLUSIVE"||r.answered))throw new Error("unexpected evaluation");
  return {structural_valid:true,sample_floors_met:Object.values(counts).every(s=>s.ready),datasets:counts,evaluator:evaluation};
}

export function seal(root) {
  const rows=[...lines(path.join(root,"retry.jsonl")),...lines(path.join(root,"dispatch.jsonl"))];
  const counts=summarize(rows), exclusions=[...lines(path.join(root,"excluded.jsonl")),...lines(path.join(root,"original-profile-excluded.jsonl"))], unknown=lines(path.join(root,"unknown.jsonl"));
  const countBy=(rs,key)=>Object.fromEntries([...new Set(rs.map(key))].sort().map(k=>[k,rs.filter(r=>key(r)===k).length]));
  const config=read(path.join(root,"collection-config.json"));
  const sourceHashes=config.sources.map((file,i)=>({original:path.basename(file),original_sha256:digest(fs.readFileSync(file)),
    retained:`sources/${i}-${path.basename(file).replace(/\.gz$/,"")}`,retained_is_sanitized:true}));
  save(path.join(root,"manifest.json"),JSON.stringify({version:1,created_at:new Date().toISOString(),
    protocol_hash:protocolHash(),rules:RULES,label_source:"ai-annotation-verified",human_labels:false,
    replay_performed:false,protocol_compatible:false,datasets:counts,
    source_coverage:read(path.join(root,"collection.json")),source_hashes:sourceHashes,verified_by_repo:countBy(rows,r=>r.repo),
    unknown:countBy(unknown,r=>r.reason),excluded:countBy(exclusions,r=>r.reason),
    groups:Object.fromEntries(["retry","dispatch"].map(s=>[s,[...new Set(rows.filter(r=>r.step===s).map(r=>`${r.repo}#${r.pr}`))].sort()])),
    files:inventory(root)},null,2)+"\n");
}

async function gh(args) {
  const {stdout}=await execute("gh",args,{maxBuffer:40*1024*1024});
  return JSON.parse(stdout);
}

// The config contains explicit repository paths. Never search user-session directories.
export async function collect(configFile,root) {
  if(fs.existsSync(root))throw new Error("output must be new");
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const config=read(configFile), candidates=[], excluded=[], unknown=[], coverage=[], sourceHashes=[];
  save(path.join(root,"collection-config.json"),JSON.stringify(config,null,2)+"\n");
  for(const [i,file]of config.sources.entries()) {
    const bytes=fs.readFileSync(file);sourceHashes.push({name:path.basename(file),sha256:digest(bytes),bytes:bytes.length});
    const body=file.endsWith(".gz")?gunzipSync(bytes).toString():bytes.toString();
    const sanitized=file.includes(".jsonl")?jsonl(body.split("\n").filter(Boolean).map(s=>clean(JSON.parse(s)))):JSON.stringify(clean(JSON.parse(body)))+"\n";
    save(path.join(root,`sources/${i}-${path.basename(file).replace(/\.gz$/,"")}`),sanitized);
  }
  for(const repo of config.repositories) {
    if(!/^[\w.-]+\/[\w.-]+$/.test(repo.name))throw new Error("invalid repo");
    const slug=repo.name.replace("/","--"), facts=read(repo.facts);
    save(path.join(root,`sources/${slug}-facts.json`),JSON.stringify(facts,null,2)+"\n");
    let prs;
    if(repo.metadata) {
      const byNumber=new Map();
      for(const f of repo.metadata)for(const pr of JSON.parse(gunzipSync(fs.readFileSync(f))))byNumber.set(pr.number,pr);
      prs=[...byNumber.values()];
    } else prs=await gh(["pr","list","--repo",repo.name,"--state","merged","--limit","1000","--json","number,headRefOid,additions,deletions,files,changedFiles"]);
    save(path.join(root,`sources/${slug}-prs.json`),JSON.stringify(prs)+"\n");
    let eligible=0, failures=0, receipts=0;
    for(const name of fs.readdirSync(repo.receipts).filter(n=>/^pr-\d+\.json$/.test(n))) {
      const receipt=read(path.join(repo.receipts,name)); receipts++;
      const ref=`evidence/${slug}-${name}`;save(path.join(root,ref),JSON.stringify(clean(receipt),null,2)+"\n");
      const consecutive={};
      for(const a of receipt.attempts) {
        if(a.outcome==="pass"||a.reason_code==="USER_ALLOWED_RETRY")consecutive[a.phase]=0;
        if(!["fail","blocked"].includes(a.outcome))continue;
        consecutive[a.phase]=(consecutive[a.phase]??0)+1;
        const item={id:`${repo.name}#${receipt.pr}:retry:${a.head_sha}:${a.phase}:${a.n}`,repo:repo.name,pr:receipt.pr,
          step:"retry",head_sha:a.head_sha,phase:a.phase,attempt:consecutive[a.phase],receipt_n:a.n,evidence:[ref],linked_evidence:a.evidence};
        if(!phases.includes(a.phase)) {excluded.push({...item,reason:"not_operational_phase"});continue;}
        failures++;
        if(item.attempt>=RULES.max_attempts){excluded.push({...item,reason:"cap_determined"});continue;}
        unknown.push({...item,reason:"missing_linked_original_failure_log",label:null});
      }
    }
    for(const pr of prs) {
      const id=`${repo.name}#${pr.number}:dispatch:${pr.headRefOid}`;
      const item={id,repo:repo.name,pr:pr.number,step:"dispatch",head_sha:pr.headRefOid};
      if(!/^[a-f0-9]{40}$/.test(pr.headRefOid??"")||!Array.isArray(pr.files)||!pr.files.length||
          pr.changedFiles!==pr.files.length||pr.files.length>=100||!Number.isInteger(pr.additions)||!Number.isInteger(pr.deletions)||pr.additions<0||pr.deletions<0) {
        excluded.push({...item,reason:"incomplete_pr_snapshot"});continue;
      }
      const files=pr.files.map(f=>f.path).sort(), n=pr.additions+pr.deletions;
      const profile=dispatchProfile(files,n,facts.protected_paths);
      if(profile.reviewers.length===reviewers.length){excluded.push({...item,reason:"no_additional_candidate"});continue;}
      eligible++;
      // Preserve all opportunities; collect original review heads where an anchor exists.
      candidates.push({...item,source:`https://github.com/${repo.name}/pull/${pr.number}`,step:"dispatch",
        input:{profile:profile.reviewers,changed_files:files,changed_lines:n,candidates:reviewers.filter(r=>!profile.reviewers.includes(r))},
        label:null,label_source:null,labeled_before_replay:false,profile_name:profile.name,
        facts_ref:`sources/${slug}-facts.json`,metadata_ref:`sources/${slug}-prs.json`});
    }
    coverage.push({repo:repo.name,prs:prs.length,dispatch_opportunities:eligible,receipt_files:receipts,failed_operational_attempts:failures});
  }
  save(path.join(root,"candidates.jsonl"),jsonl(candidates));
  save(path.join(root,"excluded.jsonl"),jsonl(excluded));
  save(path.join(root,"retry-unknown.jsonl"),jsonl(unknown));
  save(path.join(root,"collection.json"),JSON.stringify({collected_at:new Date().toISOString(),coverage,source_hashes:sourceHashes,profile_rules:{
    source:"docs/experiments/graph-step-adoption/protocol.mjs:20-25",kind:"reconstructed-protocol-v1-baseline; not a claim about historical assigned reviewers",
    protected:"full four reviewers",docs:"all .md or docs/ paths: documentation-writer and security-auditor",
    small:"under 150 changed lines: security-auditor and architect-reviewer",other:"full four reviewers",
    facts:"repository-specific frozen facts snapshot; historical applicability must be verified separately"}},null,2)+"\n");
  return {coverage,candidates:candidates.length,retry_unknown:unknown.length,excluded:excluded.length};
}

async function recoverState(root,row,pr,reviews,anchor,file) {
  const comparison=await gh(["api",`repos/${row.repo}/compare/${pr.base.sha}...${anchor.commit_id}`]);
  let historicalFacts=null;
  try {
    const content=await gh(["api",`repos/${row.repo}/contents/docs/repo-facts.json?ref=${comparison.merge_base_commit.sha}`]);
    historicalFacts={commit:comparison.merge_base_commit.sha,blob_sha:content.sha,
      facts:JSON.parse(Buffer.from(content.content,"base64").toString("utf8"))};
  } catch { /* Missing historical facts remain explicit unknown evidence. */ }
  const state={historical_facts:historicalFacts,repo:row.repo,pr:row.pr,head_sha:anchor.commit_id,decision_head_verified:comparison.commits.some(c=>c.sha===anchor.commit_id),
    review_anchor:{id:anchor.id,url:anchor.html_url,head_sha:anchor.commit_id,at:anchor.submitted_at},
    original_snapshot_head:row.head_sha,base_sha:pr.base.sha,merge_base_sha:comparison.merge_base_commit.sha,
    files:comparison.files,commits:comparison.commits.map(c=>({sha:c.sha,parents:c.parents.map(p=>p.sha)})),
    comparison_complete:comparison.total_commits===comparison.commits.length&&comparison.files.length<300,
    pr_metadata:{head_sha:pr.head.sha,base_sha:pr.base.sha,merged_at:pr.merged_at},
    reviews:reviews.map(r=>({id:r.id,commit_id:r.commit_id,submitted_at:r.submitted_at,body:r.body,url:r.html_url}))};
  save(file,JSON.stringify(clean(state))+"\n");
}

export async function recover(root,repoFilter) {
  const rows=lines(path.join(root,"candidates.jsonl")).filter(r=>!repoFilter||r.repo===repoFilter);
  let cursor=0, recovered=0, failed=0;
  async function worker() {
    while(cursor<rows.length) {
      const row=rows[cursor++], slug=row.repo.replace("/","--"), ref=`evidence/${slug}-${row.pr}-review-state.json`, file=path.join(root,ref);
      if(fs.existsSync(file))continue;
      try {
        const [pr,reviews]=await Promise.all([gh(["api",`repos/${row.repo}/pulls/${row.pr}`]),gh(["api",`repos/${row.repo}/pulls/${row.pr}/reviews?per_page=100`,"--paginate","--slurp"])]);
        const anchors=reviews.flat().filter(r=>r.user.login===row.repo.split("/")[0]&&/post-pr-review|review agents|automated review/i.test(r.body));
        const anchor=anchors.sort((a,b)=>a.submitted_at.localeCompare(b.submitted_at))[0];
        if(!anchor){save(file,JSON.stringify({id:row.id,reason:"no_original_review_head_anchor",pr,reviews:reviews.flat()})+"\n");failed++;continue;}
        await recoverState(root,row,pr,reviews.flat(),anchor,file);recovered++;
      } catch(error) {
        // Do not persist subprocess errors: they may carry request headers.
        save(file,JSON.stringify({id:row.id,reason:"github_read_failed",exit_code:error.code??null})+"\n");failed++;
      }
    }
  }
  await Promise.all(Array.from({length:4},worker));
  return {recovered,failed};
}


export async function recoverMore(root,repoFilter) {
  const rows=lines(path.join(root,"candidates.jsonl")).filter(r=>!repoFilter||r.repo===repoFilter);
  const findings=fs.readdirSync(path.join(root,"sources")).filter(f=>f.endsWith("findings.jsonl")).flatMap(f=>lines(path.join(root,"sources",f)));
  let cursor=0, recovered=0, failed=0;
  async function worker() {
    while(cursor<rows.length) {
      const row=rows[cursor++], slug=row.repo.replace("/","--"), ref=`evidence/${slug}-${row.pr}-anchored-state.json`, file=path.join(root,ref);
      if(fs.existsSync(file))continue;
      const prior=read(path.join(root,`evidence/${slug}-${row.pr}-review-state.json`));
      if(!prior.reason)continue;
      try {
        const pr=prior.pr, reviews=prior.reviews??[];
        if(!pr)continue;
        const known=findings.filter(f=>f.repo===row.repo&&f.pr===row.pr&&/^[a-f0-9]{40}$/.test(f.commit_id)).map(f=>({
          id:f.comment_id,html_url:`https://github.com/${row.repo}/pull/${row.pr}#discussion_r${f.comment_id}`,
          commit_id:f.commit_id,submitted_at:f.posted_at,kind:"archived-review-finding"}));
        const substantive=reviews.filter(r=>r.body?.trim()&&!/unable to review|quota limit|usage limit/i.test(r.body));
        const anchor=[...known,...substantive].sort((a,b)=>a.submitted_at.localeCompare(b.submitted_at))[0];
        if(!anchor){save(file,JSON.stringify({id:row.id,reason:"no_original_review_head_anchor",pr,reviews:reviews.flat()})+"\n");failed++;continue;}
        await recoverState(root,row,pr,reviews,anchor,file);recovered++;
      } catch(error) {
        // Do not persist subprocess errors: they may carry request headers.
        save(file,JSON.stringify({id:row.id,reason:"github_read_failed",exit_code:error.code??null})+"\n");failed++;
      }
    }
  }
  await Promise.all(Array.from({length:4},worker));
  return {recovered,failed};
}


export async function recoverRetry(root) {
  const cases=lines(path.join(root,"retry-unknown.jsonl")), groups=new Map(cases.map(r=>[`${r.repo}#${r.pr}`,r]));
  for(const row of groups.values()) {
    const ref=`evidence/${row.repo.replace("/","--")}-${row.pr}-retry-comments.json`;
    if(fs.existsSync(path.join(root,ref)))continue;
    const comments=await gh(["api",`repos/${row.repo}/issues/${row.pr}/comments?per_page=100`,"--paginate","--slurp"]);
    save(path.join(root,ref),JSON.stringify(clean(comments.flat().map(c=>({id:c.id,url:c.html_url,created_at:c.created_at,body:c.body,user:c.user.login}))))+"\n");
  }
  return {receipt_cases:cases.length,comment_groups:groups.size};
}

export function observedProfile(reviews,head) {
  const matches=[];
  for(const review of reviews.filter(r=>r.commit_id===head)) {
    for(const line of review.body.split("\n")) {
      if(line.length>650)continue;
      if(!/^(?:agents:|\*\*Agents:\*\*|Fleet:|Assembled by \d+ review agents|Two agents reviewed|Automated review[^\n]*:|AI review of|## AI review)/i.test(line))continue;
      const names=[...line.matchAll(/\b(?:architect-reviewer|security-auditor|compliance-auditor|documentation-writer|code-reviewer)\b/g)].map(m=>m[0]);
      if(names.length>=2)matches.push({reviewers:[...new Set(names)],line,review_id:review.id});
    }
  }
  if(!matches.length)return null;
  const receipt=matches.find(m=>/^agents:/.test(m.line));
  const chosen=receipt??matches[0];
  if(matches.some(m=>!equal([...m.reviewers].sort(),[...chosen.reviewers].sort())))return null;
  return chosen;
}

export function stage(root) {
  const candidates=lines(path.join(root,"candidates.jsonl")), ready=[], unknown=[];
  for(const r of candidates) {
    const stem=`evidence/${r.repo.replace("/","--")}-${r.pr}`;
    const ref=fs.existsSync(path.join(root,stem+"-anchored-state.json"))?stem+"-anchored-state.json":stem+"-review-state.json";
    if(!fs.existsSync(path.join(root,ref))){unknown.push({...r,reason:"review_state_not_recovered"});continue;}
    const p=read(path.join(root,ref));
    if(p.reason||!p.decision_head_verified||!p.comparison_complete||!p.files.length||p.files.some(f=>!f.patch)) {
      unknown.push({...r,reason:p.reason??"incomplete_pinned_diff",evidence:[ref]});continue;
    }
    if(!Array.isArray(p.historical_facts?.facts?.protected_paths)) {
      unknown.push({...r,reason:"historical_protected_paths_unavailable",evidence:[ref]});continue;
    }
    const facts=p.historical_facts.facts, files=p.files.map(f=>f.filename).sort(), n=p.files.reduce((v,f)=>v+f.additions+f.deletions,0);
    const profile=dispatchProfile(files,n,facts.protected_paths);

    const observed=observedProfile(p.reviews,p.head_sha);
    if(!observed){unknown.push({...r,reason:"original_reviewer_profile_unverified",evidence:[ref]});continue;}
    if(observed.reviewers.some(a=>!reviewers.includes(a))){unknown.push({...r,reason:"historical_candidate_inventory_differs",evidence:[ref]});continue;}
    if(observed.reviewers.length===reviewers.length){unknown.push({...r,reason:"original_profile_all_reviewers_included",evidence:[ref]});continue;}
    const input={profile:observed.reviewers,changed_files:files,changed_lines:n,candidates:reviewers.filter(a=>!observed.reviewers.includes(a))};
    const id=`${r.repo}#${r.pr}:dispatch:${p.head_sha}`, proofRef=`evidence/${r.repo.replace("/","--")}-${r.pr}-provenance.json`;
    save(path.join(root,proofRef),JSON.stringify({repo:r.repo,pr:r.pr,head_sha:p.head_sha,decision_head_verified:true,input,
      profile_rule_verified:true,profile_name:profile.name,baseline_profile:profile.reviewers,profile_kind:"observed-original-review-roster",
      roster_evidence:observed,historical_profile_verified:true,historical_facts_commit:p.historical_facts.commit,facts_ref:r.facts_ref,review_state_ref:ref},null,2)+"\n");
    ready.push({id,repo:r.repo,pr:r.pr,head_sha:p.head_sha,source:r.source,step:"dispatch",input,
      label:null,label_source:null,labeled_before_replay:false,evidence:[ref,r.facts_ref,proofRef],provenance_ref:proofRef});
  }
  save(path.join(root,"annotation-input.jsonl"),jsonl(ready));
  save(path.join(root,"dispatch-unknown.jsonl"),jsonl(unknown));
  return {ready_for_annotation:ready.length,unknown:unknown.length};
}

export function finalize(root) {
  const input=lines(path.join(root,"annotation-input.jsonl"));
  const annotations=lines(path.join(root,"annotations.jsonl")), verifications=lines(path.join(root,"verification.jsonl"));
  const map=rs=>{const m=new Map();for(const r of rs){if(m.has(r.id))throw new Error("duplicate annotation ID");m.set(r.id,r);}return m;};
  const am=map(annotations), vm=map(verifications), rows=[], unresolved=[];
  for(const r of input) {
    const a=am.get(r.id), v=vm.get(r.id);
    const row={...r,label:a?.label??null,label_source:"ai-annotation-verified",labeled_before_replay:true,
      annotation_ref:"annotations.jsonl",verification_ref:"verification.jsonl"};
    const errors=checkCase(row,a,v,read(safeRef(root,r.provenance_ref)));
    if(errors.length){unresolved.push({...r,reason:"annotation_unresolved",annotation_errors:errors,annotation_ref:"annotations.jsonl",verification_ref:"verification.jsonl"});continue;}
    rows.push(row);
  }
  const prior=lines(path.join(root,"dispatch-unknown.jsonl")), additionalExcluded=prior.filter(r=>r.reason==="original_profile_all_reviewers_included");
  const unknown=[...lines(path.join(root,"retry-unknown.jsonl")),...prior.filter(r=>r.reason!=="original_profile_all_reviewers_included"),...unresolved];
  save(path.join(root,"original-profile-excluded.jsonl"),jsonl(additionalExcluded));
  save(path.join(root,"unknown.jsonl"),jsonl(unknown));
  for(const step of ["retry","dispatch"])save(path.join(root,step+".jsonl"),jsonl(rows.filter(r=>r.step===step)));
  return summarize(rows);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [command,...args]=process.argv.slice(2);let result;
    if(command==="collect")result=await collect(...args);
    else if(command==="recover")result=await recover(...args);
    else if(command==="recover-more")result=await recoverMore(...args);
    else if(command==="recover-retry")result=await recoverRetry(...args);
    else if(command==="stage")result=stage(...args);
    else if(command==="finalize")result=finalize(...args);
    else if(command==="seal") {seal(...args);result=validate(...args);}
    else if(command==="validate")result=validate(...args);
    else throw new Error("expected collect CONFIG OUT, recover OUT [REPO], recover-more OUT [REPO], recover-retry OUT, stage OUT, finalize OUT, seal OUT, validate OUT");
    process.stdout.write(JSON.stringify(result,null,2)+"\n");
  } catch(error) { process.stderr.write(scrub(String(error.message))+"\n");process.exitCode=2; }
}
