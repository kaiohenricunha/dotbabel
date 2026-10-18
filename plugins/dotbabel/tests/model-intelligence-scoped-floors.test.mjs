import { describe, expect, it } from "vitest";
import { mergePolicy, SHIPPED_POLICY } from "../src/model-intelligence/policy/index.mjs";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { input, requirement } from "./fixtures/model-intelligence/resolver.mjs";

const scope = { artifact_kind: "agent", source_path: "agents/security-auditor.md" };
const floor = (value, selector = scope) => ({ mode: "floor", requirement: value, scope: selector });
const target = { runtimeId: "codex", artifactKind: "agent", sourcePath: scope.source_path };
const policy = extra => mergePolicy({ shipped: { ...SHIPPED_POLICY, scoped_floors: [floor("frontier")] }, ...extra });
const run = (extra = {}) => resolve(input({ requirement: requirement("routine"), policy: policy(), target, ...extra }));

describe("exact artifact-scoped safety floors", () => {
  it("applies a shipped floor only to its exact canonical artifact and kind", () => {
    expect(run().configuration.axes.model).toBe("frontier-model");
    expect(run({ target: { ...target, sourcePath: "agents/backend-developer.md" } }).configuration.axes.model).toBe("routine-model");
    expect(run({ target: { ...target, artifactKind: "skill" } }).configuration.axes.model).toBe("routine-model");
    expect(run({ target: { runtimeId: "codex", artifactKind: "agent" } }).configuration.axes.model).toBe("routine-model");
  });
  it("retains stronger scoped minima across all policy layers", () => {
    const p = policy({ user: { scoped_floors: [floor("exceptional")] }, project: { scoped_floors: [floor("mechanical")] }, artifact: { scoped_floors: [floor("deep")] } });
    expect(run({ policy: p }).configuration.axes.model).toBe("exceptional-model");
    expect(run({ policy: p }).explanation.some(item => item.code === "scoped_floor_applied")).toBe(true);
  });
  it("never allows an invocation pin or inheritance to remove an applicable safety floor", () => {
    const pinned = run({ invocation: { pin: { runtime: "codex", config: { model: "deep-model" } } } });
    expect(pinned.status).toBe("conflict"); expect(pinned.enforcement.state).toBe("unsatisfied");
    expect(run({ requirement: { mode: "inherit", binding: "self" } }).configuration.axes.model).toBe("frontier-model");
  });
  it("rejects malformed or ambiguous selectors without ignoring a declared floor", () => {
    for (const scoped_floors of [null, {}, [floor("unknown")], [floor("frontier", { ...scope, source_path: "../escape.md" })], [floor("frontier", { ...scope, source_path: "/absolute.md" })], [floor("frontier", { ...scope, source_path: "agents\\security-auditor.md" })], [floor("frontier", { ...scope, artifact_kind: "unknown" })], [{ ...floor("frontier"), extra: true }]]) {
      expect(() => mergePolicy({ shipped: SHIPPED_POLICY, project: { scoped_floors } })).toThrow();
    }
  });
  it("does not mutate caller policy or selector data", () => {
    const p = policy(); const before = structuredClone(p); const request = input({ policy: p, target, requirement: requirement("routine") });
    expect(resolve(request)).toEqual(resolve(request)); expect(p).toEqual(before);
  });
});

it("ships security minima as exact scopes rather than a global minimum", () => {
  expect(SHIPPED_POLICY).not.toHaveProperty("floor");
  expect(SHIPPED_POLICY.scoped_floors).toEqual(expect.arrayContaining([
    expect.objectContaining({ mode: "floor", requirement: "frontier", scope: { artifact_kind: "agent", source_path: "agents/security-auditor.md" } }),
    expect.objectContaining({ mode: "floor", requirement: "frontier", scope: { artifact_kind: "agent", source_path: "agents/security-engineer.md" } }),
    expect.objectContaining({ mode: "floor", requirement: "frontier", scope: { artifact_kind: "skill", source_path: "skills/security-review/SKILL.md" } }),
  ]));
});
it("applies shipped scopes through the real release adapter while preserving ordinary agents", async () => {
  const { readSnapshot } = await import("../src/model-intelligence/snapshot/index.mjs");
  const { createSnapshot } = await import("../src/model-intelligence/snapshot/core.mjs");
  const { buildClaudeBaseline } = await import("../src/model-intelligence/materialize/runtime/claude-build.mjs");
  const seed = structuredClone(readSnapshot());
  for (const model of seed.runtimes.claude.models) model.fields.supportedReasoningLevels[0].value = model.fields.supportedReasoningLevels[0].value.slice(0, 2);
  const snapshot = createSnapshot(seed);
  const artifact = name => ({ sourcePath: `agents/${name}.md`, sourceContent: "---\nname: fixture\nmodel: opus\n---\nBody\n", target: { path: `agents/${name}.md`, artifactKind: "agent" } });
  expect(() => buildClaudeBaseline({ toolVersion: "4.2.0", snapshot, artifacts: [artifact("security-auditor")] })).toThrow();
  expect(buildClaudeBaseline({ toolVersion: "4.2.0", snapshot, artifacts: [artifact("ordinary-fixture")] }).files).toHaveLength(1);
});

