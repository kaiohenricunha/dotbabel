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
  it("keeps each configuration axis under its runtime-owned name, and the provider as a separate, individually sourced field", () => {
    const observed = makeObservedConfiguration({
      runtimeId: "codex",
      turnExecuted: false, configurationBasis: "as-run",
      axes: { model: "gpt-6-astra", reasoning: "xhigh" },
      provider: "openai",
      fieldSources: { "axes.model": "exec-banner:model", "axes.reasoning": "exec-banner:reasoning effort", provider: "exec-banner:provider" },
    });
    // ARCH-2 and ARCH-28. handoff-extract.sh stored the provider in the model field; here the two
    // can never collapse, and each names the surface that supplied it.
    expect(observed.axes).toEqual({ model: "gpt-6-astra", reasoning: "xhigh" });
    expect(observed.provider).toBe("openai");
    expect(observed.fieldSources["axes.reasoning"]).toBe("exec-banner:reasoning effort");
    expect(Object.isFrozen(observed) && Object.isFrozen(observed.axes) && Object.isFrozen(observed.fieldSources)).toBe(true);
  });

  it("carries an axis the domain has no name for, such as a selector that fuses model and effort", () => {
    // §5 `Configuration axes`: axis names belong to the runtime adapter contract, so a fused
    // selector stays one opaque axis instead of being forced into model and reasoning (ARCH-1, ARCH-17).
    const observed = makeObservedConfiguration({
      runtimeId: "antigravity",
      turnExecuted: false, configurationBasis: "as-run",
      axes: { selector: "gemini-3.8-flash-high" },
      fieldSources: { "axes.selector": "settings:selector" },
    });
    expect(observed.axes).toEqual({ selector: "gemini-3.8-flash-high" });
    expect(Object.hasOwn(observed.axes, "model")).toBe(false);
  });

  it("does not invent a field the runtime did not report", () => {
    const observed = makeObservedConfiguration({ runtimeId: "claude", turnExecuted: false, configurationBasis: "as-run", axes: { model: "claude-opus-5" }, fieldSources: { "axes.model": "system/init.model" } });
    // Effort is absent because Claude reports none (DOC-2, constraint 19), and absence stays
    // distinguishable from an observed value.
    expect(Object.hasOwn(observed.axes, "reasoning")).toBe(false);
    expect(Object.hasOwn(observed, "provider")).toBe(false);
    expect(observed.usage).toEqual([]);
    // With nothing reported, the axis map is present and empty rather than absent.
    expect(makeObservedConfiguration({ runtimeId: "claude", turnExecuted: false, configurationBasis: "as-run", fieldSources: {} }).axes).toEqual({});
  });

  it("rejects an unknown runtime, a missing turn flag, an unknown field and a reported value with no source", () => {
    const ok = { runtimeId: "claude", turnExecuted: false, configurationBasis: "as-run", axes: { model: "m" }, fieldSources: { "axes.model": "s" } };
    expect(() => makeObservedConfiguration({ ...ok, runtimeId: "clade" })).toThrow(/runtimeId/);
    expect(() => makeObservedConfiguration({ ...ok, turnExecuted: "no" })).toThrow(/turnExecuted/);
    expect(() => makeObservedConfiguration({ ...ok, accountId: "user@example.com" })).toThrow(/unknown field.*accountId/);
    // The closed top-level shape still holds: the retired `model` and `effort` fields are unknown.
    expect(() => makeObservedConfiguration({ ...ok, model: "m" })).toThrow(/unknown field.*model/);
    expect(() => makeObservedConfiguration({ ...ok, effort: "high" })).toThrow(/unknown field.*effort/);
    // A value with no recorded source has no provenance, which ARCH-28 requires per field.
    expect(() => makeObservedConfiguration({ ...ok, fieldSources: {} })).toThrow(/fieldSources\["axes.model"\]/);
    expect(() => makeObservedConfiguration({ ...ok, provider: "openai" })).toThrow(/fieldSources\["provider"\]/);
    expect(() => makeObservedConfiguration({ ...ok, usage: "nope" })).toThrow(/usage/);
  });

  it("rejects an axis name that is not a plain identifier and an axis value that is not a short printable string", () => {
    const sourced = (axes) => ({ runtimeId: "codex", turnExecuted: false, configurationBasis: "as-run", axes, fieldSources: Object.fromEntries(Object.keys(axes).map((k) => [`axes.${k}`, "s"])) });
    for (const name of ["__proto__", "Model Name", "", "1model", "a.b", "x".repeat(65)]) {
      expect(() => makeObservedConfiguration(sourced({ [name]: "v" })), JSON.stringify(name)).toThrow(/axis name/);
    }
    for (const value of ["", "x".repeat(201), `tab${String.fromCharCode(9)}bed`, 7, null]) {
      expect(() => makeObservedConfiguration(sourced({ model: value })), String(value).slice(0, 10)).toThrow(/axes.model/);
    }
    expect(() => makeObservedConfiguration({ runtimeId: "codex", turnExecuted: false, configurationBasis: "as-run", axes: ["model"], fieldSources: {} })).toThrow(/axes must be an object/);
  });

  it("says whether a configuration came from a real run or was reconstructed in a probe, and what the probe carried in", () => {
    const base = { runtimeId: "codex", turnExecuted: false, configurationBasis: "as-run", axes: { model: "m" }, fieldSources: { "axes.model": "exec-banner:model" } };
    // A probe runs in a scratch home, so its answer reflects only what was carried into it plus the
    // runtime's defaults. Recording that makes a reconstructed default distinguishable from the user's
    // real configuration, which catalog/ must know before it ranks the evidence (ARCH-28).
    const seeded = makeObservedConfiguration({ ...base, configurationBasis: "reconstructed", reconstructedFrom: ["model", "model_reasoning_effort"] });
    expect(seeded.configurationBasis).toBe("reconstructed");
    expect(seeded.reconstructedFrom).toEqual(["model", "model_reasoning_effort"]);
    expect(Object.isFrozen(seeded.reconstructedFrom)).toBe(true);
    // Nothing carried in means the values are the runtime's own defaults, and that is stated, not implied.
    expect(makeObservedConfiguration({ ...base, configurationBasis: "reconstructed", reconstructedFrom: [] }).reconstructedFrom).toEqual([]);
    const asRun = makeObservedConfiguration({ ...base, configurationBasis: "as-run" });
    expect(asRun.configurationBasis).toBe("as-run");
    expect(Object.hasOwn(asRun, "reconstructedFrom")).toBe(false);
  });

  it("rejects a missing or unknown basis, and a carried-input list that contradicts the basis", () => {
    const base = { runtimeId: "codex", turnExecuted: false, fieldSources: {} };
    expect(() => makeObservedConfiguration(base)).toThrow(/configurationBasis/);
    expect(() => makeObservedConfiguration({ ...base, configurationBasis: "guessed" })).toThrow(/configurationBasis/);
    expect(() => makeObservedConfiguration({ ...base, configurationBasis: "reconstructed" })).toThrow(/reconstructedFrom/);
    expect(() => makeObservedConfiguration({ ...base, configurationBasis: "as-run", reconstructedFrom: [] })).toThrow(/reconstructedFrom/);
    expect(() => makeObservedConfiguration({ ...base, configurationBasis: "reconstructed", reconstructedFrom: "model" })).toThrow(/reconstructedFrom/);
    expect(() => makeObservedConfiguration({ ...base, configurationBasis: "reconstructed", reconstructedFrom: [""] })).toThrow(/reconstructedFrom/);
  });

  it("rejects a source for a field that was not reported, so provenance cannot describe nothing", () => {
    expect(() => makeObservedConfiguration({ runtimeId: "codex", turnExecuted: false, configurationBasis: "as-run", axes: {}, fieldSources: { "axes.model": "s" } })).toThrow(/fieldSources\["axes.model"\].*not reported/);
    expect(() => makeObservedConfiguration({ runtimeId: "codex", turnExecuted: false, configurationBasis: "as-run", axes: {}, fieldSources: { effort: "s" } })).toThrow(/fieldSources\["effort"\]/);
  });

  it("validates each usage entry and keeps optional numbers optional", () => {
    const observed = makeObservedConfiguration({
      runtimeId: "claude",
      turnExecuted: true, configurationBasis: "as-run",
      axes: { model: "claude-opus-5[1m]" },
      fieldSources: { "axes.model": "system/init.model" },
      usage: [{ model: "claude-opus-5[1m]", thinkingTokens: 130 }, { model: "claude-haiku-4-5-20251001", canonicalModel: "claude-haiku-4-5-20251001", provider: "anthropic", contextWindow: 200000, maxOutputTokens: 64000, thinkingTokens: 0 }],
    });
    expect(observed.usage).toHaveLength(2);
    expect(Object.hasOwn(observed.usage[0], "contextWindow")).toBe(false);
    expect(observed.usage[1].provider).toBe("anthropic");
    for (const bad of [{ model: "" }, { model: "m", contextWindow: -1 }, { model: "m", thinkingTokens: Number.NaN }, { model: "m", contextWindow: "big" }, { model: "m", extra: 1 }, null]) {
      expect(() => makeObservedConfiguration({ runtimeId: "claude", turnExecuted: true, configurationBasis: "as-run", fieldSources: {}, usage: [bad] }), JSON.stringify(bad)).toThrow();
    }
  });

  it("carries the runtime version when given and rejects text that is not a version", () => {
    expect(makeObservedConfiguration({ runtimeId: "claude", turnExecuted: false, configurationBasis: "as-run", runtimeVersion: "2.1.278", fieldSources: {} }).runtimeVersion).toBe("2.1.278");
    expect(() => makeObservedConfiguration({ runtimeId: "claude", turnExecuted: false, configurationBasis: "as-run", runtimeVersion: "2.1.278 user@example.com", fieldSources: {} })).toThrow(/runtimeVersion/);
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
