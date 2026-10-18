import { describe, it, expect, vi } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { route } from "../src/adaptive-session-routing/route.mjs";
import { prepareRoute } from "../src/adaptive-session-routing/prepare.mjs";
import { classify } from "../src/adaptive-session-routing/classifier/index.mjs";
import { input, model, evidence, requirement } from "./fixtures/model-intelligence/resolver.mjs";

const activation = { enabled: true, routingEnabled: true };
const runtimeCapability = { support: "supported", axes: { model: "supported", reasoning: "supported" } };
const manual = { model: { source: "inherited" }, reasoning: { source: "inherited" } };
function native(id, level = "deep") {
  const value = model(id, level);
  const levels = value.fields.supportedReasoningLevels[0].value;
  levels.forEach((entry, index) => Object.assign(entry, { intent: index ? "high" : "medium", order: index }));
  value.fields.defaultReasoningLevel = [evidence("calm")];
  return value;
}
function request(changes = {}) {
  const resolverInput = input({ requirement: { mode: "inherit", binding: "session" } });
  resolverInput.catalog.runtimes[0].models = [native("a-deep"), native("z-frontier", "frontier")];
  return { activation, classification: { status: "classified", requirement: requirement("deep", "dynamic", { binding: "session" }), effortIntent: "medium", confidence: "high" }, resolverInput, manual, runtimeCapability, ...changes };
}
const codes = decision => decision.diagnostics.map(item => item.code);

