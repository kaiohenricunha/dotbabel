import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { migrateArtifacts } from "../src/model-intelligence/compat/migrate.mjs";
const roots=[];
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
const fixture=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"mi-migrate-"));roots.push(root);fs.mkdirSync(path.join(root,"agents"));return root;};
const put=(root,name,header)=>{const sourcePath=`agents/${name}.md`;fs.writeFileSync(path.join(root,sourcePath),`---\nname: ${name}\n${header}---\nExact body.\n`);return sourcePath;};
const decision=(sourcePath,compute={requirement:"frontier",mode:"floor",binding:"self"})=>({sourcePath,artifactKind:"agent",category:"C",compute});
const read=(root,p)=>fs.readFileSync(path.join(root,p),"utf8");
it("--write rewrites only unambiguous artifacts and leaves class-F artifacts untouched",async()=>{
 const root=fixture(),a=put(root,"approved","model: opus\n"),b=put(root,"undecided","model: sonnet\n");const before=read(root,b);
 const result=await migrateArtifacts({root,paths:[a,b],decisions:[decision(a),{...decision(b),category:"F"}],mode:"write"});
 expect(read(root,a)).toContain("dotbabel:");expect(read(root,a)).toContain("Exact body.\n");expect(read(root,b)).toBe(before);expect(result.written).toEqual([a]);expect(result.unresolved).toEqual([b]);
});
it("--write keeps the legacy model on a floor artifact as a synchronized projection until KD-2 projection exists",async()=>{
 const root=fixture(),a=put(root,"approved","model: opus\n");await migrateArtifacts({root,paths:[a],decisions:[decision(a)],mode:"write"});
 const header=yaml.load(read(root,a).split("---\n")[1]);expect(header.model).toBe("opus");expect(header.dotbabel.compute.mode).toBe("floor");
});
it("--write never converts an omitted model or inherit into a concrete requirement",async()=>{
 const root=fixture(),a=put(root,"absent",""),b=put(root,"inherited","model: inherit\n");const before=read(root,a);
 await migrateArtifacts({root,paths:[a,b],mode:"write"});expect(read(root,a)).toBe(before);const header=yaml.load(read(root,b).split("---\n")[1]);expect(header.dotbabel.compute).toEqual({mode:"inherit",binding:"self"});expect(header.model).toBe("inherit");
});
it("--check exits 1 when policy requires a migration that has not happened and 0 when the tree is compliant",async()=>{
 const root=fixture(),a=put(root,"approved","model: opus\n"),options={root,paths:[a],decisions:[decision(a)]};const before=read(root,a);
 expect((await migrateArtifacts({...options,mode:"check"})).compliant).toBe(false);expect(read(root,a)).toBe(before);
 await migrateArtifacts({...options,mode:"write"});expect((await migrateArtifacts({...options,mode:"check"})).compliant).toBe(true);
});
it("--check and --write together exit 64",()=>{
 const result=spawnSync(process.execPath,["plugins/dotbabel/bin/dotbabel-models.mjs","migrate","--check","--write"],{encoding:"utf8"});expect(result.status).toBe(64);expect(result.stderr).toContain("cannot be combined");
});
it("rejects malformed decisions and conflicting declarations before writing any artifact",async()=>{
 const root=fixture(),a=put(root,"a","model: opus\n"),b=put(root,"b","model: sonnet\n"),before=read(root,a);
 await expect(migrateArtifacts({root,paths:[a,b],decisions:[decision(a),decision(b)],mode:"write"})).rejects.toThrow("migration_decision_conflict");expect(read(root,a)).toBe(before);
 await expect(migrateArtifacts({root,paths:[a],decisions:[decision("../escape.md")],mode:"write"})).rejects.toThrow("migration_decision_invalid");
});
it("refuses symlinked artifacts and malformed YAML without replacing unrelated files",async()=>{
 const root=fixture(),a=put(root,"a","model: opus\n"),b="agents/link.md";fs.symlinkSync(path.join(root,a),path.join(root,b));const before=read(root,a);
 await expect(migrateArtifacts({root,paths:[a,b],decisions:[decision(a)],mode:"write"})).rejects.toThrow();expect(read(root,a)).toBe(before);
 fs.unlinkSync(path.join(root,b));fs.writeFileSync(path.join(root,b),"---\nmodel: [\n---\nBody\n");await expect(migrateArtifacts({root,paths:[a,b],mode:"write"})).rejects.toThrow("migration_source_invalid");
});
it("preserves user edits made after planning rather than overwriting a displaced value",async()=>{
 const root=fixture(),a=put(root,"a","model: opus\n");await expect(migrateArtifacts({root,paths:[a],decisions:[decision(a)],mode:"write",beforeWrite:()=>fs.writeFileSync(path.join(root,a),"User edit\n")})).rejects.toThrow("projection_output_drift");expect(read(root,a)).toBe("User edit\n");
});
it("runs public check/write with a reviewed decision file and correct exit codes",()=>{
 const root=fixture(),a=put(root,"approved","model: opus\n"),file=path.join(root,"decisions.json");fs.writeFileSync(file,JSON.stringify([decision(a)]));
 const cli=mode=>spawnSync(process.execPath,["plugins/dotbabel/bin/dotbabel-models.mjs","migrate",mode,"--decisions",file,"--repo-root",root,"--json"],{encoding:"utf8"});
 let result=cli("--check");expect(result.status).toBe(1);expect(JSON.parse(result.stdout).pending).toEqual([a]);
 result=cli("--write");expect(result.status).toBe(0);expect(JSON.parse(result.stdout).written).toEqual([a]);
 result=cli("--check");expect(result.status).toBe(0);expect(JSON.parse(result.stdout).compliant).toBe(true);
});
it("keeps the working native compatibility selector in the generated release copy after a floor migration",async()=>{
 const {buildClaudeBaseline}=await import("../src/model-intelligence/materialize/runtime/claude-build.mjs");const {readSnapshot}=await import("../src/model-intelligence/snapshot/index.mjs");
 const result=buildClaudeBaseline({toolVersion:"4.2.0",snapshot:readSnapshot(),artifacts:[{sourcePath:"agents/fixture.md",sourceContent:"---\nname: fixture\nmodel: haiku\ndotbabel:\n  compute:\n    mode: floor\n    requirement: mechanical\n    binding: self\n---\nBody\n",target:{path:"agents/fixture.md",artifactKind:"agent"}}]});
 const header=yaml.load(result.files[0].content.split("---\n")[1]);expect(header.model).toBe("haiku");expect(header).not.toHaveProperty("effort");
});
it("recognizes equivalent canonical declarations regardless of JSON key order",async()=>{
 const root=fixture(),a=put(root,"approved","model: opus\ndotbabel:\n  compute:\n    binding: self\n    mode: floor\n    requirement: frontier\n");
 expect((await migrateArtifacts({root,paths:[a],decisions:[decision(a)],mode:"check"})).compliant).toBe(true);
});
it("preserves an explicit native pin against a different retained compatibility selector",async()=>{
 const {buildClaudeBaseline}=await import("../src/model-intelligence/materialize/runtime/claude-build.mjs");const {readSnapshot}=await import("../src/model-intelligence/snapshot/index.mjs");
 const compute={requirement:"mechanical",mode:"pin",binding:"self",rationale:"An explicit native model choice.",pin:{runtime:"claude",config:{model:"sonnet"}}};
 const sourceContent="---\n"+yaml.dump({name:"fixture",model:"haiku",dotbabel:{compute}})+"---\nBody\n";
 expect(()=>buildClaudeBaseline({toolVersion:"4.2.0",snapshot:readSnapshot(),artifacts:[{sourcePath:"agents/fixture.md",sourceContent,target:{path:"agents/fixture.md",artifactKind:"agent"}}]})).toThrow("claude_baseline_legacy_pin_conflict");
});
