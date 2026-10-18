import { describe, it, expect } from "vitest";
import { validateDescriptor, createRegistry } from "../src/model-intelligence/sources/contract.mjs";
import { descriptor as codex } from "../src/model-intelligence/sources/runtime/codex.mjs";

function descriptor() {
  return structuredClone(codex);
}
function mechanism(support = "unverified") {
  return { support, axes: { model: support, reasoning: support }, observation: { support: "unverified", axes: { model: "unverified", reasoning: "unverified" } } };
}

describe("main-session capability contracts", () => {
  it("keeps existing five-block descriptors valid and missing routing capabilities unverified", () => {
    const value = descriptor();
    expect(validateDescriptor(value).errors).toEqual([]);
    const registry = createRegistry([value]);
    expect(registry.invocationAxisSupport("codex", "model")).toBe("supported");
    expect(registry.mainSessionSupport("codex", "app-server")).toBe("unverified");
    expect(registry.mainSessionAxisSupport("codex", "app-server", "model")).toBe("unverified");
    expect(registry.mainSessionObservationSupport("codex", "app-server", "reasoning")).toBe("unverified");
  });
  it("distinguishes a verified mechanism from stock CLI and observation support", () => {
    const value = descriptor(); value.capabilities.mainSession = { "app-server": mechanism("supported"), "native-cli": mechanism("unsupported") };
    value.capabilities.mainSession["app-server"].observation = { support: "supported", axes: { model: "supported", reasoning: "unverified" } };
    expect(validateDescriptor(value).errors).toEqual([]);
    const registry = createRegistry([value]);
    expect(registry.mainSessionSupport("codex", "app-server")).toBe("supported");
    expect(registry.mainSessionAxisSupport("codex", "app-server", "reasoning")).toBe("supported");
    expect(registry.mainSessionSupport("codex", "native-cli")).toBe("unsupported");
    expect(registry.mainSessionObservationSupport("codex", "app-server", "model")).toBe("supported");
    expect(registry.mainSessionObservationSupport("codex", "app-server", "reasoning")).toBe("unverified");
    expect(registry.bindingSupport("codex", "skill")).toBe("unverified");
  });
  it("does not let a stray supported axis promote an unverified control or observation block", () => {
    const value = descriptor(); value.capabilities.mainSession = { mod: mechanism() };
    value.capabilities.mainSession.mod.axes.model = "supported";
    value.capabilities.mainSession.mod.observation.axes.model = "supported";
    const registry = createRegistry([value]);
    expect(registry.mainSessionAxisSupport("codex", "mod", "model")).toBe("unverified");
    expect(registry.mainSessionObservationSupport("codex", "mod", "model")).toBe("unverified");
    expect(registry.mainSessionSupport("codex", "constructor")).toBe("unverified");
  });
  it("represents manual-selection provenance independently for model and effort", () => {
    const value = descriptor(); value.capabilities.mainSession = { mod: mechanism("supported") };
    value.capabilities.mainSession.mod.manualSelection = { support: "supported", axes: { model: "supported", reasoning: "unverified" } };
    expect(validateDescriptor(value).errors).toEqual([]);
    const registry = createRegistry([value]);
    expect(registry.mainSessionManualSupport("codex", "mod", "model")).toBe("supported");
    expect(registry.mainSessionManualSupport("codex", "mod", "reasoning")).toBe("unverified");
    expect(registry.mainSessionManualSupport("codex", "missing", "model")).toBe("unverified");
    value.capabilities.mainSession.mod.manualSelection.axes.model = true;
    expect(validateDescriptor(value).errors.some(e => e.path.includes("manualSelection.axes.model"))).toBe(true);
  });
  it("keeps observation independent of unavailable control and accepts the bounded table limit", () => {
    const value = descriptor(); value.capabilities.mainSession = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`mode-${index}`, mechanism("unsupported")]));
    value.capabilities.mainSession["mode-0"].observation = { support: "supported", axes: { model: "supported" } };
    expect(validateDescriptor(value).errors).toEqual([]);
    const registry = createRegistry([value]);
    expect(registry.mainSessionAxisSupport("codex", "mode-0", "model")).toBe("unsupported");
    expect(registry.mainSessionObservationSupport("codex", "mode-0", "model")).toBe("supported");
    expect(registry.mainSessionManualSupport("codex", "mode-0", "model")).toBe("unverified");
    value.capabilities.mainSession = {};
    expect(validateDescriptor(value).errors).toEqual([]);
  });
  it("snapshots mechanisms so caller mutation cannot promote static support", () => {
    const value = descriptor(); value.capabilities.mainSession = { mod: mechanism() };
    const registry = createRegistry([value]);
    value.capabilities.mainSession.mod.support = "supported";
    expect(registry.mainSessionSupport("codex", "mod")).toBe("unverified");
    expect(Object.isFrozen(registry.get("codex").capabilities.mainSession.mod.axes)).toBe(true);
    expect(registry.mainSessionAxisSupport("codex", "mod", "not-advertised")).toBe("unverified");
  });
  it.each([null, [], "supported", Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`mode-${i}`, mechanism()]))])("rejects malformed or excessive mechanism tables: %j", mainSession => {
    const value = descriptor(); value.capabilities.mainSession = mainSession;
    expect(validateDescriptor(value).errors.some(e => e.path === "capabilities.mainSession")).toBe(true);
  });
  it.each([
    { support: "supported", axes: {}, observation: undefined },
    { ...mechanism(), support: true },
    { ...mechanism(), axes: { model: "yes" } },
    { ...mechanism(), observation: { support: "supported", axes: { reasoning: true } } },
    { ...mechanism(), observedModel: "private-value-marker" },
  ])("rejects incomplete or invented control claims: %j", entry => {
    const value = descriptor(); value.capabilities.mainSession = { mod: entry };
    expect(validateDescriptor(value).errors.some(e => e.path.startsWith("capabilities.mainSession.mod"))).toBe(true);
  });
  it("rejects unsafe or excessive mechanism names and knowledge-source routing declarations", () => {
    for (const name of ["__proto__", "constructor", "prototype", "a".repeat(65), "not a mode"]) {
      const value = descriptor(); value.capabilities.mainSession = Object.fromEntries([[name, mechanism()]]);
      expect(validateDescriptor(value).errors.length).toBeGreaterThan(0);
    }
    const value = descriptor(); value.kind = "knowledge-source"; value.capabilities.mainSession = { mod: mechanism() };
    expect(validateDescriptor(value).errors.some(e => e.path === "capabilities.mainSession")).toBe(true);
  });
});
