import { describe,it,expect } from "vitest";
import {readFileSync}from"node:fs";
import {createHash}from"node:crypto";
import yaml from "js-yaml";
import {parseComputeDeclaration}from"../src/model-intelligence/requirement/index.mjs";
import {parseProjectionSource}from"../src/model-intelligence/materialize/render.mjs";
import {buildClaudeBaseline}from"../src/model-intelligence/materialize/runtime/claude-build.mjs";
import {readSnapshot,snapshotCatalog}from"../src/model-intelligence/snapshot/index.mjs";
import {resolve}from"../src/model-intelligence/resolver/index.mjs";
import {mergePolicy,SHIPPED_POLICY}from"../src/model-intelligence/policy/index.mjs";
const fixture=JSON.parse(readFileSync(new URL("./fixtures/model-intelligence/migration-batches.json",import.meta.url),"utf8"));
const snapshot=readSnapshot();
const artifact=entry=>({sourcePath:entry.sourcePath,sourceContent:readFileSync(new URL(`../../../${entry.sourcePath}`,import.meta.url),"utf8"),target:{path:entry.sourcePath,artifactKind:entry.artifactKind??"skill"}});
for(const[batch,category]of[["P-19a","E"],["P-19b","C"],["P-19d","A"]])describe(batch,()=>{
 const entries=fixture.entries.filter(entry=>entry.batch===undefined&&entry.category===category&&(batch!=="P-19b"||entry.artifactKind==="agent"));
 it(`${batch}: every artifact in the batch parses to the expected NormalizedComputeRequirement`,()=>{
  expect(entries).toHaveLength(category==="A"?5:category==="C"?20:6);
  for(const entry of entries){const parsed=parseProjectionSource(artifact(entry));const compute=parseComputeDeclaration(parsed.frontmatter,{sourcePath:entry.sourcePath});expect(compute.errors).toEqual([]);expect(compute.declared,entry.sourcePath).toBe(true);expect(compute.requirement).toMatchObject(entry.compute);}
 });
 it(`${batch}: preserves original bodies, tools, native controls and unrelated metadata`,()=>{
  for(const entry of entries){const {frontmatter,body}=parseProjectionSource(artifact(entry));const {dotbabel,...metadata}=frontmatter;expect(metadata).toEqual(entry.frontmatter);expect(createHash("sha256").update(body).digest("hex")).toBe(entry.bodyHash);expect(dotbabel.compute).toEqual(entry.compute);}
 });
 it(`${batch}: resolve() for claude reproduces the pre-migration effective model for every artifact`,()=>{
  for(const entry of entries){const current=artifact(entry),before={...current,sourceContent:`---\n${yaml.dump(entry.frontmatter,{lineWidth:-1})}---\n${parseProjectionSource(current).body}`};
   const oldFile=buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[before]}).files[0];
   const newFile=buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[current]}).files[0];
   expect(parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:newFile.content})).toEqual(parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:oldFile.content}));
   if(entry.artifactKind==="agent") {const resolved=resolve({requirement:parseProjectionSource(current).requirement,target:{runtimeId:"claude",artifactKind:"agent",sourcePath:entry.sourcePath},catalog:snapshotCatalog(snapshot),policy:mergePolicy({shipped:SHIPPED_POLICY}),runtimeContract:snapshot.runtimes.claude.runtimeContract,invocation:{pin:{runtime:"claude",config:{model:entry.frontmatter.model}},omitDefaultReasoning:true}});expect(resolved.status,entry.sourcePath).toBe("resolved");expect(resolved.configuration.axes).toEqual({model:entry.frontmatter.model});expect(resolved.enforcement.state).toBe("enforced");}
  }
 });
});
describe("P-19c skills",()=>{
 const entries=fixture.entries.filter(entry=>entry.batch==="P-19c-skills");
 it("P-19c skills: every artifact parses to the expected dynamic consumer requirement",()=>{
  expect(entries).toHaveLength(22);
  expect(entries.filter(entry=>entry.category==="C")).toHaveLength(21);expect(entries.filter(entry=>entry.category==="D")).toHaveLength(1);
  for(const entry of entries){const parsed=parseProjectionSource(artifact(entry));expect(parsed.requirement,entry.sourcePath).toMatchObject(entry.compute);expect(parsed.requirement.mode).toBe("dynamic");expect(parsed.requirement.binding).toBe("consumer");}
 });
 it("P-19c skills: bodies, native controls, workflow and unrelated metadata remain unchanged",()=>{
  for(const entry of entries){const parsed=parseProjectionSource(artifact(entry));const{dotbabel,...metadata}=parsed.frontmatter;expect(metadata,entry.sourcePath).toEqual(entry.frontmatter);expect(createHash("sha256").update(parsed.body).digest("hex")).toBe(entry.bodyHash);expect(dotbabel.compute).toEqual(entry.compute);}
 });
 it("P-19c skills: native projections reproduce the pre-migration configuration without claiming skill binding",()=>{
  for(const entry of entries){const current=artifact(entry),parsed=parseProjectionSource(current),before={...current,sourceContent:`---\n${yaml.dump(entry.frontmatter,{lineWidth:-1})}---\n${parsed.body}`};
   const oldNative=parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[before]}).files[0].content});
   const newNative=parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[current]}).files[0].content});
   expect(newNative,entry.sourcePath).toEqual(oldNative);expect(newNative.frontmatter).not.toHaveProperty("model");expect(newNative.frontmatter).not.toHaveProperty("effort");
   const result=resolve({requirement:parsed.requirement,target:{runtimeId:"claude",artifactKind:"skill",sourcePath:entry.sourcePath},catalog:snapshotCatalog(snapshot),policy:mergePolicy({shipped:SHIPPED_POLICY}),runtimeContract:snapshot.runtimes.claude.runtimeContract});expect(result.status,entry.sourcePath).toBe("resolved");expect(result.enforcement).toEqual({state:"unknown",basis:"none"});
  }
 });
 it("P-19c skills: explicit weak native choices cannot satisfy Deep or Frontier requirements",()=>{
  const nonRoutine=entries.filter(entry=>entry.compute.requirement!=="routine");expect(nonRoutine).toHaveLength(17);
  for(const entry of nonRoutine){const catalog=snapshotCatalog(snapshot);for(const model of catalog.runtimes[0].models)for(const fact of model.fields.capabilities)fact.value={reasoning:false,tool_call:true};
   const result=resolve({requirement:parseProjectionSource(artifact(entry)).requirement,target:{runtimeId:"claude",artifactKind:"skill",sourcePath:entry.sourcePath},catalog,policy:mergePolicy({shipped:SHIPPED_POLICY}),runtimeContract:snapshot.runtimes.claude.runtimeContract,invocation:{pin:{runtime:"claude",config:{model:entry.frontmatter.model}},omitDefaultReasoning:true}});expect(result.status,entry.sourcePath).toBe("conflict");expect(result.enforcement.state).toBe("unsatisfied");expect(result.configuration).toBeUndefined();
  }
 });
});
describe("P-19c commands",()=>{
 const entries=fixture.entries.filter(entry=>entry.batch==="P-19c-commands");
 const native=(entry,content)=>parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[{...artifact(entry),...(content?{sourceContent:content}:{})}]}).files[0].content});
 it("P-19c commands: every command parses to the expected dynamic session requirement",()=>{
  expect(entries).toHaveLength(7);
  expect(entries.filter(entry=>entry.category==="C")).toHaveLength(6);expect(entries.filter(entry=>entry.category==="D").map(entry=>entry.sourcePath)).toEqual(["commands/dependabot-sweep.md"]);
  for(const entry of entries){const parsed=parseProjectionSource(artifact(entry));expect(parsed.requirement,entry.sourcePath).toMatchObject(entry.compute);expect(parsed.requirement.mode).toBe("dynamic");expect(parsed.requirement.binding).toBe("session");}
 });
 it("P-19c commands: bodies, authored native model and unrelated metadata remain unchanged",()=>{
  for(const entry of entries){const parsed=parseProjectionSource(artifact(entry));const{dotbabel,...metadata}=parsed.frontmatter;expect(metadata,entry.sourcePath).toEqual(entry.frontmatter);expect(metadata.model).toMatch(/^(haiku|sonnet)$/);expect(createHash("sha256").update(parsed.body).digest("hex")).toBe(entry.bodyHash);expect(dotbabel.compute).toEqual(entry.compute);}
 });
 it("P-19c commands: release projections keep the pre-migration native model through the compatibility bridge",()=>{
  for(const entry of entries){const parsed=parseProjectionSource(artifact(entry)),before=`---\n${yaml.dump(entry.frontmatter,{lineWidth:-1})}---\n${parsed.body}`;
   const oldNative=native(entry,before),newNative=native(entry);
   expect(newNative,entry.sourcePath).toEqual(oldNative);expect(newNative.frontmatter.model).toBe(entry.frontmatter.model);expect(newNative.frontmatter).not.toHaveProperty("dotbabel");expect(newNative.frontmatter).not.toHaveProperty("effort");
   const result=resolve({requirement:parsed.requirement,target:{runtimeId:"claude",artifactKind:"command",sourcePath:entry.sourcePath},catalog:snapshotCatalog(snapshot),policy:mergePolicy({shipped:SHIPPED_POLICY}),runtimeContract:snapshot.runtimes.claude.runtimeContract,invocation:{pin:{runtime:"claude",config:{model:entry.frontmatter.model}},omitDefaultReasoning:true}});
   expect(result.status,entry.sourcePath).toBe("resolved");expect(result.configuration.axes.model).toBe(entry.frontmatter.model);
  }
 });
});
describe("P-19e skills",()=>{
 const entries=fixture.entries.filter(entry=>entry.batch==="P-19e-skills");
 const resolveFor=(entry,catalog=snapshotCatalog(snapshot),invocation)=>resolve({requirement:parseProjectionSource(artifact(entry)).requirement,target:{runtimeId:"claude",artifactKind:"skill",sourcePath:entry.sourcePath},catalog,policy:mergePolicy({shipped:SHIPPED_POLICY}),runtimeContract:snapshot.runtimes.claude.runtimeContract,...(invocation?{invocation}:{})});
 it("P-19e skills: every skill parses to its owner-approved consumer requirement",()=>{
  expect(entries.map(entry=>[entry.sourcePath,entry.compute.mode,entry.compute.requirement])).toEqual([["skills/post-pr-review/SKILL.md","dynamic","routine"],["skills/language-review/SKILL.md","dynamic","deep"],["skills/smoke-test/SKILL.md","dynamic","routine"],["skills/security-audit/SKILL.md","floor","frontier"]]);
  for(const entry of entries){const parsed=parseProjectionSource(artifact(entry));expect(parsed.requirement,entry.sourcePath).toMatchObject(entry.compute);expect(parsed.requirement.binding).toBe("consumer");}
 });
 it("P-19e skills: bodies, native controls and unrelated metadata remain unchanged",()=>{
  for(const entry of entries){const parsed=parseProjectionSource(artifact(entry));const{dotbabel,...metadata}=parsed.frontmatter;expect(metadata,entry.sourcePath).toEqual(entry.frontmatter);expect(createHash("sha256").update(parsed.body).digest("hex")).toBe(entry.bodyHash);expect(dotbabel.compute).toEqual(entry.compute);}
 });
 it("P-19e skills: native projections reproduce the pre-migration configuration and resolve without claiming skill binding",()=>{
  for(const entry of entries){const current=artifact(entry),parsed=parseProjectionSource(current),before={...current,sourceContent:`---\n${yaml.dump(entry.frontmatter,{lineWidth:-1})}---\n${parsed.body}`};
   const oldNative=parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[before]}).files[0].content});
   const newNative=parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[current]}).files[0].content});
   expect(newNative,entry.sourcePath).toEqual(oldNative);
   const result=resolveFor(entry);expect(result.status,entry.sourcePath).toBe("resolved");expect(result.enforcement).toEqual({state:"unknown",basis:"none"});
  }
 });
 it("P-19e skills: an explicit weak native choice cannot satisfy the Deep and Frontier requirements",()=>{
  const strong=entries.filter(entry=>["deep","frontier"].includes(entry.compute.requirement));expect(strong).toHaveLength(2);
  for(const entry of strong){const catalog=snapshotCatalog(snapshot);for(const model of catalog.runtimes[0].models)for(const fact of model.fields.capabilities)fact.value={reasoning:false,tool_call:true};
   const result=resolveFor(entry,catalog,{pin:{runtime:"claude",config:{model:entry.frontmatter.model}},omitDefaultReasoning:true});expect(result.status,entry.sourcePath).toBe("conflict");expect(result.enforcement.state).toBe("unsatisfied");
  }
 });
});
it("P-19a: local-attest still has no requirement and no projection",()=>{
 const source=artifact(fixture.neutral),parsed=parseProjectionSource(source);expect(parsed.requirement).toBeNull();expect(parsed.frontmatter).toEqual(fixture.neutral.frontmatter);expect(createHash("sha256").update(parsed.body).digest("hex")).toBe(fixture.neutral.bodyHash);
 const output=buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[source]}).files[0];const native=parseProjectionSource({sourcePath:fixture.neutral.sourcePath,sourceContent:output.content});expect(native.requirement).toBeNull();expect(native.frontmatter).not.toHaveProperty("model");expect(native.frontmatter).not.toHaveProperty("effort");expect(native.frontmatter["disable-model-invocation"]).toBe(true);
});

