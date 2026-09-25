import { describe, it, expect } from "vitest";
import {
  VERDICTS,
  VERDICT_SCOPES,
  deepFreeze,
  makeObservedConfiguration,
  makeModelFact,
  makeDiscoveryEvidence,
  makeValidationEvidence,
  makeInvocation,
} from "../src/model-intelligence/sources/evidence.mjs";

describe("observed effective configuration", () => {
  it("keeps model, provider and effort as three separate, opaque, individually sourced fields", () => {
    const observed = makeObservedConfiguration({
      runtimeId: "codex",
      turnExecuted: false,
      model: "gpt-6-astra",
      provider: "openai",
      effort: "xhigh",
      fieldSources: { model: "exec-banner:model", provider: "exec-banner:provider", effort: "exec-banner:reasoning effort" },
    });
    // ARCH-2 and ARCH-28. handoff-extract.sh stored the provider in the model field; here the two
    // can never collapse, and each names the surface that supplied it.
    expect(observed).toMatchObject({ model: "gpt-6-astra", provider: "openai", effort: "xhigh" });
    expect(observed.fieldSources.provider).toBe("exec-banner:provider");
    expect(Object.isFrozen(observed) && Object.isFrozen(observed.fieldSources)).toBe(true);
  });

  it("does not invent a field the runtime did not report", () => {
    const observed = makeObservedConfiguration({ runtimeId: "claude", turnExecuted: false, model: "claude-opus-5", fieldSources: { model: "system/init.model" } });
    // Effort is absent because Claude reports none (DOC-2, constraint 19), and absence stays
    // distinguishable from an observed value.
    expect(Object.hasOwn(observed, "effort")).toBe(false);
    expect(Object.hasOwn(observed, "provider")).toBe(false);
    expect(observed.usage).toEqual([]);
  });

  it("rejects an unknown runtime, a missing turn flag, an unknown field and a field with no source", () => {
    const ok = { runtimeId: "claude", turnExecuted: false, model: "m", fieldSources: { model: "s" } };
    expect(() => makeObservedConfiguration({ ...ok, runtimeId: "clade" })).toThrow(/runtimeId/);
    expect(() => makeObservedConfiguration({ ...ok, turnExecuted: "no" })).toThrow(/turnExecuted/);
    expect(() => makeObservedConfiguration({ ...ok, accountId: "user@example.com" })).toThrow(/unknown field.*accountId/);
    // A value with no recorded source has no provenance, which ARCH-28 requires per field.
    expect(() => makeObservedConfiguration({ ...ok, fieldSources: {} })).toThrow(/fieldSources.model/);
    expect(() => makeObservedConfiguration({ ...ok, model: "" })).toThrow(/model/);
    expect(() => makeObservedConfiguration({ ...ok, model: "x".repeat(201) })).toThrow(/model/);
    expect(() => makeObservedConfiguration({ ...ok, usage: "nope" })).toThrow(/usage/);
  });

  it("validates each usage entry and keeps optional numbers optional", () => {
    const observed = makeObservedConfiguration({
      runtimeId: "claude",
      turnExecuted: true,
      model: "claude-opus-5[1m]",
      fieldSources: { model: "system/init.model" },
      usage: [{ model: "claude-opus-5[1m]", thinkingTokens: 130 }, { model: "claude-haiku-4-5-20251001", canonicalModel: "claude-haiku-4-5-20251001", provider: "anthropic", contextWindow: 200000, maxOutputTokens: 64000, thinkingTokens: 0 }],
    });
    expect(observed.usage).toHaveLength(2);
    expect(Object.hasOwn(observed.usage[0], "contextWindow")).toBe(false);
    expect(observed.usage[1].provider).toBe("anthropic");
    for (const bad of [{ model: "" }, { model: "m", contextWindow: -1 }, { model: "m", thinkingTokens: Number.NaN }, { model: "m", contextWindow: "big" }, { model: "m", extra: 1 }, null]) {
      expect(() => makeObservedConfiguration({ runtimeId: "claude", turnExecuted: true, fieldSources: {}, usage: [bad] }), JSON.stringify(bad)).toThrow();
    }
  });

  it("carries the runtime version when given and rejects text that is not a version", () => {
    expect(makeObservedConfiguration({ runtimeId: "claude", turnExecuted: false, runtimeVersion: "2.1.278", fieldSources: {} }).runtimeVersion).toBe("2.1.278");
    expect(() => makeObservedConfiguration({ runtimeId: "claude", turnExecuted: false, runtimeVersion: "2.1.278 user@example.com", fieldSources: {} })).toThrow(/runtimeVersion/);
  });
});

