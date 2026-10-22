import { describe, expect, it } from "vitest";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { input, model, evidence, requirement } from "./fixtures/model-intelligence/resolver.mjs";

// A model with every capability flag that Frontier checks, but no reviewed class evidence.
const unreviewed = id => { const record = model(id, "exceptional"); record.fields.capabilities = [evidence({ reasoning: true, tool_call: true })]; return record; };
const only = (...records) => { const value = input(); value.catalog.runtimes[0].models = records; return value; };

describe("reviewed class support for Frontier and Exceptional", () => {
  it("does not satisfy Frontier from capability flags and effort tiers alone", () => {
    const value = only(unreviewed("flag-only")); value.requirement = requirement("frontier", "floor");
    const result = resolve(value);
    expect(result.status).not.toBe("resolved");
    expect(result.diagnostics.map(entry => entry.code)).toContain("insufficient_capability_evidence");
  });

  it("reports a pin without reviewed class support as an unsatisfied Frontier floor", () => {
    const value = only(unreviewed("flag-only"), model("reviewed", "frontier")); value.requirement = requirement("frontier", "floor");
    value.invocation = { pin: { runtime: "codex", config: { model: "flag-only" } } };
    const result = resolve(value);
    expect(result.status).not.toBe("resolved");
    expect(result.configuration).toBeUndefined();
  });

  it("satisfies Frontier when the model carries a reviewed class_support fact", () => {
    const value = only(model("reviewed", "frontier")); value.requirement = requirement("frontier", "floor");
    expect(resolve(value)).toMatchObject({ status: "resolved", configuration: { axes: { model: "reviewed" } } });
  });

  it("requires the exact class: Frontier evidence does not satisfy Exceptional", () => {
    const value = only(model("frontier-only", "frontier")); value.requirement = requirement("exceptional", "floor");
    expect(resolve(value).status).not.toBe("resolved");
    value.catalog.runtimes[0].models = [model("both", "exceptional")];
    expect(resolve(value)).toMatchObject({ status: "resolved", configuration: { axes: { model: "both" } } });
  });

  it("never infers class support from a model name", () => {
    const value = only(unreviewed("opus"), unreviewed("claude-fable-5-1")); value.requirement = requirement("frontier", "floor");
    expect(resolve(value).status).not.toBe("resolved");
  });

  it("leaves Deep and lower classes on capability flags", () => {
    const value = only(unreviewed("flag-only")); value.requirement = requirement("deep", "floor");
    expect(resolve(value)).toMatchObject({ status: "resolved", configuration: { axes: { model: "flag-only" } } });
  });
});

describe("release snapshot class support", async () => {
  const { readSnapshot, snapshotCatalog } = await import("../src/model-intelligence/snapshot/index.mjs");
  const { mergePolicy, SHIPPED_POLICY } = await import("../src/model-intelligence/policy/index.mjs");
  const snapshot = readSnapshot();
  const floor = (model, requirement, sourcePath) => resolve({ requirement: { mode: "floor", requirement, binding: "self" }, target: { runtimeId: "claude", artifactKind: "agent", sourcePath }, catalog: snapshotCatalog(snapshot), policy: mergePolicy({ shipped: SHIPPED_POLICY }), runtimeContract: snapshot.runtimes.claude.runtimeContract, invocation: { pin: { runtime: "claude", config: { model } }, omitDefaultReasoning: true } });
  it.each(["haiku", "claude-haiku-5-5", "sonnet", "claude-sonnet-5-5"])("a %s pin cannot satisfy a security Frontier floor", model => {
    const result = floor(model, "frontier", "agents/security-auditor.md");
    expect(result.status).toBe("conflict"); expect(result.enforcement.state).toBe("unsatisfied"); expect(result.configuration).toBeUndefined();
  });
  it.each([["opus", "frontier"], ["claude-opus-5-5", "frontier"], ["fable", "frontier"], ["fable", "exceptional"], ["claude-fable-5-1", "exceptional"]])("a %s pin satisfies %s from reviewed evidence", (model, requirement) => {
    expect(floor(model, requirement, "agents/security-auditor.md")).toMatchObject({ status: "resolved", enforcement: { state: "enforced" }, configuration: { axes: { model } } });
  });
  it("Opus does not satisfy Exceptional", () => {
    expect(floor("opus", "exceptional", "agents/workflow-orchestrator.md").enforcement.state).toBe("unsatisfied");
  });
});
