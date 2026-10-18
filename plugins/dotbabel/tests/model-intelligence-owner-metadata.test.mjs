import{it,expect}from"vitest";
import{readFileSync}from"node:fs";
import Ajv from"ajv/dist/2020.js";
import{buildClaudeBaseline}from"../src/model-intelligence/materialize/runtime/claude-build.mjs";
import{readSnapshot}from"../src/model-intelligence/snapshot/index.mjs";
import{parseProjectionSource}from"../src/model-intelligence/materialize/render.mjs";
const schema=name=>JSON.parse(readFileSync(new URL(`../../../schemas/${name}.schema.json`,import.meta.url),"utf8"));
it("F8: retains both public invocation values and explicitly deprecates their inert metadata",()=>{
 const field=schema("agent").properties.invocation;const validate=new Ajv().compile(field);
 for(const value of["passive","explicit"])expect(validate(value)).toBe(true);
 for(const value of["auto",true,1,null])expect(validate(value)).toBe(false);
 expect(field.deprecated).toBe(true);expect(field.description).toContain("no execution effect");
});
it("F9: validates skill headless_safe as the existing command boolean metadata",()=>{
 const field=schema("skill").properties.headless_safe;expect(field).toBeDefined();expect(field.type).toBe(schema("command").properties.headless_safe.type);
 const validate=new Ajv().compile(field);for(const value of[true,false])expect(validate(value)).toBe(true);for(const value of["true","false",0,1,null,{}])expect(validate(value)).toBe(false);
});
it("F8/F9: metadata does not change native invocation, tools, permissions or projection",()=>{
 for(const kind of["agent","skill"]){const sourcePath=kind==="agent"?"agents/fixture.md":"skills/fixture/SKILL.md";
 const sourceContent=`---\nname: fixture\ndescription: fixture\ntools: Read\nallowed-tools: Read\npermissionMode: default\n---\nRead only.\n`;
 const project=content=>{const output=buildClaudeBaseline({toolVersion:"4.2.0",snapshot:readSnapshot(),artifacts:[{sourcePath,sourceContent:content,target:{path:sourcePath,artifactKind:kind}}]}).files[0];return parseProjectionSource({sourcePath,sourceContent:output.content});};
 expect(project(sourceContent.replace("name: fixture","invocation: explicit\nheadless_safe: true\nname: fixture"))).toEqual(project(sourceContent));}
});
it("F9: reports invalid skill metadata through the existing public artifact validator",async()=>{
 const {validateArtifacts,parseFrontmatter}=await import("../src/build-index.mjs");
 const metadata=parseFrontmatter(readFileSync(new URL("../../../skills/review-prs/SKILL.md",import.meta.url),"utf8")).frontmatter;
 const artifact=value=>({type:"skill",path:"skills/fixture/SKILL.md",warnings:[],frontmatter:{...metadata,headless_safe:value}});
 expect(validateArtifacts([artifact(true),artifact(false)]).warnings).toEqual([]);
 expect(validateArtifacts([artifact("true")]).warnings).toContain("skills/fixture/SKILL.md: schema skill /headless_safe must be boolean (type)");
});
