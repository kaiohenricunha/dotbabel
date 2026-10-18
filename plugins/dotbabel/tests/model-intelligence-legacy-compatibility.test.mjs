import{expect,it}from"vitest";
import{legacySatisfiesDeclaration,compatibleMigrationPaths}from"../src/model-intelligence/compat/compatibility.mjs";
import{detectDualDeclarationConflict,interpretLegacy}from"../src/model-intelligence/compat/index.mjs";
import{claudeProjectionFixture}from"./fixtures/model-intelligence/claude-projection.mjs";
const sourcePath="agents/fixture.md";
const context=()=>({...claudeProjectionFixture().context,sourcePath,artifactKind:"agent"});
const declared={requirement:"deep",mode:"floor",binding:"self"};
const reading={legacy:{model:"frontier-model"}};
it("proves a retained exact selector using only shared resolver evidence and preserves every input",()=>{
 const c=context(),before=structuredClone(c);expect(legacySatisfiesDeclaration(declared,reading,c)).toBe(true);expect(c).toEqual(before);expect(reading.legacy.model).toBe("frontier-model");
});
it("does not treat a native alias spelling or explicit boolean-shaped data as capability proof",()=>{
 for(const c of [undefined,null,{},{...context(),catalog:{runtimes:[]}}])expect(legacySatisfiesDeclaration(declared,reading,c)).toBe(false);
 for(const model of ["unknown-model","inherit",undefined,null])expect(legacySatisfiesDeclaration(declared,{legacy:{model}},context())).toBe(false);
 const coarse=interpretLegacy({model:"opus"},{sourcePath,artifactKind:"agent"});expect(detectDualDeclarationConflict(declared,coarse)).not.toBeNull();expect(detectDualDeclarationConflict(declared,coarse,{})).not.toBeNull();expect(detectDualDeclarationConflict(declared,coarse,"true")).not.toBeNull();
});
it("retains strict floors and cannot silently replace an explicit canonical native pin",()=>{
 const c=context();c.policy.floor={mode:"floor",requirement:"exceptional"};expect(legacySatisfiesDeclaration(declared,{legacy:{model:"routine-model"}},c)).toBe(false);
 const pin={...declared,mode:"pin",rationale:"Exact native intent.",pin:{runtime:"claude",config:{model:"deep-model"}}};expect(legacySatisfiesDeclaration(pin,reading,context())).toBe(false);
 expect(legacySatisfiesDeclaration({...pin,pin:{runtime:"codex",config:{model:"frontier-model"}}},reading,context())).toBe(false);
 expect(legacySatisfiesDeclaration({...pin,pin:{runtime:"claude",config:{model:"frontier-model",contextTier:"unknown"}}},reading,context())).toBe(false);
 expect(legacySatisfiesDeclaration({...pin,pin:{runtime:"claude",config:{model:"frontier-model"}}},reading,context())).toBe(true);
});
it("checks exact effort support for an agent without binding inert skill effort",()=>{
 expect(legacySatisfiesDeclaration(declared,{legacy:{model:"frontier-model",effort:"unsupported"}},context())).toBe(false);
 expect(legacySatisfiesDeclaration({...declared,binding:"consumer"},{legacy:{model:"frontier-model",effort:"unsupported"}},{...context(),artifactKind:"skill"})).toBe(true);
 expect(legacySatisfiesDeclaration({...declared,binding:"session"},reading,{...context(),artifactKind:"command"})).toBe(true);
});
it("does not manufacture proof for invalid or undeclared intent in a migration inventory",()=>{
 const inputs=[{sourcePath,artifactKind:"agent",frontmatter:{model:"opus"}},{sourcePath:"agents/invalid.md",artifactKind:"agent",frontmatter:{model:"opus",dotbabel:{compute:"invalid"}}}];expect([...compatibleMigrationPaths(inputs,context())]).toEqual([]);
});
it("requires a valid canonical source identity before proving exact artifact floors",()=>{
 for(const sourcePath of [undefined,"../escape.md","/absolute.md","agents\\fixture.md"])expect(legacySatisfiesDeclaration(declared,reading,{...context(),sourcePath})).toBe(false);
});
it("never lets a class match or a caller proof discard conflicting exact native pins",()=>{
 const coarse=interpretLegacy({model:"haiku"},{sourcePath,artifactKind:"agent"});const pin={requirement:"mechanical",mode:"pin",binding:"self",rationale:"Exact native intent.",pin:{runtime:"claude",config:{model:"sonnet"}}};
 expect(detectDualDeclarationConflict(pin,coarse)).not.toBeNull();expect(detectDualDeclarationConflict(pin,coarse,true)).not.toBeNull();
});
it("checks known agent effort pins independently from the matching model and workload class",()=>{
 const legacy=interpretLegacy({model:"opus",effort:"medium"},{sourcePath,artifactKind:"agent"});const pin={requirement:"frontier",mode:"pin",binding:"self",rationale:"Exact native axes.",pin:{runtime:"claude",config:{model:"opus",reasoning:"max"}}};
 expect(detectDualDeclarationConflict(pin,legacy,true)).not.toBeNull();expect(detectDualDeclarationConflict({...pin,pin:{runtime:"claude",config:{model:"opus",reasoning:"medium"}}},legacy)).toBeNull();
});
