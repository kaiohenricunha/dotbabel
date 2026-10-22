import { mergePolicy, SHIPPED_POLICY } from "../../../src/model-intelligence/policy/index.mjs";
export const provenance = { sourceId: "codex", sourceKind: "runtime", adapterVersion: "fixture-1" };
export const evidence = (value, changes = {}) => ({ value, provenance, freshness: "fresh", confidence: "high", availability: "available", refresh: "idle", ...changes });
export const requirement = (level = "deep", mode = "dynamic", extra = {}) => ({ requirement: level, binding: "self", mode, provenance: { sourceId: "fixture.md", sourceKind: "artifact" }, ...extra });
export function model(id, level = "deep", changes = {}) {
  const efforts = level === "routine" ? [] : level === "deep" ? ["calm", "focused"] : level === "frontier" ? ["calm", "focused", "thorough"] : ["calm", "focused", "thorough", "exhaustive"];
  return { model: id, fields: { id: [evidence(id)], selectionVisibility: [evidence("listed")], capabilities: [evidence({ reasoning: level !== "routine", tool_call: true, ...(level === "frontier" ? { class_support: ["frontier"] } : level === "exceptional" ? { class_support: ["frontier", "exceptional"] } : {}) })], supportedReasoningLevels: [evidence(efforts.map(effort => ({ effort })))], ...(efforts.length ? { defaultReasoningLevel: [evidence("focused")] } : {}) }, ...changes };
}
export function input(changes = {}) {
  return { requirement: requirement(), policy: mergePolicy({ shipped: SHIPPED_POLICY }), target: { runtimeId: "codex", artifactKind: "agent" }, catalog: { sources: [], models: [], runtimes: [{ runtimeId: "codex", models: [model("routine-model", "routine"), model("deep-model", "deep"), model("frontier-model", "frontier"), model("exceptional-model", "exceptional")] }] }, runtimeContract: { binding: { agent: { support: "supported", axes: { model: "supported", reasoning: "supported" } }, skill: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } } }, invocation: { support: "supported", axes: { model: "supported", reasoning: "supported" } } }, ...changes };
}