it("P-19d: the security agents resolve to a floor of frontier and their generated copies still carry a strong model",()=>{
 const securityAgents=fixture.entries.filter(item=>item.category==="A"&&item.artifactKind==="agent");expect(securityAgents).toHaveLength(2);
 for(const entry of securityAgents){
  const source=artifact(entry),parsed=parseProjectionSource(source);
  expect(parsed.requirement,entry.sourcePath).toMatchObject({mode:"floor",requirement:"frontier",binding:"self"});
  const result=resolve({requirement:parsed.requirement,target:{runtimeId:"claude",artifactKind:"agent",sourcePath:entry.sourcePath},catalog:snapshotCatalog(snapshot),policy:mergePolicy({shipped:SHIPPED_POLICY,user:{floor:{mode:"floor",requirement:"mechanical"}}}),runtimeContract:snapshot.runtimes.claude.runtimeContract,invocation:{pin:{runtime:"claude",config:{model:entry.frontmatter.model}},omitDefaultReasoning:true}});
  expect(result.status).toBe("resolved");expect(result.confidence).toBe("high");expect(result.enforcement).toEqual({state:"enforced",basis:"artifact-binding"});expect(result.configuration.axes).toEqual({model:entry.frontmatter.model});
  expect(result.explanation).toContainEqual(expect.objectContaining({code:"artifact_floor_applied",message:"The effective minimum is frontier."}));
  const generated=parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:readFileSync(new URL(`../../../plugins/dotbabel/templates/claude/${entry.sourcePath}`,import.meta.url),"utf8")});
  expect(generated.frontmatter.model).toBe(entry.frontmatter.model);expect(generated.frontmatter.tools).toBe(entry.frontmatter.tools);expect(generated.frontmatter).not.toHaveProperty("effort");expect(createHash("sha256").update(generated.body).digest("hex")).toBe(entry.bodyHash);
 }
});