describe("adaptive session routing decisions", () => {
  it("proposes model and effort without claiming a running configuration", () => {
    const decision = route(request());
    expect(decision).toMatchObject({ status: "proposed", configuration: { axes: { model: "a-deep", reasoning: "calm" } } });
    expect(decision.effectiveConfiguration).toBeUndefined();
    expect(decision.active).not.toBe(true);
  });
  it("preserves manual model and effort independently", () => {
    const selectedModel = route(request({ manual: { ...manual, model: { source: "manual", value: "z-frontier" } } }));
    expect(selectedModel.configuration.axes).toEqual({ model: "z-frontier", reasoning: "calm" });
    const selectedEffort = route(request({ manual: { ...manual, reasoning: { source: "manual", value: "focused" } } }));
    expect(selectedEffort.configuration.axes).toEqual({ model: "a-deep", reasoning: "focused" });
    expect(codes(selectedEffort)).toContain("manual_selection_preserved");
  });
  it("never reports a below-floor manual pin as satisfied", () => {
    const value = request({ manual: { ...manual, model: { source: "manual", value: "a-deep" } } });
    value.resolverInput.policy = { ...value.resolverInput.policy, floor: { mode: "floor", requirement: "frontier" } };
    const decision = route(value);
    expect(decision.status).toBe("blocked");
    expect(decision.resolution.enforcement.state).toBe("unsatisfied");
    expect(codes(decision)).toContain("pin_floor_conflict");
  });
  it("blocks a known observed floor violation when no safe replacement exists", () => {
    const value = request();
    value.resolverInput.catalog.runtimes[0].models = [native("routine-only", "routine")];
    value.resolverInput.policy = { ...value.resolverInput.policy, floor: { mode: "floor", requirement: "frontier" } };
    value.resolverInput.observed = { runtimeId: "codex", configurationBasis: "as-run", freshness: "fresh", axes: { model: "routine-only" } };
    const result = route(value);
    expect(result.status).toBe("blocked"); expect(result.resolution.enforcement.state).toBe("unsatisfied");
    expect(result.configuration).toBeUndefined();
  });
  it("composes classified demand with an artifact floor and keeps the stronger minimum", () => {
    const value = request(); value.resolverInput.requirement = requirement("frontier", "floor", { binding: "session" });
    expect(route(value).configuration.axes.model).toBe("z-frontier");
  });
  it("preserves policy pins while translating independent task effort", () => {
    const value = request(); value.resolverInput.policy = { ...value.resolverInput.policy, pin: { runtime: "codex", config: { model: "z-frontier" } } };
    expect(route(value).configuration.axes).toEqual({ model: "z-frontier", reasoning: "calm" });
  });
  it("never silently substitutes an unavailable manual model or unsupported effort", () => {
    const missing = route(request({ manual: { ...manual, model: { source: "manual", value: "missing" } } }));
    expect(missing.status).toBe("preserved"); expect(codes(missing)).toContain("pin_unavailable");
    const unsupported = route(request({ manual: { ...manual, reasoning: { source: "manual", value: "not-advertised" } } }));
    expect(unsupported.status).toBe("blocked"); expect(codes(unsupported)).toContain("unsupported_configuration_axis");
  });
  it("preserves an axis with unknown provenance while routing the independent axis", () => {
    const decision = route(request({ current: { axes: { model: "z-frontier", reasoning: "calm" } }, manual: { ...manual, model: { source: "unknown" } }, classification: { ...request().classification, effortIntent: "high" } }));
    expect(decision.configuration.axes).toEqual({ model: "z-frontier", reasoning: "focused" });
    expect(codes(decision)).toContain("manual_provenance_unknown");
  });
  it("preserves configuration when a manual or unknown axis has no verified value", () => {
    for (const source of ["manual", "unknown", "unrecognized"]) {
      const decision = route(request({ manual: { ...manual, model: { source } } }));
      expect(decision.status).toBe("preserved"); expect(codes(decision)).toContain("manual_provenance_unknown");
    }
  });
  it("low-confidence and incomplete classifications preserve current configuration", () => {
    for (const classification of [{ status: "uncertain" }, { status: "invalid" }, { ...request().classification, confidence: "low" }, { ...request().classification, effortIntent: undefined }, undefined]) {
      const decision = route(request({ classification }));
      expect(decision.status).toBe("preserved"); expect(codes(decision)).toContain("classification_uncertain");
    }
  });
  it("unsupported or unverified routing never appears active", () => {
    for (const support of ["unsupported", "unverified", undefined]) {
      const decision = route(request({ runtimeCapability: { support } }));
      expect(decision.status).toBe("preserved"); expect(codes(decision)).toContain(support === "unsupported" ? "routing_unsupported" : "routing_unverified");
      expect(decision.configuration).toBeUndefined();
    }
  });
  it("returns only changed control axes and does not require changing a preserved manual axis", () => {
    const value = request({ current: { axes: { model: "z-frontier", reasoning: "calm" } }, manual: { ...manual, reasoning: { source: "manual", value: "calm" } }, runtimeCapability: { support: "supported", axes: { model: "supported", reasoning: "unsupported" } } });
    value.resolverInput.policy = { ...value.resolverInput.policy, pin: { runtime: "codex", config: { model: "a-deep" } } };
    expect(route(value).changes).toEqual({ model: "a-deep" });
    value.current.axes.model = "a-deep";
    expect(route(value)).toMatchObject({ status: "preserved", changes: {} });
  });
  it("requires verified control support for each changed axis", () => {
    const decision = route(request({ runtimeCapability: { support: "supported", axes: { model: "supported", reasoning: "unverified" } } }));
    expect(decision.status).toBe("preserved"); expect(codes(decision)).toContain("routing_unverified");
  });
  it("retains a satisfying current model to preserve context while changing effort independently", () => {
    const decision = route(request({ current: { axes: { model: "z-frontier", reasoning: "focused" } } }));
    expect(decision.configuration.axes).toEqual({ model: "z-frontier", reasoning: "calm" });
    expect(codes(decision)).toContain("current_model_retained");
  });
  it("does not retain a model that cannot satisfy the next task", () => {
    const value = request({ current: { axes: { model: "a-deep", reasoning: "calm" } } });
    value.classification.requirement = requirement("frontier", "dynamic", { binding: "session" });
    expect(route(value).configuration.axes.model).toBe("z-frontier");
  });
  it("does not retain a hidden model through an automatic retention probe", () => {
    const value = request({ current: { axes: { model: "z-frontier", reasoning: "calm" } } });
    value.resolverInput.catalog.runtimes[0].models[1].fields.selectionVisibility = [evidence("hidden")];
    expect(route(value).configuration.axes.model).toBe("a-deep");
  });
  it("does not let hysteresis shadow a policy pin", () => {
    const value = request({ current: { axes: { model: "a-deep", reasoning: "calm" } } });
    value.resolverInput.policy = { ...value.resolverInput.policy, pin: { runtime: "codex", config: { model: "z-frontier" } } };
    expect(route(value).configuration.axes.model).toBe("z-frontier");
  });
  it("does not automatically apply stale capability evidence", () => {
    const value = request();
    for (const candidate of value.resolverInput.catalog.runtimes[0].models) candidate.fields.id[0].freshness = "stale";
    const decision = route(value);
    expect(decision.status).toBe("preserved"); expect(codes(decision)).toContain("stale_capability_evidence");
  });
  it("warm local classification and routing p95 is at most 25 ms", () => {
    const value = request({ current: { axes: { model: "warm-model-0499", reasoning: "calm" } } });
    value.resolverInput.catalog.runtimes[0].models = Array.from({ length: 500 }, (_, index) => native(`warm-model-${String(index).padStart(4, "0")}`));
    const task = { prompt: "Implement integration tests for the payment gateway." };
    const run = () => route({ ...value, classification: classify(task) });
    for (let index = 0; index < 20; index++) run();
    const durations = [];
    for (let index = 0; index < 1000; index++) {
      const start = performance.now(); const result = run(); durations.push(performance.now() - start);
      expect(result.configuration.axes.model).toBe("warm-model-0499");
    }
    durations.sort((a, b) => a - b);
    console.log(JSON.stringify({ benchmark: "warm-local-route-500-models", samples: durations.length, p95Ms: durations[949] }));
    expect(durations[949]).toBeLessThanOrEqual(25);
  });
  it("keeps classifier and capability confidence independent and preserves low-confidence evidence", () => {
    const value = request(); value.classification.confidence = "medium";
    expect(route(value).confidence).toBe("medium");
    value.classification.confidence = "high";
    for (const candidate of value.resolverInput.catalog.runtimes[0].models) candidate.fields.id[0].confidence = "medium";
    expect(route(value).confidence).toBe("medium");
    for (const candidate of value.resolverInput.catalog.runtimes[0].models) candidate.fields.id[0].confidence = "low";
    const low = route(value);
    expect(low).toMatchObject({ status: "preserved", confidence: "low" });
    expect(codes(low)).toContain("capability_confidence_low");
  });
  it("does not use explicitly permitted expired evidence for automatic application", () => {
    const value = request(); value.resolverInput.policy.preferences.allow_expired_evidence = true;
    for (const candidate of value.resolverInput.catalog.runtimes[0].models) candidate.fields.id[0].freshness = "expired";
    const result = route(value);
    expect(result.status).toBe("preserved"); expect(codes(result)).toContain("stale_capability_evidence");
  });
  it("does not retain a stale or low-confidence current model over a verified candidate", () => {
    for (const changes of [{ freshness: "stale" }, { confidence: "low" }]) {
      const value = request({ current: { axes: { model: "z-frontier", reasoning: "calm" } } });
      Object.assign(value.resolverInput.catalog.runtimes[0].models[1].fields.id[0], changes);
      const result = route(value);
      expect(result.configuration.axes.model).toBe("a-deep"); expect(result.confidence).toBe("high");
      expect(codes(result)).not.toContain("current_model_retained");
    }
  });
  it("uses the stronger of a dynamic declaration and the new task without adding artifact enforcement", () => {
    const value = request();
    value.resolverInput.requirement = requirement("frontier", "dynamic", { binding: "session" });
    expect(route(value).configuration.axes.model).toBe("z-frontier");
    value.resolverInput.requirement = requirement("routine", "dynamic", { binding: "session" });
    value.classification.requirement = requirement("frontier");
    expect(route(value).configuration.axes.model).toBe("z-frontier");
    value.resolverInput.requirement = undefined;
    const absent = route(value);
    expect(absent.configuration.axes.model).toBe("z-frontier"); expect(absent.resolution.enforcement.state).toBe("unknown");
    expect(absent.confidence).toBe("high");
  });
  it("does not let model retention shadow invocation or artifact pins", () => {
    for (const layer of ["invocation", "artifact"]) {
      const value = request({ current: { axes: { model: "a-deep", reasoning: "calm" } } });
      const pin = { runtime: "codex", config: { model: "z-frontier" } };
      if (layer === "invocation") value.resolverInput.invocation = { pin };
      else value.resolverInput.requirement = requirement("deep", "pin", { binding: "session", pin });
      expect(route(value).configuration.axes.model).toBe("z-frontier");
    }
  });
  it("retains existing invocation axes while classifying independent effort demand", () => {
    const value = request(); value.resolverInput.invocation = { overrides: { reasoning: "focused" } };
    const result = route(value);
    expect(result.configuration.axes).toEqual({ model: "a-deep", reasoning: "focused" });
  });
  it("preserves a manual effort supplied by the current runtime value", () => {
    const value = request({ current: { axes: { model: "a-deep", reasoning: "focused" } }, manual: { ...manual, reasoning: { source: "manual" } } });
    const result = route(value);
    expect(result.configuration.axes).toEqual({ model: "a-deep", reasoning: "focused" });
    expect(result.changes).toEqual({}); expect(codes(result)).toContain("manual_selection_preserved");
  });
  it("preserves unknown effort provenance while independently applying a policy model pin", () => {
    const value = request({ current: { axes: { model: "z-frontier", reasoning: "focused" } }, manual: { ...manual, reasoning: { source: "unknown" } } });
    value.resolverInput.policy = { ...value.resolverInput.policy, pin: { runtime: "codex", config: { model: "a-deep" } } };
    const result = route(value);
    expect(result.configuration.axes).toEqual({ model: "a-deep", reasoning: "focused" });
    expect(result.changes).toEqual({ model: "a-deep" }); expect(codes(result)).toContain("manual_provenance_unknown");
  });
  it("distinguishes unsupported controls from absent control evidence without applying either", () => {
    for (const runtimeCapability of [{ support: "supported", axes: { model: "supported", reasoning: "unsupported" } }, { support: "supported" }]) {
      const result = route(request({ runtimeCapability }));
      expect(result.status).toBe("preserved"); expect(result.configuration).toBeUndefined();
      expect(codes(result)).toContain(runtimeCapability.axes ? "routing_unsupported" : "routing_unverified");
    }
    expect(codes(route(request({ runtimeCapability: undefined })))).toContain("routing_unverified");
  });
  it("requires strict activation booleans and never exposes rejected input or exception text", () => {
    for (const activation of [{ enabled: "true", routingEnabled: true }, { enabled: true, routingEnabled: 1 }]) expect(route(request({ activation })).status).toBe("preserved");
    const malformed = route(null);
    expect(malformed).toMatchObject({ status: "preserved", confidence: "low", diagnostics: [{ code: "invalid_routing_input" }] });
    const value = request(); Object.defineProperty(value, "resolverInput", { get() { throw Error("private-routing-marker"); } });
    const result = route(value);
    expect(codes(result)).toContain("invalid_routing_input"); expect(JSON.stringify(result)).not.toContain("private-routing-marker");
  });
  it("leaves caller-owned prompt context policy and subagent configuration unchanged", () => {
    const value = request(); const before = structuredClone(value); route(value); expect(value).toEqual(before);
  });
});