describe("model facts and discovery evidence", () => {
  const levels = (...efforts) => efforts.map((effort) => ({ effort }));

  it("records effort support per model, never per runtime (ARCH-1)", () => {
    const evidence = makeDiscoveryEvidence({
      models: [
        makeModelFact({ id: "gpt-6-astra", supportedReasoningLevels: levels("low", "medium", "high", "xhigh", "max", "ultra") }),
        makeModelFact({ id: "gpt-5.5", supportedReasoningLevels: levels("low", "medium", "high", "xhigh") }),
      ],
    });
    expect(evidence.effortSupport.max).toEqual({ supportedBy: ["gpt-6-astra"], notSupportedBy: ["gpt-5.5"] });
    expect(evidence.effortSupport.low.notSupportedBy).toEqual([]);
    // A `max` requirement can therefore be refused for the models that lack it.
    expect(evidence.effortSupport.ultra.notSupportedBy).toEqual(["gpt-5.5"]);
  });

  it("has no provider field on a model, because the catalog carries none (DOC-2, constraint 6)", () => {
    const fact = makeModelFact({ id: "gpt-5.5", supportedReasoningLevels: levels("low") });
    expect(Object.hasOwn(fact, "provider")).toBe(false);
    expect(() => makeModelFact({ id: "gpt-5.5", supportedReasoningLevels: levels("low"), provider: "openai" })).toThrow(/unknown field.*provider/);
  });

  it("reports the count of entries it could not use instead of hiding them", () => {
    expect(makeDiscoveryEvidence({ models: [], skipped: 3 }).skipped).toBe(3);
    expect(makeDiscoveryEvidence({ models: [] }).skipped).toBe(0);
    expect(() => makeDiscoveryEvidence({ models: [], skipped: -1 })).toThrow(/skipped/);
  });

  it("rejects a malformed model fact", () => {
    const base = { id: "m", supportedReasoningLevels: levels("low") };
    expect(() => makeModelFact({ ...base, id: "" })).toThrow(/id/);
    expect(() => makeModelFact({ ...base, supportedReasoningLevels: "low" })).toThrow(/supportedReasoningLevels/);
    expect(() => makeModelFact({ ...base, supportedReasoningLevels: [{}] })).toThrow(/effort/);
    expect(() => makeModelFact({ ...base, contextWindow: "big" })).toThrow(/contextWindow/);
    expect(() => makeModelFact({ ...base, defaultReasoningLevel: 3 })).toThrow(/defaultReasoningLevel/);
    expect(() => makeDiscoveryEvidence({ models: "x" })).toThrow(/models/);
    expect(() => makeDiscoveryEvidence({ models: [{ id: "raw" }] })).toThrow(/model fact/);
  });

  it("keeps an optional field only when it was reported, and an empty level list is allowed", () => {
    const fact = makeModelFact({ id: "m", displayName: "M", visibility: "hide", supportedReasoningLevels: [], defaultReasoningLevel: "low", contextWindow: 1, maxContextWindow: 2, supportVerbosity: true, defaultVerbosity: "low" });
    expect(fact).toMatchObject({ displayName: "M", visibility: "hide", defaultReasoningLevel: "low", contextWindow: 1, maxContextWindow: 2, supportVerbosity: true, defaultVerbosity: "low" });
    expect(Object.hasOwn(makeModelFact({ id: "m", supportedReasoningLevels: [] }), "displayName")).toBe(false);
  });
});