it("keeps schema and runtime validation aligned for scoped-floor input boundaries", async () => {
  const { default: Ajv } = await import("ajv");
  const { readFileSync } = await import("node:fs");
  const schema = JSON.parse(readFileSync(new URL("../../../schemas/dotbabel.config.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv({ strict: true }).compile(schema.properties.model_intelligence.properties.scoped_floors);
  expect(validate([floor("frontier")])).toBe(true);
  for (const candidate of [null, {}, [floor("frontier", { ...scope, source_path: "agents//security-auditor.md" })], [floor("frontier", { ...scope, source_path: "agents/./security-auditor.md" })], [floor("frontier", { ...scope, source_path: "agents/../security-auditor.md" })], [floor("frontier", { ...scope, source_path: "bad\nname.md" })], [{ ...floor("frontier"), rationale: " " }], [{ ...floor("frontier"), rationale: "x".repeat(1001) }]]) {
    expect(validate(candidate)).toBe(false);
    expect(() => mergePolicy({ shipped: SHIPPED_POLICY, project: { scoped_floors: candidate } })).toThrow();
  }
});
it("rejects inherited selector and declaration fields in pure policy callers",()=>{
 const inheritedScope=Object.assign(Object.create(scope),{unrelated:true,other:true});
 const inheritedEntry=Object.create(floor("frontier"));
 for(const value of [[floor("frontier",inheritedScope)],[inheritedEntry]]) expect(()=>mergePolicy({shipped:SHIPPED_POLICY,project:{scoped_floors:value}})).toThrow("invalid scoped policy floor");
});
it("emits the native axes needed to enforce an applicable scoped floor on a dynamic release artifact",async()=>{
 const {readSnapshot}=await import("../src/model-intelligence/snapshot/index.mjs");const {buildClaudeBaseline}=await import("../src/model-intelligence/materialize/runtime/claude-build.mjs");
 const content="---\nname: security-auditor\ndotbabel:\n  compute:\n    mode: dynamic\n    requirement: routine\n    binding: self\n---\nBody\n";
 const result=buildClaudeBaseline({toolVersion:"4.2.0",snapshot:readSnapshot(),artifacts:[{sourcePath:scope.source_path,sourceContent:content,target:{path:scope.source_path,artifactKind:"agent"}}]});
 expect(result.files[0].content).toMatch(/^model: /m);expect(result.files[0].content).toMatch(/^effort: /m);
});
it("keeps scoped floors monotonic across every workload class and layer ordering",()=>{
 const classes=["mechanical","routine","deep","frontier","exceptional"];
 for(const first of classes)for(const second of classes){
  for(const values of [[first,second],[second,first]]){
   const p=policy({user:{scoped_floors:[floor(values[0])]},project:{scoped_floors:[floor(values[1])]}});
   // The shipped security minimum stays Frontier even when all later requests are weaker.
   const effective=classes.indexOf(first)>3||classes.indexOf(second)>3?"exceptional-model":"frontier-model";
   expect(run({policy:p,requirement:requirement("mechanical")} ).configuration.axes.model).toBe(effective);
  }
 }
});
it("validates bounded exact selectors and rationale without accepting unknown keys",async()=>{
 const {normalizeScopedFloors,isArtifactSourcePath}=await import("../src/model-intelligence/policy/scopes.mjs");
 expect(normalizeScopedFloors(undefined)).toEqual([]);expect(normalizeScopedFloors(Array(128).fill(floor("deep")))).toHaveLength(128);
 for(const item of [null,[],{},Object.create({mode:"floor"}),{...floor("deep"),mode:"dynamic"},{...floor("deep"),rationale:""},{...floor("deep"),rationale:5},{...floor("deep"),rationale:"x".repeat(1001)},floor("deep",{...scope,extra:true})])expect(()=>normalizeScopedFloors([item])).toThrow("invalid scoped policy floor");
 expect(()=>normalizeScopedFloors(Array(129).fill(floor("deep")))).toThrow();
 for(const source of [null,5,"","/absolute","drive:C","bad\\path","x//y","x/./y","x/../y","a\u202eb","a\u0000b","x".repeat(4097)])expect(isArtifactSourcePath(source)).toBe(false);
 expect(isArtifactSourcePath("x".repeat(4096))).toBe(true);
 const value={...floor("deep",{...scope}),rationale:"x".repeat(1000)};const copied=normalizeScopedFloors([value]);value.scope.source_path="agents/changed.md";expect(copied[0].scope.source_path).toBe(scope.source_path);
});
it("rejects glob-looking scope selectors in both schema and runtime validation",async()=>{
 const {default:Ajv}=await import("ajv");const {readFileSync}=await import("node:fs");const schema=JSON.parse(readFileSync(new URL("../../../schemas/dotbabel.config.schema.json",import.meta.url),"utf8"));const validate=new Ajv({strict:true}).compile(schema.properties.model_intelligence.properties.scoped_floors);
 for(const source_path of ["agents/*.md","agents/?.md","agents/[ab].md","agents/{a,b}.md"]){const value=[floor("frontier",{...scope,source_path})];expect(validate(value)).toBe(false);expect(()=>mergePolicy({shipped:SHIPPED_POLICY,project:{scoped_floors:value}})).toThrow("invalid scoped policy floor");}
});
it("resolves the combined maximum of four valid scoped-floor layers without losing any minimum", () => {
 const entries=(prefix,level)=>Array.from({length:128},(_,i)=>floor(level,{artifact_kind:"agent",source_path:`agents/${prefix}-${i}.md`}));
 const merged=mergePolicy({shipped:{...SHIPPED_POLICY,scoped_floors:entries("shipped","routine")},user:{scoped_floors:entries("user","deep")},project:{scoped_floors:entries("project","frontier")},artifact:{scoped_floors:entries("artifact","exceptional")}});
 expect(merged.scoped_floors).toHaveLength(512);
 for(const [prefix,expected]of[["shipped","routine-model"],["user","deep-model"],["project","frontier-model"],["artifact","exceptional-model"]]) {
  const result=run({policy:merged,requirement:requirement("mechanical"),target:{...target,sourcePath:`agents/${prefix}-127.md`}});
  expect(result.status).toBe("resolved");expect(result.configuration.axes.model).toBe(expected);
 }
 const ordinary=mergePolicy({shipped:SHIPPED_POLICY,project:{scoped_floors:entries("project","frontier")}});
 expect(run({policy:ordinary}).configuration.axes.model).toBe("frontier-model");
 expect(run({policy:{...merged,scoped_floors:[...merged.scoped_floors,floor("frontier")]}}).status).toBe("invalid");
});
it("rejects low-confidence release evidence for an effective scoped floor on a dynamic artifact",async()=>{
 const {readSnapshot}=await import("../src/model-intelligence/snapshot/index.mjs"); const {createSnapshot}=await import("../src/model-intelligence/snapshot/core.mjs"); const {buildClaudeBaseline}=await import("../src/model-intelligence/materialize/runtime/claude-build.mjs");
 const seed=structuredClone(readSnapshot());
 for(const item of seed.runtimes.claude.models)for(const entries of Object.values(item.fields))for(const entry of entries)entry.confidence="low";
 const snapshot=createSnapshot(seed);
 const sourceContent="---\nname: security-auditor\ndotbabel:\n  compute:\n    mode: dynamic\n    requirement: routine\n    binding: self\n---\nBody\n";
 expect(()=>buildClaudeBaseline({toolVersion:"4.2.0",snapshot,artifacts:[{sourcePath:scope.source_path,sourceContent,target:{path:scope.source_path,artifactKind:"agent"}}]})).toThrow("release_requirement_unsatisfied");
});
