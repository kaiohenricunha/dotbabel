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
for(const[batch,category]of[["P-19a","E"],["P-19b","C"]])describe(batch,()=>{
 const entries=fixture.entries.filter(entry=>entry.category===category);
 it(`${batch}: every artifact in the batch parses to the expected NormalizedComputeRequirement`,()=>{
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
it("P-19a: local-attest still has no requirement and no projection",()=>{
 const source=artifact(fixture.neutral),parsed=parseProjectionSource(source);expect(parsed.requirement).toBeNull();expect(parsed.frontmatter).toEqual(fixture.neutral.frontmatter);expect(createHash("sha256").update(parsed.body).digest("hex")).toBe(fixture.neutral.bodyHash);
 const output=buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[source]}).files[0];const native=parseProjectionSource({sourcePath:fixture.neutral.sourcePath,sourceContent:output.content});expect(native.requirement).toBeNull();expect(native.frontmatter).not.toHaveProperty("model");expect(native.frontmatter).not.toHaveProperty("effort");expect(native.frontmatter["disable-model-invocation"]).toBe(true);
});
