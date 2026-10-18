import { describe, it, expect } from "vitest";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { makeModelFact } from "../src/model-intelligence/sources/evidence.mjs";
import { parseDebugModels } from "../src/model-intelligence/sources/runtime/codex.mjs";
import { input, model, evidence, requirement } from "./fixtures/model-intelligence/resolver.mjs";

function record(id, visibility = "listed", modalities = ["text"]) {
  const value = model(id);
  value.fields.selectionVisibility = [evidence(visibility)];
  value.fields.inputModalities = [evidence(modalities)];
  value.fields.supportedReasoningLevels = [evidence([
    { effort: "native-low", intent: "low", order: 1 },
    { effort: "native-medium", intent: "medium", order: 2 },
    { effort: "native-high", intent: "high", order: 3 }
  ])];
  value.fields.defaultReasoningLevel = [evidence("native-low")];
  return value;
}
function request(models, invocation = {}) {
  const value = input({ invocation }); value.catalog.runtimes[0].models = models; return value;
}

describe("shared resolver routing constraints", () => {
  it("never automatically selects a hidden model when a listed candidate satisfies the same demand", () => {
    const result = resolve(request([record("a-hidden", "hidden"), record("z-listed")]));
    expect(result.status).toBe("resolved");
    expect(result.configuration.axes.model).toBe("z-listed");
  });
  it("keeps an explicit hidden model pin without silently substituting a listed model", () => {
    const result = resolve(request([record("a-hidden", "hidden"), record("z-listed")], { modelSelection: "explicit", pin: { runtime: "codex", config: { model: "a-hidden" } } }));
    expect(result.status).toBe("resolved");
    expect(result.configuration.axes.model).toBe("a-hidden");
  });
  it("requires known ordinary selectability for automatic model choice", () => {
    const result = resolve(request([record("unknown", "unknown")]));
    expect(result.status).toBe("unresolved");
    expect(result.configuration).toBeUndefined();
  });
  it("selects only a model with verified support for every required input modality", () => {
    const result = resolve(request([record("a-text"), record("z-image", "listed", ["text", "image"])], { requiredModalities: ["text", "image"] }));
    expect(result.status).toBe("resolved");
    expect(result.configuration.axes.model).toBe("z-image");
  });
  it("never treats absent modality evidence as proof that an attachment is supported", () => {
    const candidate = record("missing-modalities"); delete candidate.fields.inputModalities;
    expect(resolve(request([candidate], { requiredModalities: ["image"] })).status).toBe("unresolved");
  });
  it("selects native effort from independent semantic intent using this model's evidence", () => {
    const result = resolve(request([record("opaque-model")], { effortIntent: "high" }));
    expect(result.status).toBe("resolved");
    expect(result.configuration.axes.reasoning).toBe("native-high");
  });
  it("preserves an explicit manual effort while allowing model capability selection", () => {
    const result = resolve(request([record("opaque-model")], { effortIntent: "high", overrides: { reasoning: "native-medium" } }));
    expect(result.status).toBe("resolved");
    expect(result.configuration.axes.reasoning).toBe("native-medium");
  });
  it("does not guess semantic meaning for an unannotated future effort value", () => {
    const candidate = record("opaque-model"); candidate.fields.supportedReasoningLevels = [evidence([{ effort: "future-effort" }])];
    candidate.fields.defaultReasoningLevel = [evidence("future-effort")];
    expect(resolve(request([candidate], { effortIntent: "high" })).status).toBe("unresolved");
  });
  it("composes manual model and effort axes with lower-scope pins independently", () => {
    const value = request([record("chosen"), record("other")], { overrides: { reasoning: "native-medium" }, effortIntent: "high" });
    value.policy = { ...value.policy, pin: { mode: "pin", runtime: "codex", config: { model: "chosen" } } };
    const result = resolve(value);
    expect(result.configuration.axes).toEqual({ model: "chosen", reasoning: "native-medium" });
    expect(result.explanation.map(x => x.code)).toContain("manual_selection_preserved");
    const pinned = resolve(request([record("a-model"), record("z-model")], { overrides: { model: "z-model" }, effortIntent: "high" }));
    expect(pinned.configuration.axes).toEqual({ model: "z-model", reasoning: "native-high" });
  });
  it("never reports a below-floor manual model as compliant", () => {
    const value = request([model("weak", "routine"), model("strong", "exceptional")], { overrides: { model: "weak" } });
    value.requirement = requirement("frontier", "floor");
    const result = resolve(value);
    expect(result).toMatchObject({ status: "conflict", enforcement: { state: "unsatisfied" } });
    expect(result.configuration).toBeUndefined();
  });
  it("never silently replaces an unavailable or incompatible manual control", () => {
    expect(resolve(request([record("available")], { overrides: { model: "missing" } })).diagnostics[0].code).toBe("pin_unavailable");
    expect(resolve(request([record("available")], { overrides: { reasoning: "unsupported" } })).diagnostics[0].code).toBe("unsupported_configuration_axis");
    const result = resolve(request([record("available")], { overrides: { apiKey: "private-override-marker" } }));
    expect(result.status).toBe("conflict");
    expect(JSON.stringify(result)).not.toContain("private-override-marker");
  });
  it("keeps unsupported semantic effort unresolved rather than guessing or lowering it", () => {
    const candidate = record("available"); candidate.fields.supportedReasoningLevels = [evidence([{ effort: "native-low", intent: "low", order: 1 }])];
    candidate.fields.defaultReasoningLevel = [evidence("native-low")];
    const result = resolve(request([candidate], { effortIntent: "high" }));
    expect(result.status).toBe("unresolved");
    expect(result.diagnostics[0].code).toBe("effort_intent_unavailable");
  });
  it("uses the least native effort that the adapter maps to the requested intent", () => {
    const candidate = record("available"); candidate.fields.supportedReasoningLevels[0].value.push({ effort: "native-extra", intent: "high", order: 4 });
    const result = resolve(request([candidate], { effortIntent: "high" }));
    expect(result.configuration.axes.reasoning).toBe("native-high");
  });
  it("does not use an irrelevant stale default as evidence for an explicitly selected effort", () => {
    const candidate = record("available"); candidate.fields.defaultReasoningLevel[0].freshness = "stale";
    const result = resolve(request([candidate], { effortIntent: "high" }));
    expect(result.confidence).toBe("high");
    expect(result.explanation.map(x => x.code)).not.toContain("stale_evidence_used");
    candidate.fields.selectionVisibility[0].freshness = "stale";
    const stale = resolve(request([candidate], { effortIntent: "high" }));
    expect(stale.confidence).toBe("medium");
    expect(stale.explanation.map(x => x.code)).toContain("stale_evidence_used");
  });
  it("does not turn contradictory visibility or modality evidence into permission", () => {
    const hidden = record("contradictory"); hidden.fields.selectionVisibility.push(evidence("hidden"));
    expect(resolve(request([hidden])).status).toBe("unresolved");
    const image = record("contradictory-image", "listed", ["text", "image"]); image.fields.inputModalities.push(evidence(["text"]));
    expect(resolve(request([image], { requiredModalities: ["image"] })).status).toBe("unresolved");
  });
  it("rejects malformed invocation constraints rather than silently ignoring them", () => {
    for (const invocation of [null, [], { unexpected: true }, { effortIntent: "maximum" }, { requiredModalities: "image" }, { requiredModalities: [null] }, { overrides: null }, { overrides: { model: "-bad-option" } }]) {
      expect(resolve(request([record("available")], invocation)).status).toBe("invalid");
    }
  });

  it("does not claim observed effort compliance from the model capability alone", () => {
    const value = request([record("available")], { effortIntent: "high" });
    value.requirement = requirement("deep", "dynamic", { binding: "consumer" });
    value.observed = { runtimeId: "codex", configurationBasis: "as-run", axes: { model: "available", reasoning: "native-low" } };
    expect(resolve(value).enforcement.state).toBe("unsatisfied");
    value.observed.axes.reasoning = "native-high";
    expect(resolve(value).enforcement.state).toBe("satisfied-not-enforced");
    delete value.observed.axes.reasoning;
    expect(resolve(value).enforcement.state).toBe("unknown");
  });
  it("does not call missing observed manual-axis evidence a known violation", () => {
    const value = request([record("available")], { overrides: { reasoning: "native-medium" } });
    value.requirement = requirement("deep", "dynamic", { binding: "consumer" });
    value.observed = { runtimeId: "codex", configurationBasis: "as-run", axes: { model: "available" } };
    expect(resolve(value).enforcement.state).toBe("unknown");
  });
  it("reports a known observed input mismatch while retaining unknown modality evidence", () => {
    const value = request([record("a-text"), record("z-image", "listed", ["text", "image"])], { requiredModalities: ["image"] });
    value.requirement = requirement("deep", "dynamic", { binding: "consumer" });
    value.observed = { runtimeId: "codex", configurationBasis: "as-run", axes: { model: "a-text" } };
    expect(resolve(value).enforcement.state).toBe("unsatisfied");
    delete value.catalog.runtimes[0].models[0].fields.inputModalities;
    expect(resolve(value).enforcement.state).toBe("unknown");
  });
  it("does not convert invocation overrides into a dynamic command's artifact binding", () => {
    const value = request([record("available")], { overrides: { model: "available" } });
    value.requirement = requirement("deep", "dynamic", { binding: "session" });
    value.target.artifactKind = "command";
    value.runtimeContract.binding.command = { support: "supported", axes: { model: "supported", reasoning: "supported" } };
    expect(resolve(value).enforcement.state).toBe("unknown");
    value.requirement = requirement("deep", "pin", { binding: "session", pin: { runtime: "codex", config: { model: "available" } } });
    expect(resolve(value).enforcement.state).toBe("enforced");
  });

  it("requires ordinary eligibility when an automatic retention probe constrains the current model", () => {
    const hidden = resolve(request([record("hidden", "hidden")], { overrides: { model: "hidden" }, modelSelection: "automatic" }));
    expect(hidden.status).toBe("unresolved");
    const listed = resolve(request([record("listed")], { overrides: { model: "listed" }, modelSelection: "automatic" }));
    expect(listed.status).toBe("resolved");
    expect(listed.configuration.axes.model).toBe("listed");
  });
  it("rejects ambiguous explicit-selection metadata without a specified model", () => {
    for (const modelSelection of ["explicit", "private-selection-marker", null]) {
      const result = resolve(request([record("listed")], { modelSelection }));
      expect(result.status).toBe("invalid");
      expect(JSON.stringify(result)).not.toContain("private-selection-marker");
    }
  });

  it("does not claim a concrete inherited configuration is enforced by the artifact", () => {
    const value = request([record("available")], { pin: { runtime: "codex", config: { model: "available" } } });
    value.requirement = { mode: "inherit", binding: "self" };
    expect(resolve(value).enforcement.state).toBe("unknown");
  });
  it("does not accept identity evidence from a different harness or a knowledge source", () => {
    for (const provenance of [{ sourceId: "claude", sourceKind: "runtime", adapterVersion: "fixture" }, { sourceId: "codex", sourceKind: "knowledge-source", adapterVersion: "fixture" }]) {
      const candidate = record("available"); candidate.fields.id[0].provenance = provenance;
      expect(resolve(request([candidate])).status).toBe("unresolved");
    }
  });

  it("keeps a mechanical coding route compatible with the harness's required tool capability", () => {
    const textOnly = record("a-text-only"); textOnly.fields.capabilities = [evidence({ reasoning: true, tool_call: false })];
    const toolModel = record("z-tool-model");
    const value = request([textOnly, toolModel], { requiredCapabilities: { tool_call: true } });
    value.requirement = requirement("mechanical");
    const result = resolve(value);
    expect(result.status).toBe("resolved");
    expect(result.configuration.axes.model).toBe("z-tool-model");
  });
  it("does not invent an operation capability or report an incompatible manual model as compliant", () => {
    const candidate = record("unknown-tools"); delete candidate.fields.capabilities;
    const value = request([candidate], { requiredCapabilities: { tool_call: true } });
    value.requirement = requirement("mechanical");
    expect(resolve(value).status).toBe("unresolved");
    candidate.fields.capabilities = [evidence({ tool_call: false })];
    value.invocation.overrides = { model: "unknown-tools" };
    const conflict = resolve(value);
    expect(conflict).toMatchObject({ status: "conflict", enforcement: { state: "unsatisfied" } });
  });

  it("validates operation constraints without accepting truthy strings or unbounded metadata", () => {
    const invalid = [null, [], { tool_call: "true" }, { ToolCall: true }, { ["a".repeat(65)]: true }, Object.fromEntries(Array.from({length: 33}, (_, i) => [`cap_${i}`, true]))];
    for (const requiredCapabilities of invalid) expect(resolve(request([record("available")], { requiredCapabilities })).status).toBe("invalid");
    for (const requiredModalities of [Array(33).fill("text"), ["-unsafe"], [""]]) expect(resolve(request([record("available")], { requiredModalities })).status).toBe("invalid");
    expect(resolve(request([record("available")], { requiredModalities: Array(32).fill("text"), requiredCapabilities: {} })).status).toBe("resolved");
    expect(resolve(request([record("available")], { overrides: {} })).status).toBe("resolved");
  });
  it("distinguishes observed operation incompatibility from missing capability evidence", () => {
    const compatible = record("z-compatible"), incompatible = record("a-incompatible");
    incompatible.fields.capabilities = [evidence({ reasoning: true, tool_call: false })];
    const value = request([compatible, incompatible], { requiredCapabilities: { tool_call: true } });
    value.requirement = requirement("mechanical", "dynamic", { binding: "consumer" });
    value.observed = { runtimeId: "codex", configurationBasis: "as-run", axes: { model: "a-incompatible" } };
    expect(resolve(value).enforcement).toEqual({ state: "unsatisfied", basis: "session-observation" });
    delete incompatible.fields.capabilities;
    expect(resolve(value).enforcement.state).toBe("unknown");
    value.observed.axes.model = "z-compatible";
    expect(resolve(value).enforcement.state).toBe("satisfied-not-enforced");
  });
  it("honors explicit false capability requirements rather than coercing unknown facts", () => {
    const disabled = record("z-no-tools"); disabled.fields.capabilities = [evidence({ tool_call: false })];
    const value = request([record("a-tools"), disabled], { requiredCapabilities: { tool_call: false } });
    value.requirement = requirement("mechanical");
    expect(resolve(value).configuration.axes.model).toBe("z-no-tools");
    delete disabled.fields.capabilities;
    expect(resolve(value).diagnostics[0].code).toBe("required_capability_unavailable");
  });
  it("makes effort ties stable in both input orders without preferring model-name meaning", () => {
    for (const efforts of [["z-effort", "a-effort"], ["a-effort", "z-effort"]]) {
      const candidate = record("available");
      candidate.fields.supportedReasoningLevels = [evidence(efforts.map(effort => ({ effort, intent: "high", order: 0 })))];
      expect(resolve(request([candidate], { effortIntent: "high" })).configuration.axes.reasoning).toBe("a-effort");
    }
  });
  it("does not accept malformed effort annotations even in a caller-supplied catalog", () => {
    for (const order of [-1, 101, 0.5, "1"]) {
      const candidate = record("available");
      candidate.fields.supportedReasoningLevels = [evidence([{ effort: "untrusted", intent: "high", order }])];
      expect(resolve(request([candidate], { effortIntent: "high" })).diagnostics[0].code).toBe("effort_intent_unavailable");
    }
    const candidate = record("available"); candidate.fields.supportedReasoningLevels = [evidence([{ effort: "boundary", intent: "high", order: 100 }])];
    expect(resolve(request([candidate], { effortIntent: "high" })).configuration.axes.reasoning).toBe("boundary");
  });
  it("requires verified reasoning invocation support before translating semantic effort", () => {
    for (const support of ["unsupported", "unverified", undefined]) {
      const value = request([record("available")], { effortIntent: "high" });
      value.runtimeContract.invocation.axes.reasoning = support;
      expect(resolve(value).diagnostics[0].code).toBe("effort_intent_unavailable");
    }
  });
  it("distinguishes no compatible runtime, inherited effort-only controls and invalid catalog input", () => {
    const empty = request([], { overrides: { model: "missing" } });
    expect(resolve(empty).diagnostics[0].code).toBe("pin_unavailable");
    const inherited = request([record("available")], { overrides: { reasoning: "native-high" } });
    inherited.requirement = { mode: "inherit", binding: "session" };
    expect(resolve(inherited).diagnostics[0].code).toBe("runtime_inheritance_preserved");
    const malformed = request([record("available")]); malformed.catalog.runtimes = [null];
    expect(resolve(malformed).diagnostics[0].code).toBe("invalid_resolver_input");
  });
  it("retains untouched lower-scope axes and diagnoses a fully shadowed pin", () => {
    const value = request([record("available")], { overrides: { model: "available" } });
    value.policy = { ...value.policy, pin: { runtime: "codex", config: { model: "available", reasoning: "native-medium" } }, shadowed: [{ layer: "user", key: "pin" }] };
    const retained = resolve(value);
    expect(retained.configuration.axes.reasoning).toBe("native-medium");
    expect(retained.explanation.map(x => x.code)).toContain("lower_scope_axes_preserved");
    expect(retained.explanation.map(x => x.code)).toContain("lower_scope_pin_shadowed");
    value.invocation.overrides.reasoning = "native-high";
    const shadowed = resolve(value);
    expect(shadowed.configuration.axes.reasoning).toBe("native-high");
    expect(shadowed.explanation.map(x => x.code)).not.toContain("lower_scope_axes_preserved");
  });
  it("checks exact manual axes when no semantic requirement constrains an observed session", () => {
    const value = request([record("available")], { overrides: { model: "available", reasoning: "native-medium" } });
    value.requirement = { mode: "inherit", binding: "session" };
    value.observed = { runtimeId: "codex", configurationBasis: "as-run", axes: { model: "available", reasoning: "native-medium" } };
    expect(resolve(value).enforcement.state).toBe("satisfied-not-enforced");
    value.observed.axes.reasoning = "native-high";
    const mismatch = resolve(value);
    expect(mismatch.enforcement.state).toBe("unsatisfied");
    expect(mismatch.explanation.map(x => x.code)).toContain("observed_configuration_mismatch");
  });

});

