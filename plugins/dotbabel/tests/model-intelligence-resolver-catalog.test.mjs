import { describe, it, expect } from "vitest";
import { makeModelFact, makeDiscoveryEvidence } from "../src/model-intelligence/sources/evidence.mjs";
import { makeAdapterResult } from "../src/model-intelligence/sources/contract.mjs";
import { buildCatalog } from "../src/model-intelligence/catalog/index.mjs";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { parseDebugModels } from "../src/model-intelligence/sources/runtime/codex.mjs";
import { input, provenance, model, evidence } from "./fixtures/model-intelligence/resolver.mjs";

describe("resolver catalog boundary", () => {
  it("carries explicit capability facts through real source validation and catalog normalization", () => {
    const model = makeModelFact({ id: "opaque-runtime-model", selectionVisibility: "listed", capabilities: { reasoning: true, tool_call: true }, supportedReasoningLevels: [{ effort: "native-low" }, { effort: "native-high" }], defaultReasoningLevel: "native-low" });
    const result = makeAdapterResult({ status: "ok", provenance, observedAt: "2026-10-17T04:00:00.000Z", evidence: makeDiscoveryEvidence({ models: [model] }) });
    const catalog = buildCatalog([{ result, freshness: "fresh", refresh: "idle" }]);
    const r = resolve(input({ catalog }));
    expect(r.status).toBe("resolved"); expect(r.configuration.axes).toEqual({ model: "opaque-runtime-model", reasoning: "native-low" });
  });
  it("derives Codex capabilities only from reported native reasoning and recognized tool interfaces", () => {
    const result = parseDebugModels(JSON.stringify({ models: [
      { slug: "opaque-a", supported_reasoning_levels: [{ effort: "low" }], shell_type: "unified_exec" },
      { slug: "opaque-b", supported_reasoning_levels: [], shell_type: "future-unverified-tool" },
      { slug: "opaque-c", supported_reasoning_levels: [{ effort: "none" }] }
    ] }));
    expect(result.models[0].capabilities).toEqual({ reasoning: true, tool_call: true });
    expect(result.models[1].capabilities).toBeUndefined();
    expect(result.models[2].capabilities).toEqual({ reasoning: false });
  });
  it("never revives a model from stale availability when fresh local evidence denies it", () => {
    const record = model("denied-model");
    record.fields.id = [evidence("denied-model", { freshness: "stale" }), evidence("denied-model", { availability: "unavailable" })];
    const catalog = { sources: [], models: [], runtimes: [{ runtimeId: "codex", models: [record] }] };
    expect(resolve(input({ catalog })).status).not.toBe("resolved");
  });
  it("never treats unavailable capability facts or conflicting availability as proof", () => {
    for (const change of ["capability", "identity-conflict"]) {
      const record = model("uncertain-model");
      if (change === "capability") record.fields.capabilities[0].availability = "unavailable";
      else record.fields.id.push(evidence("uncertain-model", { availability: "unavailable" }));
      const catalog = { sources: [], models: [], runtimes: [{ runtimeId: "codex", models: [record] }] };
      expect(resolve(input({ catalog })).status, change).not.toBe("resolved");
    }
  });
  it("validates capability facts without inventing absent capability or parsing model names", () => {
    expect(makeModelFact({ id: "frontier-ultra-model", supportedReasoningLevels: [] }).capabilities).toBeUndefined();
    for (const capabilities of [null, [], { reasoning: "true" }, { tool_call: 1 }, { intelligence_score: 100 }]) {
      expect(() => makeModelFact({ id: "m", supportedReasoningLevels: [], capabilities })).toThrow(/capabilit/);
    }
  });
});
