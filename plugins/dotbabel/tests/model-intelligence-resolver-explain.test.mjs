import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { input, model, requirement } from "./fixtures/model-intelligence/resolver.mjs";
const codes = result => result.explanation.map(x => x.code);
const observed = model => ({ runtimeId: "codex", configurationBasis: "as-run", turnExecuted: true, axes: { model }, usage: [], fieldSources: { "axes.model": "recorded-effective-model" } });
describe("resolver enforcement confidence and explanation", () => {
  it("reports enforced with basis artifact-binding when the runtime contract binds the axis at the artifact kind", () => {
    expect(resolve(input())).toMatchObject({ status: "resolved", enforcement: { state: "enforced", basis: "artifact-binding" } });
  });
  it("reports satisfied-not-enforced with basis session-observation when only the observed session satisfies a skill requirement", () => {
    expect(resolve(input({ target: { runtimeId: "codex", artifactKind: "skill" }, requirement: requirement("deep", "dynamic", { binding: "consumer" }), observed: observed("frontier-model") }))).toMatchObject({ enforcement: { state: "satisfied-not-enforced", basis: "session-observation" } });
  });
  it("reports unsatisfied when the observed session is below a floor", () => {
    expect(resolve(input({ target: { runtimeId: "codex", artifactKind: "skill" }, requirement: requirement("frontier", "floor", { binding: "consumer" }), observed: observed("routine-model") }))).toMatchObject({ status: "resolved", enforcement: { state: "unsatisfied", basis: "session-observation" } });
  });
  it("reports unknown when neither binding nor observation exists, and never upgrades it", () => {
    const value = input({ target: { runtimeId: "codex", artifactKind: "skill" }, requirement: requirement("deep", "dynamic", { binding: "consumer" }) });
    expect(resolve(value).enforcement.state).toBe("unknown");
    value.observed = { ...observed("deep-model"), configurationBasis: "reconstructed", reconstructedFrom: [] };
    expect(resolve(value).enforcement.state).toBe("unknown");
    value.observed = { ...observed("deep-model"), runtimeId: "claude" };
    expect(resolve(value).enforcement.state).toBe("unknown");
  });
  it("lowers confidence when stale evidence is used and records stale_evidence_used", () => {
    const value = input(); value.catalog.runtimes[0].models = [model("old-model")];
    for (const entries of Object.values(value.catalog.runtimes[0].models[0].fields)) for (const e of entries) { e.freshness = "stale"; e.confidence = "medium"; }
    const r = resolve(value); expect(r.status).toBe("resolved"); expect(r.confidence).not.toBe("high"); expect(codes(r)).toContain("stale_evidence_used");
    value.policy = { ...value.policy, preferences: { ...value.policy.preferences, allow_stale_evidence: false } };
    expect(resolve(value).status).toBe("unresolved");
  });
  it("explanation is ordered and every reason has a code", () => {
    const r = resolve(input({ requirement: requirement("deep", "floor") }));
    expect(codes(r).indexOf("artifact_floor_applied")).toBeLessThan(codes(r).indexOf("artifact_binding_supported"));
    expect(r.explanation.length).toBeGreaterThan(1);
    for (const reason of r.explanation) { expect(reason.code).toMatch(/^[a-z][a-z_]+$/); expect(reason.message).toBeTypeOf("string"); }
    expect(resolve(input({ requirement: requirement("deep", "floor") })).explanation).toEqual(r.explanation);
  });
  it("provider-churn fixture: adding or removing a discoverable model changes the resolution with 0 source changes", () => {
    const value = input(); value.catalog.runtimes[0].models = [model("native-a")];
    expect(resolve(value).configuration.axes.model).toBe("native-a");
    value.catalog.runtimes[0].models = [model("native-b")];
    expect(resolve(value).configuration.axes.model).toBe("native-b");
    value.catalog.runtimes[0].models = [];
    expect(resolve(value).status).toBe("unresolved");
  });
  it("every valid fixture case returns a structured result with no uncaught exception and no silent fallback", () => {
    for (const level of ["mechanical", "routine", "deep", "frontier", "exceptional"]) for (const kind of ["agent", "skill", "command", "workflow"]) {
      const r = resolve(input({ requirement: requirement(level), target: { runtimeId: "codex", artifactKind: kind } }));
      expect(r.status).toBe("resolved"); expect(r.confidence).toMatch(/^(high|medium|low)$/); expect(Array.isArray(r.diagnostics)).toBe(true);
    }
  });
  it("resolve() p95 is at most 10 ms over 1,000 warmed calls on the 500-record six-runtime fixture, explanation included", () => {
    const value = input(); value.catalog.runtimes = ["claude", "codex", "gemini", "antigravity", "copilot", "opencode"].map((runtimeId, index) => ({ runtimeId, models: Array.from({ length: index < 2 ? 84 : 83 }, (_, n) => model(`opaque-${index}-${String(n).padStart(3, "0")}`, n % 2 ? "deep" : "frontier")) }));
    expect(value.catalog.runtimes.reduce((n, r) => n + r.models.length, 0)).toBe(500);
    for (let i = 0; i < 20; i++) resolve(value);
    const samples = Array.from({ length: 1000 }, () => { const start = performance.now(); const result = resolve(value); const elapsed = performance.now() - start; expect(result.status).toBe("resolved"); return elapsed; }).sort((a,b) => a-b);
    expect(samples[949]).toBeLessThanOrEqual(10);
  });
  it("keeps a known pin unresolved when its semantic capability is unknown", () => {
    const value = input();
    const candidate = model("unknown-model"); delete candidate.fields.capabilities;
    value.catalog.runtimes[0].models = [candidate];
    value.invocation = { pin: { runtime: "codex", config: { model: "unknown-model" } } };
    expect(resolve(value).status).toBe("unresolved");
  });
  it("never turns missing observed capability evidence into a known floor violation", () => {
    const value = input({ target: { runtimeId: "codex", artifactKind: "skill" }, requirement: requirement("deep", "floor", { binding: "consumer" }), observed: observed("unknown-model") });
    const unknown = model("unknown-model"); delete unknown.fields.capabilities;
    value.catalog.runtimes[0].models.push(unknown);
    expect(resolve(value).enforcement.state).toBe("unknown");
  });
  it("honors fresher-evidence preferences only after hard constraints are satisfied", () => {
    const value = input(); const old = model("old-model", "deep"), fresh = model("fresh-model", "frontier");
    for (const entries of Object.values(old.fields)) for (const fact of entries) { fact.freshness = "stale"; fact.confidence = "medium"; }
    value.catalog.runtimes[0].models = [old, fresh];
    expect(resolve(value).configuration.axes.model).toBe("fresh-model");
    value.policy = { ...value.policy, preferences: { ...value.policy.preferences, prefer_fresher_evidence: false } };
    expect(resolve(value).configuration.axes.model).toBe("old-model");
  });
  it("does not call an invocation capability artifact enforcement for a dynamic command", () => {
    const value = input({ requirement: requirement("deep", "dynamic", { binding: "session" }), target: { runtimeId: "codex", artifactKind: "command" } });
    value.runtimeContract.binding.command = { support: "supported", axes: { model: "supported", reasoning: "supported" } };
    expect(resolve(value).enforcement.state).toBe("unknown");
  });
  it("reports every unavailable or unverified binding truthfully", () => {
    const value = input(); value.runtimeContract.binding.agent.axes.reasoning = "unverified";
    const result = resolve(value); expect(result.enforcement.state).toBe("unknown"); expect(result.diagnostics.map(x => x.code)).toContain("binding_unverified");
  });
});