describe("native routing capability facts", () => {
  it("normalizes native visibility and input modalities without reading model name meaning", () => {
    const result = parseDebugModels(JSON.stringify({ models: [
      { slug: "opaque-listed", visibility: "list", input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }] },
      { slug: "opaque-hidden", visibility: "hide", input_modalities: ["text"], supported_reasoning_levels: [{ effort: "medium" }] }
    ] }));
    expect(result.models[0]).toMatchObject({ selectionVisibility: "listed", inputModalities: ["text", "image"] });
    expect(result.models[1]).toMatchObject({ selectionVisibility: "hidden", inputModalities: ["text"] });
    expect(result.models[0].supportedReasoningLevels[0]).toMatchObject({ effort: "high", intent: "high" });
  });
  it("validates immutable generic selection, modality and effort annotations", () => {
    const fact = makeModelFact({ id: "opaque", selectionVisibility: "listed", inputModalities: ["text", "image"], supportedReasoningLevels: [{ effort: "opaque-effort", intent: "high", order: 3 }] });
    expect(fact.selectionVisibility).toBe("listed");
    expect(Object.isFrozen(fact.inputModalities)).toBe(true);
    expect(fact.supportedReasoningLevels[0]).toMatchObject({ effort: "opaque-effort", intent: "high", order: 3 });
  });
});


describe("routing fact validation failures", () => {
  it("rejects invalid paired effort annotations and invalid visibility without retaining raw input", () => {
    for (const level of [{ effort: "x", intent: "high" }, { effort: "x", order: 1 }, { effort: "x", intent: "high", order: -1 }, { effort: "x", intent: "high", order: 0.5 }, { effort: "x", intent: "high", order: 101 }, { effort: "x", intent: "private-intent-marker", order: 1 }]) {
      expect(() => makeModelFact({ id: "m", supportedReasoningLevels: [level] })).toThrow(/effort annotations/);
    }
    expect(() => makeModelFact({ id: "m", selectionVisibility: "list", supportedReasoningLevels: [] })).toThrow(/selectionVisibility/);
    for (const inputModalities of [null, "image", [false], Array(33).fill("text")]) expect(() => makeModelFact({ id: "m", inputModalities, supportedReasoningLevels: [] })).toThrow(/inputModalities/);
  });
  it("does not throw when a native catalog supplies excessive modality metadata", () => {
    const result = parseDebugModels(JSON.stringify({ models: [{ slug: "bad", input_modalities: Array(33).fill("text") }] }));
    expect(result).toMatchObject({ models: [], skipped: 1, problem: "malformed_output" });
  });
});
