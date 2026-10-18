import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { mergePolicy, SHIPPED_POLICY } from "../src/model-intelligence/policy/index.mjs";
import { WORKLOAD_CLASSES } from "../src/model-intelligence/domain/index.mjs";
import { input, model, requirement, evidence } from "./fixtures/model-intelligence/resolver.mjs";
const pin = (model, config = {}) => ({ mode: "pin", runtime: "codex", config: { model, ...config } });
const floor = requirement => ({ mode: "floor", requirement });
const policy = layers => mergePolicy({ shipped: SHIPPED_POLICY, ...layers });

describe("resolver constraint composition", () => {
  it("inherit contributes no constraint and keeps a user pin effective", () => {
    const result = resolve(input({ requirement: { mode: "inherit", binding: "consumer" }, policy: policy({ user: { pin: pin("deep-model") } }) }));
    expect(result.status).toBe("resolved"); expect(result.configuration.axes.model).toBe("deep-model");
    expect(resolve(input({ requirement: undefined })).configuration).toBeUndefined();
    expect(resolve(input({ requirement: { mode: "inherit", binding: "consumer" } })).status).toBe("unresolved");
  });
  it("a dynamic requirement accepts a user pin that satisfies it and reports conflict when it does not", () => {
    expect(resolve(input({ policy: policy({ user: { pin: pin("deep-model") } }) })).status).toBe("resolved");
    const r = resolve(input({ policy: policy({ user: { pin: pin("routine-model") } }) }));
    expect(r.status).toBe("conflict"); expect(r.enforcement.state).toBe("unsatisfied"); expect(r.configuration).toBeUndefined();
  });
  it("floors compose to the strongest applicable minimum across shipped, project, and artifact", () => {
    const p = mergePolicy({ shipped: { ...SHIPPED_POLICY, floor: floor("routine") }, project: { floor: floor("deep") } });
    const r = resolve(input({ requirement: requirement("frontier", "floor"), policy: p }));
    expect(r.status).toBe("resolved"); expect(r.configuration.axes.model).toBe("frontier-model");
  });
  it("an artifact pin overrides a user or project pin and records the shadowed pin", () => {
    const r = resolve(input({ requirement: requirement("deep", "pin", { pin: { runtime: "codex", config: { model: "frontier-model" } } }), policy: policy({ user: { pin: pin("deep-model") } }) }));
    expect(r.configuration.axes.model).toBe("frontier-model"); expect(r.explanation.some(x => x.code === "lower_scope_pin_shadowed")).toBe(true);
  });
  it("an invocation pin below an artifact floor returns conflict with enforcement unsatisfied", () => {
    const r = resolve(input({ requirement: requirement("frontier", "floor"), invocation: { pin: { runtime: "codex", config: { model: "routine-model" } } } }));
    expect(r).toMatchObject({ status: "conflict", enforcement: { state: "unsatisfied" } }); expect(r.diagnostics.map(x => x.code)).toContain("pin_floor_conflict");
  });
  it("an unavailable pin returns unresolved and never substitutes", () => {
    const r = resolve(input({ policy: policy({ user: { pin: pin("absent-model") } }) }));
    expect(r.status).toBe("unresolved"); expect(r.configuration).toBeUndefined(); expect(r.diagnostics.map(x => x.code)).toContain("pin_unavailable");
  });
  it("identical inputs produce a deep-equal result across 100 runs", () => {
    const value = input(); const before = structuredClone(value); const expected = resolve(value);
    for (let i = 0; i < 100; i++) expect(resolve(value)).toEqual(expected);
    expect(value).toEqual(before);
  });
  it("the module imports nothing from node:fs, node:child_process, or the sources directory", () => {
    const dir = new URL("../src/model-intelligence/resolver/", import.meta.url);
    for (const file of readdirSync(dir).filter(x => x.endsWith(".mjs"))) {
      // Remove only Stryker's generated helper functions, which read its environment.
      // Every application import and function remains subject to the purity check.
      const text = readFileSync(new URL(file, dir), "utf8").replace(/\bfunction stry(?:NS|Cov|MutAct)_[a-f0-9]+\([^\n]*\) \{[\s\S]*?^}\n/gm, "");
      expect(text).not.toMatch(/(?:from|import)\s*['"](?:node:(?:fs|child_process|http|https|os)|[^'"]*sources\/)/);
      expect(text).not.toMatch(/Date\.now|new Date|process\.env|Math\.random|fetch\(/);
    }
  });
  it("floor monotonicity — strengthening a floor never makes a previously too-weak configuration valid", () => {
    for (const lower of WORKLOAD_CLASSES) for (const upper of WORKLOAD_CLASSES.slice(WORKLOAD_CLASSES.indexOf(lower))) {
      for (const id of ["routine-model", "deep-model", "frontier-model", "exceptional-model"]) {
        const invocation = { pin: { runtime: "codex", config: { model: id } } };
        const weak = resolve(input({ requirement: requirement(lower, "floor"), invocation }));
        const strong = resolve(input({ requirement: requirement(upper, "floor"), invocation }));
        if (strong.status === "resolved") expect(weak.status).toBe("resolved");
      }
    }
  });
  it("pin safety — a pin below an effective floor is never a successful resolution, for any precedence", () => {
    for (const scope of ["user", "project", "artifact", "invocation"]) {
      const value = input({ requirement: requirement("frontier", "floor") });
      if (scope === "invocation") value.invocation = { pin: pin("routine-model") };
      else value.policy = policy({ [scope]: { pin: pin("routine-model") } });
      expect(resolve(value).status, scope).toBe("conflict");
    }
  });
  it("inheritance neutrality — adding an inherit declaration changes no requirement", () => {
    const value = input({ requirement: undefined, policy: policy({ project: { floor: floor("deep") } }) });
    const a = resolve(value), b = resolve({ ...value, requirement: { mode: "inherit", binding: "self" } });
    expect(b.configuration).toEqual(a.configuration); expect(b.status).toBe(a.status);
  });
  it("rejects malformed normalized input as a structured invalid result", () => {
    for (const value of [null, {}, input({ requirement: requirement("genius") }), input({ target: { runtimeId: "fake", artifactKind: "agent" } }), input({ requirement: requirement("deep", "pin", { pin: { runtime: "claude", config: { model: "x" } } }) })]) {
      expect(resolve(value).status).toBe("invalid");
    }
  });
  it("never guesses opaque selector structure or unsupported effort values", () => {
    const value = input(); value.catalog.runtimes[0].models = [model("provider/model#opaque", "deep")];
    expect(resolve(value).configuration.axes.model).toBe("provider/model#opaque");
    value.invocation = { pin: { runtime: "codex", config: { model: "provider/model#opaque", reasoning: "fictional" } } };
    expect(resolve(value).status).toBe("conflict");
    value.invocation.pin.config = { selector: "provider/model#opaque" };
    expect(resolve(value).status).toBe("unresolved");
  });
  it("rejects unsafe selected axis values before producing runtime configuration", () => {
    for (const id of ["-unexpected-option", "bad\nmodel", "x".repeat(201)]) {
      const value = input(); value.catalog.runtimes[0].models = [model(id)];
      const result = resolve(value);
      expect(result.status, id).toBe("invalid");
      expect(result.configuration).toBeUndefined();
    }
  });
  it("does not treat public catalog existence as local model availability", () => {
    const value = input(); value.catalog.models = [{ provider: "openai", model: "public-model", fields: model("public-model").fields }]; value.catalog.runtimes = [];
    expect(resolve(value).status).toBe("unresolved");
  });
  it("preserves uncertainty when required capability evidence is missing or contradictory", () => {
    for (const fields of [{}, { capabilities: [evidence({ reasoning: true, tool_call: true }), evidence({ reasoning: false, tool_call: false })] }]) {
      const value = input(); value.catalog.runtimes[0].models = [{ model: "unknown", fields }];
      expect(resolve(value).status).toBe("unresolved");
    }
  });
});