describe("lazy routing preparation", () => {
  it("disabled routing performs no discovery classification application or writes", async () => {
    for (const state of [{ enabled: false, routingEnabled: false }, { enabled: true, routingEnabled: false }]) {
      const classify = vi.fn(), loadResolverInput = vi.fn();
      const value = { repoRoot: "/project", get prompt() { throw Error("disabled prompt accessed"); } };
      const decision = await prepareRoute(value, { readActivation: () => state, classify, loadResolverInput });
      expect(decision.status).toBe("preserved"); expect(classify).not.toHaveBeenCalled(); expect(loadResolverInput).not.toHaveBeenCalled();
      expect(codes(decision)).toContain(state.enabled ? "routing_disabled" : "intelligence_disabled");
    }
  });
  it("classifies an ordinary prompt locally before loading capability evidence", async () => {
    const value = request(); const calls = [];
    const decision = await prepareRoute({ repoRoot: "/project", prompt: "Implement integration tests for the payment gateway.", manual, runtimeCapability }, {
      readActivation: () => activation,
      classify: task => { calls.push("classify"); return classify(task); },
      loadResolverInput: () => { calls.push("catalog"); return value.resolverInput; }
    });
    expect(calls).toEqual(["classify", "catalog"]); expect(decision.status).toBe("proposed");
  });
  it("does not disclose an exception or continue after activation classification or catalog failure", async () => {
    for (const [stage, code] of [["readActivation", "project_config_unavailable"], ["classify", "classification_failed"], ["loadResolverInput", "capability_evidence_unavailable"]]) {
      const deps = { readActivation: () => activation, classify: () => request().classification, loadResolverInput: () => request().resolverInput };
      deps[stage] = () => { throw Error("private-prompt-credential-marker"); };
      const decision = await prepareRoute({ repoRoot: "/project", prompt: "task", manual, runtimeCapability }, deps);
      expect(decision).toMatchObject({ status: "preserved", confidence: "low", diagnostics: [{ code }] }); expect(JSON.stringify(decision)).not.toContain("private-prompt-credential-marker");
    }
  });
  it("does not classify or load capabilities for an unavailable routing mechanism", async () => {
    const classify = vi.fn(), loadResolverInput = vi.fn();
    const decision = await prepareRoute({ repoRoot: "/project", get prompt() { throw Error("must not inspect prompt"); }, runtimeCapability: { support: "unsupported" } }, { readActivation: () => activation, classify, loadResolverInput });
    expect(codes(decision)).toContain("routing_unsupported");
    expect(classify).not.toHaveBeenCalled(); expect(loadResolverInput).not.toHaveBeenCalled();
  });
  it("does not load capabilities for a classified task with low confidence", async () => {
    const loadResolverInput = vi.fn();
    const decision = await prepareRoute({ repoRoot: "/project", prompt: "task", manual, runtimeCapability }, { readActivation: () => activation, classify: () => ({ ...request().classification, confidence: "low" }), loadResolverInput });
    expect(decision).toMatchObject({ status: "preserved", confidence: "low", diagnostics: [{ code: "classification_uncertain" }] });
    expect(loadResolverInput).not.toHaveBeenCalled();
  });
  it("forwards supplied context without scanning a repository to infer it", async () => {
    const decision = await prepareRoute({ repoRoot: "/project", prompt: "Implement the frontend adjustment.", context: { componentCount: 5, verification: "adversarial", ambiguity: "high" }, manual, runtimeCapability }, { readActivation: () => activation, loadResolverInput: () => request().resolverInput });
    expect(decision.configuration.axes.model).toBe("z-frontier"); expect(decision.configuration.axes.reasoning).toBe("focused");
  });
  it("preserves current manual axes through preparation and requires only changed controls", async () => {
    const decision = await prepareRoute({ repoRoot: "/project", prompt: "Implement integration tests for the gateway.", current: { axes: { model: "a-deep", reasoning: "focused" } }, manual: { model: { source: "manual", value: "z-frontier" }, reasoning: { source: "manual", value: "focused" } }, runtimeCapability: { support: "supported", axes: { model: "supported", reasoning: "unsupported" } } }, { readActivation: () => activation, loadResolverInput: () => request().resolverInput });
    expect(decision.configuration.axes).toEqual({ model: "z-frontier", reasoning: "focused" }); expect(decision.changes).toEqual({ model: "z-frontier" });
  });
  it("uses actual project files concurrently without accessing disabled prompt data", async () => {
    const enabled = makeTempDir("routing-enabled-"), disabled = makeTempDir("routing-disabled-");
    const documents = [JSON.stringify({ model_intelligence: { enabled: true, adaptive_routing: { enabled: true } } }), JSON.stringify({ model_intelligence: { enabled: false, adaptive_routing: { enabled: true } } })];
    for (const [root, text] of [[enabled, documents[0]], [disabled, documents[1]]]) writeFileSync(join(root, ".dotbabel.json"), text);
    const loaded = [];
    const dependencies = { loadResolverInput: root => { loaded.push(root); return request().resolverInput; } };
    const results = await Promise.all([
      prepareRoute({ repoRoot: enabled, prompt: "Implement integration tests for the gateway.", manual, runtimeCapability }, dependencies),
      prepareRoute({ repoRoot: disabled, get prompt() { throw Error("disabled prompt read"); }, manual, runtimeCapability }, dependencies),
    ]);
    expect(results[0].status).toBe("proposed"); expect(codes(results[1])).toContain("intelligence_disabled"); expect(loaded).toEqual([enabled]);
    expect(readFileSync(join(enabled, ".dotbabel.json"), "utf8")).toBe(documents[0]); expect(readFileSync(join(disabled, ".dotbabel.json"), "utf8")).toBe(documents[1]);
  });
  it("does not load capabilities for a malformed classified demand", async () => {
    for (const classification of [{ ...request().classification, effortIntent: undefined }, { ...request().classification, requirement: { requirement: "invented-class" } }]) {
      const loadResolverInput = vi.fn();
      const result = await prepareRoute({ repoRoot: "/project", prompt: "task", manual, runtimeCapability }, { readActivation: () => activation, classify: () => classification, loadResolverInput });
      expect(codes(result)).toContain("classification_uncertain"); expect(loadResolverInput).not.toHaveBeenCalled();
    }
  });
  it("does not load a catalog after an uncertain classification", async () => {
    const loadResolverInput = vi.fn();
    const decision = await prepareRoute({ repoRoot: "/project", prompt: "hello", manual, runtimeCapability }, { readActivation: () => activation, loadResolverInput });
    expect(decision.status).toBe("preserved"); expect(loadResolverInput).not.toHaveBeenCalled();
  });
});