describe("validation evidence", () => {
  it("uses recognized, unrecognized and unverifiable, and says whether the runtime checked a key or a value", () => {
    expect([...VERDICTS]).toEqual(["recognized", "unrecognized", "unverifiable"]);
    expect([...VERDICT_SCOPES]).toEqual(["key", "value"]);
    const evidence = makeValidationEvidence({
      checks: [
        { axis: "model", value: "opus", verdict: "recognized", scope: "value" },
        { axis: "model", value: "nope", verdict: "unrecognized", scope: "value", runtimeText: "not in the catalog" },
        { axis: "reasoning", value: "bogus", verdict: "unrecognized", scope: "value", validValues: ["low", "high"] },
      ],
      runtimeVersion: "2.1.278",
    });
    expect(evidence.checks).toHaveLength(3);
    expect(evidence.checks[2].validValues).toEqual(["low", "high"]);
    expect(evidence.runtimeVersion).toBe("2.1.278");
  });

  it("does not let recognized read as available: the shape has no availability field", () => {
    // ARCH-14 and constraint 12: recognising a value is not proof the account can invoke it.
    expect(() => makeValidationEvidence({ checks: [{ axis: "model", value: "opus", verdict: "recognized", scope: "value", available: true }] })).toThrow(/unknown field.*available/);
  });

  it("rejects a malformed check", () => {
    const check = { axis: "model", value: "m", verdict: "recognized", scope: "value" };
    expect(() => makeValidationEvidence({ checks: [{ ...check, verdict: "accepted" }] })).toThrow(/verdict/);
    expect(() => makeValidationEvidence({ checks: [{ ...check, scope: "everything" }] })).toThrow(/scope/);
    expect(() => makeValidationEvidence({ checks: [{ ...check, axis: "" }] })).toThrow(/axis/);
    expect(() => makeValidationEvidence({ checks: [{ ...check, validValues: "low" }] })).toThrow(/validValues/);
    expect(() => makeValidationEvidence({ checks: [{ ...check, runtimeText: 5 }] })).toThrow(/runtimeText/);
    expect(() => makeValidationEvidence({ checks: "no" })).toThrow(/checks/);
    expect(() => makeValidationEvidence({ checks: [null] })).toThrow(/check/);
    expect(() => makeValidationEvidence({ checks: [], runtimeVersion: "not a version" })).toThrow(/runtimeVersion/);
  });

  it("bounds and masks the runtime text it carries, since it is runtime output", () => {
    const secret = "sk-ant-api03-AbCdEf0123456789";
    const evidence = makeValidationEvidence({ checks: [{ axis: "model", value: "m", verdict: "unrecognized", scope: "value", runtimeText: `bad ${secret} ${"y ".repeat(2_000)}` }] });
    expect(evidence.checks[0].runtimeText).not.toContain(secret);
    expect(evidence.checks[0].runtimeText.length).toBeLessThanOrEqual(1_024);
  });
});

describe("invocation", () => {
  it("is structured data first: a command, an argument list, and the axes it could not express", () => {
    const invocation = makeInvocation({ runtimeId: "claude", command: "claude", args: ["--model", "opus"], unsupportedAxes: ["contextTier"] });
    expect(invocation).toEqual({ runtimeId: "claude", command: "claude", args: ["--model", "opus"], unsupportedAxes: ["contextTier"] });
    expect(Object.isFrozen(invocation) && Object.isFrozen(invocation.args)).toBe(true);
    // ARCH-47: no shell string on the structure, and nothing here executes it.
    expect(Object.hasOwn(invocation, "shell")).toBe(false);
  });

  it("rejects an argument that is not a string and an unknown runtime", () => {
    expect(() => makeInvocation({ runtimeId: "claude", command: "claude", args: ["--model", 7], unsupportedAxes: [] })).toThrow(/args/);
    expect(() => makeInvocation({ runtimeId: "nope", command: "claude", args: [], unsupportedAxes: [] })).toThrow(/runtimeId/);
    expect(() => makeInvocation({ runtimeId: "claude", command: "", args: [], unsupportedAxes: [] })).toThrow(/command/);
    expect(() => makeInvocation({ runtimeId: "claude", command: "claude", args: [], unsupportedAxes: [3] })).toThrow(/unsupportedAxes/);
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects and arrays and leaves primitives alone", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] }, d: "x" });
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBeNull();
  });
});