it("P-19d: rollback-prod keeps the typed confirmation text unchanged",()=>{
 const entry=fixture.entries.find(item=>item.sourcePath==="skills/rollback-prod/SKILL.md");
 const source=artifact(entry),parsed=parseProjectionSource(source);expect(parsed.body).toContain("ROLLBACK PROD");expect(createHash("sha256").update(parsed.body).digest("hex")).toBe(entry.bodyHash);expect(parsed.frontmatter["disable-model-invocation"]).toBe(true);
 const output=buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[source]}).files[0];const native=parseProjectionSource({sourcePath:entry.sourcePath,sourceContent:output.content});expect(native.body).toBe(parsed.body);expect(native.frontmatter["disable-model-invocation"]).toBe(true);expect(native.frontmatter["user-invocable"]).toBe(true);
});

it("P-19d: consumer pins retain native axes as explicit intent without claiming native skill enforcement",()=>{
 for(const entry of fixture.entries.filter(item=>item.category==="A"&&item.compute.mode==="pin")){
  const parsed=parseProjectionSource(artifact(entry));expect(parsed.requirement).toMatchObject(entry.compute);
  const result=resolve({requirement:parsed.requirement,target:{runtimeId:"claude",artifactKind:"skill",sourcePath:entry.sourcePath},catalog:snapshotCatalog(snapshot),policy:mergePolicy({shipped:SHIPPED_POLICY}),runtimeContract:snapshot.runtimes.claude.runtimeContract});expect(result.status,entry.sourcePath).toBe("resolved");expect(result.configuration.axes).toEqual(entry.compute.pin.config);expect(result.enforcement).toEqual({state:"unknown",basis:"none"});
 }
});

it("P-19d: explicit native pins cannot satisfy the Frontier minimum with insufficient capability evidence",()=>{
 const entries=fixture.entries.filter(item=>item.batch===undefined&&item.category==="A"&&item.compute.requirement==="frontier");expect(entries).toHaveLength(4);
 for(const entry of entries){
  const catalog=snapshotCatalog(snapshot);for(const model of catalog.runtimes.find(runtime=>runtime.runtimeId==="claude").models)for(const fact of model.fields.capabilities)fact.value={reasoning:false,tool_call:true};
  const result=resolve({requirement:parseProjectionSource(artifact(entry)).requirement,target:{runtimeId:"claude",artifactKind:entry.artifactKind,sourcePath:entry.sourcePath},catalog,policy:mergePolicy({shipped:SHIPPED_POLICY}),runtimeContract:snapshot.runtimes.claude.runtimeContract,invocation:{pin:{runtime:"claude",config:entry.compute.pin?.config??{model:entry.frontmatter.model}},omitDefaultReasoning:true}});
  expect(result.status,entry.sourcePath).toBe("conflict");expect(result.enforcement.state).toBe("unsatisfied");expect(result.configuration).toBeUndefined();
 }
});
