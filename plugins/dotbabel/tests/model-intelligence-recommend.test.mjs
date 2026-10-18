import {expect,it}from"vitest";
import fs from"node:fs";import path from"node:path";import os from"node:os";import{spawnSync}from"node:child_process";
import {buildRecommendation}from"../src/model-intelligence/recommend/index.mjs";
import{resolve}from"../src/model-intelligence/resolver/index.mjs";
import{input,requirement}from"./fixtures/model-intelligence/resolver.mjs";
const resolved=()=>resolve(input({requirement:requirement("deep")}));
const observed={runtimeId:"codex",turnExecuted:true,configurationBasis:"as-run",axes:{model:"routine-model"},usage:[],fieldSources:{"axes.model":"fixture-stream"}};
it("builds a recommendation envelope from a ResolverResult and an observation without calling resolve internals",()=>{
 const resolverResult=resolved(),before=structuredClone(resolverResult),observation=structuredClone(observed);
 const report=buildRecommendation({resolverResult,observation,assessment:{observedClass:"routine",recommendedClass:"deep"},invocation:{command:"codex",args:["--model","deep-model"],unsupportedAxes:[]}});
 expect(report).toMatchObject({envelope:"ModelRecommendation",version:1,resolverResult,observation,advice:"escalate",configurationBasis:"advice",invocation:{command:"codex",args:["--model","deep-model"]}});expect(resolverResult).toEqual(before);expect(observation).toEqual(observed);
});
it("reports escalation when the observed session is below the requirement and de-escalation when above",()=>{
 const resolverResult=resolved();
 expect(buildRecommendation({resolverResult,observation:observed,assessment:{observedClass:"routine",recommendedClass:"deep"}}).advice).toBe("escalate");
 expect(buildRecommendation({resolverResult,observation:{...observed,axes:{model:"frontier-model"}},assessment:{observedClass:"frontier",recommendedClass:"deep"}}).advice).toBe("de-escalate");
});
it("never invents a model ranking from names or a reconstructed probe",()=>{
 const resolverResult=resolved();expect(buildRecommendation({resolverResult,observation:observed}).advice).toBe("change");
 expect(buildRecommendation({resolverResult,observation:{...observed,configurationBasis:"reconstructed",reconstructedFrom:[]},assessment:{observedClass:"routine",recommendedClass:"deep"}}).advice).toBe("unknown");
 expect(buildRecommendation({resolverResult}).advice).toBe("unknown");
});
it("keeps identical configurations and preserves unresolved evidence without executable advice",()=>{
 const resolverResult=resolved();expect(buildRecommendation({resolverResult,observation:{...observed,axes:{...resolverResult.configuration.axes}}}).advice).toBe("keep");
 const unresolved={status:"unresolved",enforcement:{state:"unknown",basis:"none"},confidence:"low",diagnostics:[{code:"no_evidence"}],explanation:[]};const report=buildRecommendation({resolverResult:unresolved,observation:observed});expect(report.advice).toBe("unavailable");expect(report).not.toHaveProperty("invocation");expect(report.resolverResult).toEqual(unresolved);
});
it("does not advertise a complete invocation when native axes are unsupported",()=>{
 const report=buildRecommendation({resolverResult:resolved(),invocation:{command:"codex",args:["--model","deep-model"],unsupportedAxes:["contextTier"]}});
 expect(report.invocation.unsupportedAxes).toEqual(["contextTier"]);expect(report.diagnostics).toContainEqual({code:"invocation_axes_unsupported"});expect(report.executable).toBe(false);
});
it("a recommendation without observation changes no files",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"mi-recommend-"));try{
 const env={...process.env,XDG_CACHE_HOME:path.join(root,"cache"),XDG_CONFIG_HOME:path.join(root,"config")};
 const seed=spawnSync(process.execPath,["plugins/dotbabel/tests/fixtures/model-intelligence/seed-resolver-cache.mjs",root,"valid"],{env,encoding:"utf8"});expect(seed.status,seed.stderr).toBe(0);
 const hashes=()=>Object.fromEntries(fs.readdirSync(root,{recursive:true}).filter(p=>fs.lstatSync(path.join(root,p)).isFile()).map(p=>[p,fs.readFileSync(path.join(root,p),"utf8")]));const before=hashes();
 const r=spawnSync(process.execPath,["plugins/dotbabel/bin/dotbabel-models.mjs","recommend","--requirement","deep","--runtime","codex","--repo-root",root,"--json"],{env,encoding:"utf8"});expect(r.status,r.stderr).toBe(0);const report=JSON.parse(r.stdout);expect(report.envelope).toBe("ModelRecommendation");expect(report.resolverResult.configuration.axes.model).toBe("opaque-cli-model");expect(report.configurationBasis).toBe("advice");expect(hashes()).toEqual(before);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
it("the module imports nothing from sources or catalog",()=>{
 const text=fs.readFileSync(new URL("../src/model-intelligence/recommend/index.mjs",import.meta.url),"utf8");expect(text).not.toMatch(/from\s+["'][^"']*(?:sources|catalog|resolver\/[^i])/);expect(text).not.toMatch(/(?:node:fs|node:child_process|fetch\()/);
});
it("a differing recommendation exits 0 and changes nothing",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"mi-recommend-observed-"));try{
 const env={...process.env,XDG_CACHE_HOME:path.join(root,"cache"),XDG_CONFIG_HOME:path.join(root,"config")};const seed=spawnSync(process.execPath,["plugins/dotbabel/tests/fixtures/model-intelligence/seed-resolver-cache.mjs",root,"valid"],{env,encoding:"utf8"});expect(seed.status).toBe(0);
 const file=path.join(root,"observation.json");fs.writeFileSync(file,JSON.stringify(observed));const before=fs.readFileSync(file,"utf8");
 const result=spawnSync(process.execPath,["plugins/dotbabel/bin/dotbabel-models.mjs","recommend","--requirement","deep","--runtime","codex","--repo-root",root,"--observation-file",file,"--json"],{env,encoding:"utf8"});expect(result.status,result.stderr).toBe(0);const report=JSON.parse(result.stdout);expect(report.observation).toEqual(observed);expect(report.advice).toBe("change");expect(fs.readFileSync(file,"utf8")).toBe(before);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
it("rejects stale observation comparisons and malformed recommendation input",()=>{
 expect(buildRecommendation({resolverResult:resolved(),observation:{...observed,freshness:"stale"},assessment:{observedClass:"routine",recommendedClass:"deep"}}).advice).toBe("unknown");
 for(const value of [undefined,null,{}, {status:"invented"}])expect(()=>buildRecommendation({resolverResult:value})).toThrow("recommendation_input_invalid");
});
it("requires a usable selected configuration and a matching as-run observation for any comparison",()=>{
 for(const axes of [undefined,null,[],"bad"]){const result=structuredClone(resolved());result.configuration.axes=axes;const report=buildRecommendation({resolverResult:result,observation:observed,invocation:{command:"codex",args:[],unsupportedAxes:[]}});expect(report.advice).toBe("unavailable");expect(report.executable).toBe(false);expect(report).not.toHaveProperty("invocation");}
 for(const patch of [{runtimeId:"claude"},{configurationBasis:undefined},{configurationBasis:"reconstructed"},{axes:null},{axes:[]},{freshness:"stale"},{freshness:"expired"},{freshness:"unknown"}])expect(buildRecommendation({resolverResult:resolved(),observation:{...observed,...patch},assessment:{observedClass:"routine",recommendedClass:"deep"}}).advice).toBe("unknown");
 for(const resolverResult of [null,[],false,"resolved",{}, {status:"invented"}])expect(()=>buildRecommendation({resolverResult})).toThrow("recommendation_input_invalid");
});
it("compares every selected axis exactly without confusing equal capability classes with equal configurations",()=>{
 const resolverResult=resolved(),axes=resolverResult.configuration.axes;
 for(const changed of [{...axes,reasoning:"another"},{model:axes.model},{...axes,contextTier:"extra"},{...axes,model:"another"}])expect(buildRecommendation({resolverResult,observation:{...observed,axes:changed},assessment:{observedClass:"deep",recommendedClass:"deep"}}).advice).toBe("change");
 expect(buildRecommendation({resolverResult,observation:{...observed,axes:{...axes}},assessment:{observedClass:"routine",recommendedClass:"exceptional"}}).advice).toBe("keep");
 for(const assessment of [{},{observedClass:"invalid",recommendedClass:"deep"},{observedClass:"routine",recommendedClass:"invalid"}])expect(buildRecommendation({resolverResult,observation:observed,assessment}).advice).toBe("change");
});
it("escalates from an actual below-requirement resolver assessment while preserving unrelated mismatch diagnostics",()=>{
 const result={...resolved(),enforcement:{state:"unsatisfied",basis:"session-observation"},explanation:[{code:"observed_session_below_requirement"}]};
 expect(buildRecommendation({resolverResult:result,observation:observed}).advice).toBe("escalate");
 for(const changed of [{...result,enforcement:{state:"unknown",basis:"session-observation"}},{...result,enforcement:{state:"unsatisfied",basis:"none"}},{...result,explanation:[{code:"observed_configuration_mismatch"}]},{...result,explanation:undefined}])expect(buildRecommendation({resolverResult:changed,observation:observed}).advice).toBe("change");
});
it("marks only complete renderer output executable and keeps unsupported fields visible",()=>{
 const resolverResult=resolved();for(const invocation of [undefined,{command:"codex",args:null,unsupportedAxes:[]},{command:"codex",args:[],unsupportedAxes:null},{command:"codex",args:[],unsupportedAxes:["contextTier"]}])expect(buildRecommendation({resolverResult,invocation}).executable).toBe(false);
 const invocation={command:"codex",args:["--model","deep-model"],unsupportedAxes:[]};const report=buildRecommendation({resolverResult,invocation});expect(report.executable).toBe(true);expect(report.diagnostics).toEqual([]);expect(report.advice).toBe("unknown");report.invocation.args.push("changed");expect(invocation.args).toEqual(["--model","deep-model"]);report.resolverResult.configuration.axes.model="changed";expect(resolverResult.configuration.axes.model).toBe("deep-model");
 for(const status of ["unresolved","conflict","invalid"]){const result={...resolverResult,status};const out=buildRecommendation({resolverResult:result,invocation});expect(out.advice).toBe("unavailable");expect(out.executable).toBe(false);expect(out).not.toHaveProperty("invocation");}
});
it("rejects malformed explicit observations with a bounded code and no private parser text",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"mi-recommend-invalid-"));try{
 const file=path.join(root,"observation.json");for(const text of ['{"PRIVATE_MARKER":',JSON.stringify({...observed,fieldSources:{}})]){
 fs.writeFileSync(file,text);const result=spawnSync(process.execPath,["plugins/dotbabel/bin/dotbabel-models.mjs","recommend","--requirement","deep","--runtime","codex","--repo-root",root,"--observation-file",file,"--json"],{encoding:"utf8"});expect(result.status).toBe(1);expect(JSON.parse(result.stdout).diagnostics).toEqual([{code:"recommendation_observation_invalid"}]);expect(result.stdout+result.stderr).not.toContain("PRIVATE_MARKER");}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
it("preserves the snapshot check/evidence-file usage guard before any file read",()=>{
 const result=spawnSync(process.execPath,["plugins/dotbabel/bin/dotbabel-models.mjs","snapshot","--check","--evidence-file","/unavailable-snapshot-evidence.json","--json"],{encoding:"utf8"});expect(result.status).toBe(64);expect(result.stderr).toContain("cannot be combined");
});
