import { describe, it, expect } from "vitest";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { input, model, requirement, evidence } from "./fixtures/model-intelligence/resolver.mjs";

function only(record, changes = {}) {
  const value = input(changes);
  value.catalog.runtimes[0].models = [record];
  return value;
}
function validateResult(result) {
  expect(result.confidence).toMatch(/^(high|medium|low)$/);
  expect(result.enforcement.state).toMatch(/^(enforced|satisfied-not-enforced|unsatisfied|unknown)$/);
  expect(result.enforcement.basis).toMatch(/^(artifact-binding|session-observation|invocation|none)$/);
  for (const entry of [...result.explanation, ...result.diagnostics]) {
    expect(entry.code).toMatch(/^[a-zA-Z][a-zA-Z_0-9]+$/);
    expect(entry.message.trim().length).toBeGreaterThan(0);
  }
}

describe("resolver policy and uncertainty boundaries", () => {
  it("accepts expired evidence only with explicit policy and always reports low confidence", () => {
    const value = only(model("expired-native"));
    for (const entries of Object.values(value.catalog.runtimes[0].models[0].fields)) for (const fact of entries) fact.freshness = "expired";
    expect(resolve(value).status).toBe("unresolved");
    value.policy.preferences.allow_expired_evidence = true;
    const result = resolve(value);
    expect(result).toMatchObject({ status: "resolved", confidence: "low", configuration: { axes: { model: "expired-native" } } });
    expect(result.explanation.map(x => x.code)).toEqual(["configuration_selected", "expired_evidence_used", "artifact_binding_supported"]);
    validateResult(result);
  });
  it("records mixed fresh and stale fields instead of hiding the stale field", () => {
    const value = only(model("mixed-evidence"));
    value.catalog.runtimes[0].models[0].fields.capabilities[0].freshness = "stale";
    const result = resolve(value);
    expect(result.confidence).toBe("medium");
    expect(result.explanation.map(x => x.code)).toEqual(["configuration_selected", "stale_evidence_used", "artifact_binding_supported"]);
    expect(result.explanation[0].provenance.sourceId).toBe("codex");
    validateResult(result);
  });
  it.each(["high", "medium", "low"])("retains %s confidence from the fields used in selection", confidence => {
    const value = only(model("confidence-model"));
    value.catalog.runtimes[0].models[0].fields.id[0].confidence = confidence;
    const result = resolve(value);
    expect(result.confidence).toBe(confidence);
    expect(result.explanation.map(x => x.code)).toEqual(["configuration_selected", "artifact_binding_supported"]);
    validateResult(result);
  });
  it("does not accept unknown freshness as current availability", () => {
    const record = model("unknown-age"); record.fields.id[0].freshness = "unknown";
    const result = resolve(only(record));
    expect(result).toMatchObject({ status: "unresolved", confidence: "low", enforcement: { state: "unknown", basis: "none" } });
    expect(result.diagnostics.map(x => x.code)).toEqual(["insufficient_capability_evidence"]);
    validateResult(result);
  });
  it("keeps opaque native effort pins and detects unsupported axes without substituting", () => {
    const value = input({ invocation: { pin: { runtime: "codex", config: { model: "deep-model", reasoning: "calm" } } } });
    const result = resolve(value);
    expect(result.configuration.axes).toEqual({ model: "deep-model", reasoning: "calm" });
    expect(result.explanation[0].code).toBe("invocation_pin_selected");
    validateResult(result);
    value.invocation.pin.config.extraAxis = "native-value";
    const conflict = resolve(value);
    expect(conflict.status).toBe("conflict");
    expect(conflict.configuration).toBeUndefined();
    expect(conflict.diagnostics.map(x => x.code)).toEqual(["unsupported_configuration_axis"]);
    validateResult(conflict);
  });
  it("binds a session pin only when the target contract verifies every selected axis", () => {
    const value = input({ requirement: requirement("deep", "pin", { binding: "session", pin: { runtime: "codex", config: { model: "deep-model", reasoning: "calm" } } }) });
    const result = resolve(value);
    expect(result.enforcement).toEqual({ state: "enforced", basis: "artifact-binding" });
    validateResult(result);
    value.runtimeContract.binding.agent.support = "unverified";
    const unverified = resolve(value);
    expect(unverified.enforcement).toEqual({ state: "unknown", basis: "none" });
    expect(unverified.diagnostics.map(x => x.code)).toEqual(["binding_unverified"]);
    validateResult(unverified);
  });
  it("never turns a consumer requirement into artifact enforcement", () => {
    const result = resolve(input({ requirement: requirement("deep", "dynamic", { binding: "consumer" }) }));
    expect(result.enforcement).toEqual({ state: "unknown", basis: "none" });
    expect(result.diagnostics.map(x => x.code)).toEqual(["observation_unavailable"]);
    validateResult(result);
  });
  it.each(["stale", "expired", "unknown"])("does not use a %s observation as current compliance", freshness => {
    const value = input({ requirement: requirement("deep", "floor", { binding: "consumer" }), observed: { runtimeId: "codex", configurationBasis: "as-run", axes: { model: "deep-model" }, freshness } });
    const result = resolve(value);
    expect(result.enforcement).toEqual({ state: "unknown", basis: "none" });
    validateResult(result);
  });
  it("compares every pinned observed axis rather than model capability alone", () => {
    const value = input({ requirement: requirement("deep", "dynamic", { binding: "consumer" }), invocation: { pin: { runtime: "codex", config: { model: "deep-model", reasoning: "calm" } } }, observed: { runtimeId: "codex", configurationBasis: "as-run", axes: { model: "deep-model", reasoning: "focused" } } });
    expect(resolve(value).enforcement).toEqual({ state: "unsatisfied", basis: "session-observation" });
    value.observed.axes.reasoning = "calm";
    const result = resolve(value);
    expect(result.enforcement).toEqual({ state: "satisfied-not-enforced", basis: "session-observation" });
    validateResult(result);
  });
  it("selects a stable tie independently of candidate order", () => {
    const value = input(); value.catalog.runtimes[0].models = [model("z-native"), model("a-native")];
    const a = resolve(value);
    value.catalog.runtimes[0].models.reverse();
    const b = resolve(value);
    expect(a.configuration.axes.model).toBe("a-native");
    expect(b).toEqual(a);
    expect(a.configuration.representation.kind).toBe("native-id");
    validateResult(a);
  });
  it("leaves absent or unsupported defaults absent instead of inventing an effort", () => {
    const record = model("no-default"); record.fields.defaultReasoningLevel = [evidence("unsupported-effort")];
    const result = resolve(only(record));
    expect(result.configuration.axes).toEqual({ model: "no-default" });
    validateResult(result);
    const routine = resolve(only(model("routine-native", "routine"), { requirement: requirement("routine") }));
    expect(routine.configuration.axes).toEqual({ model: "routine-native" });
  });
  it("rejects contradictory native effort facts as unknown for tier-dependent requirements", () => {
    const record = model("contradictory-efforts", "frontier");
    record.fields.supportedReasoningLevels.push(evidence([{ effort: "other" }]));
    const result = resolve(only(record, { requirement: requirement("frontier") }));
    expect(result.status).toBe("unresolved");
    validateResult(result);
  });
  it("explains a missing inherited configuration without asserting enforcement", () => {
    const result = resolve(input({ requirement: { mode: "inherit", binding: "consumer" } }));
    expect(result.status).toBe("unresolved");
    expect(result.diagnostics.map(x => x.code)).toEqual(["runtime_inheritance_preserved"]);
    validateResult(result);
  });
  it("distinguishes an unavailable explicit pin from a floor conflict", () => {
    const value = input({ invocation: { pin: { runtime: "codex", config: { model: "absent" } } } });
    const result = resolve(value);
    expect(result.status).toBe("unresolved");
    expect(result.diagnostics.map(x => x.code)).toEqual(["pin_unavailable"]);
    expect(result.enforcement).toEqual({ state: "unknown", basis: "none" });
    validateResult(result);
  });
  it("returns structured invalid results for malformed normalized constraints", () => {
    const invalid = [null, [], { target: null }, { policy: null }, { runtimeContract: null }, { catalog: null }, { catalog: { runtimes: {} } }, { requirement: [] }, { requirement: { mode: "inherit", binding: "self", requirement: "deep" } }, { requirement: { mode: "inherit", binding: "self", pin: { runtime: "codex", config: { model: "deep-model" } } } }, { requirement: requirement("deep", "dynamic", { binding: "invalid" }) }, { requirement: requirement("deep", "pin") }, { requirement: requirement("deep", "dynamic", { pin: { runtime: "codex", config: { model: "deep-model" } } }) }];
    for (const change of invalid) {
      const value = change === null || Array.isArray(change) ? change : input(change);
      const result = resolve(value);
      expect(result.status, JSON.stringify(change)).toBe("invalid");
      expect(result.diagnostics.map(x => x.code)).toEqual(["invalid_resolver_input"]);
      validateResult(result);
    }
    for (const floor of [null, [], { mode: "dynamic", requirement: "deep" }, { mode: "floor", requirement: "invalid" }]) {
      const value = input(); value.policy = { ...value.policy, floor };
      expect(resolve(value).status).toBe("invalid");
    }
    for (const config of [{}, [], { model: null }, { model: 3 }, { model: "-unsafe" }, { "bad-key!": "safe" }]) {
      const value = input({ invocation: { pin: { runtime: "codex", config } } });
      expect(resolve(value).status, JSON.stringify(config)).toBe("invalid");
    }
  });
});
