import {afterEach,expect,it} from "vitest";
import fs from "node:fs";import path from "node:path";import os from "node:os";
import yaml from "js-yaml";
import {planMigration,migrateArtifacts} from "../src/model-intelligence/compat/migrate.mjs";
import {acquireLock}from "../src/lib/process-lock.mjs";
const roots=[];afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
const content=(model="opus",extra={})=>"---\n"+yaml.dump({name:"fixture",model,...extra})+"---\n\nBody with Unicode: café.\r\n";
const artifact=(sourcePath="agents/fixture.md",artifactKind="agent",bytes=content())=>({sourcePath,artifactKind,content:bytes});
const compute={requirement:"frontier",mode:"floor",binding:"self"};
const decision=(extra={})=>({sourcePath:"agents/fixture.md",artifactKind:"agent",category:"C",compute,...extra});
const rootFixture=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"mi-migration-bounds-"));roots.push(root);fs.mkdirSync(path.join(root,"agents"));return root;};
it("validates all decision boundaries without echoing private input",()=>{
 const a=artifact();const values=[null,{},Array(1025).fill(decision()),[decision(),decision()],[decision({sourcePath:"agents/other.md"})],[decision({artifactKind:"skill"})],[decision({category:"UNKNOWN"})],[decision({extra:"PRIVATE_MARKER"})],[decision({compute:{...compute,binding:"session"}})],[decision({compute:{mode:"floor"}})],[decision({compute:undefined})]];
 for(const decisions of values){expect(()=>planMigration({artifacts:[a],decisions})).toThrow("migration_decision_invalid");}
});
it("validates inventory, modes and strict canonical source bytes before making a plan",()=>{
 for(const artifacts of [null,{},Array(1025).fill(artifact()),[artifact(),artifact()],[artifact("../escape.md")],[artifact("agents/a.md","skill")],[artifact("templates/generated.md","agent")]])expect(()=>planMigration({artifacts})).toThrow("migration_input_invalid");
 for(const bytes of [null,"no frontmatter","---\n[one, two]\n---\nBody","---\nmodel: [\n---\nBody","---\nname: a\ndotbabel:\n  compute: invalid\n---\nBody","x".repeat(1024*1024+1)])expect(()=>planMigration({artifacts:[artifact(undefined,undefined,bytes)]})).toThrow("migration_source_invalid");
 expect(()=>planMigration({artifacts:[artifact()],batch:"unknown"})).toThrow("migration_input_invalid");
});
it("preserves metadata, unrelated namespaces, native effort and exact body bytes",()=>{
 const a=artifact(undefined,undefined,content("opus",{effort:"max",dotbabel:{other:{enabled:true}},tools:["Read"]}));const before=structuredClone(a);
 const result=planMigration({artifacts:[a],decisions:[decision()]});const header=yaml.load(result.changes[0].content.split("---\n")[1]);
 expect(header).toMatchObject({name:"fixture",model:"opus",effort:"max",tools:["Read"],dotbabel:{other:{enabled:true},compute}});
 expect(result.changes[0].content.endsWith("\nBody with Unicode: café.\r\n")).toBe(true);expect(a).toEqual(before);expect(planMigration({artifacts:[a],decisions:[decision()]})).toEqual(result);
});
it("uses kind-specific inheritance without inventing omitted requirements",()=>{
 const artifacts=[artifact("commands/fixture.md","command",content("inherit")),artifact("skills/fixture/SKILL.md","skill",content("inherit")),artifact("agents/none.md","agent",content(undefined))];
 // Delete the model explicitly; the helper's default remains useful for all other rows.
 artifacts[2].content="---\nname: none\n---\nBody\n";
 const result=planMigration({artifacts});expect(result.changes).toHaveLength(2);
 expect(result.changes.map(x=>yaml.load(x.content.split("---\n")[1]).dotbabel.compute)).toEqual([{mode:"inherit",binding:"session"},{mode:"inherit",binding:"consumer"}]);expect(result.report.artifacts[2].state).toBe("neutral");
});
it("filters exact approved categories and never treats an alias proposal as approval",()=>{
 const a=artifact();expect(planMigration({artifacts:[a],decisions:[decision()],batch:"E"}).changes).toEqual([]);
 const result=planMigration({artifacts:[a]});expect(result.changes).toEqual([]);expect(result.report.unresolved).toEqual([a.sourcePath]);
 expect(planMigration({artifacts:[a],decisions:[decision({category:"F",compute:undefined})],batch:"F"}).report.unresolved).toEqual([a.sourcePath]);
});
it("leaves a compliant canonical artifact unchanged without a new decision",()=>{
 const a=artifact(undefined,undefined,content("opus",{dotbabel:{compute}}));const result=planMigration({artifacts:[a]});expect(result.changes).toEqual([]);expect(result.report.artifacts[0].state).toBe("canonical");expect(result.report.unresolved).toEqual([]);
 expect(()=>planMigration({artifacts:[a],decisions:[decision({compute:{...compute,mode:"dynamic"}})]})).toThrow("migration_decision_conflict");
});
it("keeps analysis and check free of writes and exposes contention",async()=>{
 const root=rootFixture(),p="agents/fixture.md",bytes=content();fs.writeFileSync(path.join(root,p),bytes);
 for(const mode of ["analysis","check"]){const report=await migrateArtifacts({root,paths:[p],decisions:[decision()],mode});expect(report.compliant).toBe(false);expect(report.written).toEqual([]);expect(fs.readFileSync(path.join(root,p),"utf8")).toBe(bytes);expect(fs.existsSync(path.join(root,".dotbabel-projection.lock"))).toBe(false);}
 const lock=acquireLock(path.join(root,".dotbabel-projection.lock"),{resource:"test"});try{for(const mode of ["analysis","check","write"])await expect(migrateArtifacts({root,paths:[p],mode})).rejects.toThrow("migration_locked");}finally{lock.release();}
 for(const options of [{mode:"invalid",paths:[p]},{paths:null},{paths:Array(1025).fill(p)}])await expect(migrateArtifacts({root,...options})).rejects.toThrow("migration_input_invalid");
});
it("retains completed compatibility-safe files when a later file changes and resumes after explicit correction",async()=>{
 const root=rootFixture(),a="agents/fixture.md",b="agents/second.md";for(const p of[a,b])fs.writeFileSync(path.join(root,p),content());const decisions=[decision(),decision({sourcePath:b})];
 await expect(migrateArtifacts({root,paths:[a,b],decisions,mode:"write",beforeWrite:p=>{if(p===b)fs.writeFileSync(path.join(root,b),"User edit\n");}})).rejects.toThrow("projection_output_drift");
 expect(fs.readFileSync(path.join(root,a),"utf8")).toContain("model: opus");expect(fs.readFileSync(path.join(root,a),"utf8")).toContain("dotbabel:");expect(fs.readFileSync(path.join(root,b),"utf8")).toBe("User edit\n");
 fs.writeFileSync(path.join(root,b),content());const result=await migrateArtifacts({root,paths:[a,b],decisions,mode:"write"});expect(result.written).toEqual([b]);
});
it("preserves bounded YAML aliases without expanding or recursively copying their graph",()=>{
 const bytes="---\nname: fixture\nmodel: opus\nmetadata: &shared\n  self: *shared\n---\nBody\n";
 const result=planMigration({artifacts:[artifact(undefined,undefined,bytes)],decisions:[decision()]});
 const header=yaml.load(result.changes[0].content.split("---\n")[1]);expect(header.metadata.self).toBe(header.metadata);expect(result.changes[0].content.length).toBeLessThan(1000);expect(header.dotbabel.compute).toEqual(compute);
});
