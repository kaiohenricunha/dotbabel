import { describe, it, expect } from "vitest";
import * as gemini from "../src/model-intelligence/sources/runtime/gemini.mjs";
import { validateDescriptor } from "../src/model-intelligence/sources/contract.mjs";
import { makeResolvedRuntimeConfiguration } from "../src/model-intelligence/domain/index.mjs";
import { SOURCE_ADAPTERS } from "../src/model-intelligence/sources/index.mjs";
import { fixedNow } from "./fixtures/model-intelligence/fake-runner.mjs";

// A context whose runner fails the test if the adapter ever starts a process.
const spawnGuard = () => {
  const calls = [];
  return { calls, ctx: { runCommand: async (spec) => { calls.push(spec); throw new Error("the Gemini adapter must not start a process"); }, env: { PATH: "/usr/bin", GEMINI_API_KEY: "fixture-credential-never-forwarded" }, homeDir: "/home/nobody", now: fixedNow } };
};
const make = (runtimeId, axes) => makeResolvedRuntimeConfiguration({ runtimeId, axes, representation: { kind: "native-id", provenance: { sourceId: runtimeId, sourceKind: "runtime" } } });

describe("Gemini runtime source adapter (P-22a)", () => {
  it("descriptor matches the measured capability row of DOC-2 for gemini", () => {
    expect(validateDescriptor(gemini.descriptor).errors).toEqual([]);
    expect(gemini.RUNTIME_ID).toBe("gemini");
    const capabilities = gemini.descriptor.capabilities;
    // DOC-2: no model enumeration, authentication before any model handling, skill model/effort IGNORED.
    expect(capabilities.discovery).toEqual({ support: "unsupported" });
    expect(capabilities.observation).toEqual({ support: "unsupported" });
    expect(capabilities.validation).toEqual({ support: "unsupported" });
    // `-m/--model` exists; there is no user-facing effort flag.
    expect(capabilities.invocation).toEqual({ support: "supported", axes: { model: "supported", reasoning: "unsupported" } });
  });

  it("binding for skill stays unsupported, the DOC-2 IGNORED measurement", () => {
    expect(gemini.descriptor.capabilities.binding).toEqual({ skill: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } } });
  });

  it("discover() reports unsupported instead of an empty list that would read as no models", async () => {
    const { calls, ctx } = spawnGuard();
    const result = await gemini.discover(ctx);
    expect(result.status).toBe("unsupported");
    expect(result.diagnostic.code).toBe("no_enumeration");
    expect(result.provenance).toMatchObject({ sourceId: "gemini", sourceKind: "runtime", adapterVersion: gemini.ADAPTER_VERSION });
    expect(calls).toHaveLength(0);
  });

  it("observe() and validate() report unsupported, because authentication precedes model handling", async () => {
    const { calls, ctx } = spawnGuard();
    for (const result of [await gemini.observe(ctx), await gemini.validate({ model: "gemini-pro" }, ctx)]) {
      expect(result.status).toBe("unsupported");
      expect(result.diagnostic.code).toBe("credential_required");
      expect(JSON.stringify(result)).not.toMatch(/fixture-credential-never-forwarded/);
    }
    expect(calls).toHaveLength(0);
  });

  it("validate() rejects input that names no axis, a caller-contract breach", async () => {
    await expect(gemini.validate({}, spawnGuard().ctx)).rejects.toThrow(/model/);
  });

  it("renderInvocation() returns structured argv before any shell string", () => {
    const invocation = gemini.renderInvocation(make("gemini", { model: "gemini-pro" }));
    expect(invocation).toMatchObject({ runtimeId: "gemini", command: "gemini", args: ["-m", "gemini-pro"], unsupportedAxes: [] });
    expect(typeof invocation.args).not.toBe("string");
  });

  it("renderInvocation() names the reasoning axis as unsupported rather than dropping it", () => {
    expect(gemini.renderInvocation(make("gemini", { model: "gemini-pro", reasoning: "high" }))).toMatchObject({ args: ["-m", "gemini-pro"], unsupportedAxes: ["reasoning"] });
  });

  it("renderInvocation() throws on a configuration for another runtime or an invalid value", () => {
    expect(() => gemini.renderInvocation(make("codex", { model: "gemini-pro" }))).toThrow(/gemini/);
    expect(() => gemini.renderInvocation({ runtimeId: "gemini", axes: { model: "-x; rm -rf /" } })).toThrow();
  });

  it("the adapter never writes under the runtime configuration root (SEC-1): it starts no process at all", async () => {
    const { calls, ctx } = spawnGuard();
    await gemini.discover(ctx); await gemini.observe(ctx); await gemini.validate({ model: "gemini-pro" }, ctx);
    expect(calls).toHaveLength(0);
  });

  it("ships as a source adapter after the existing runtimes", () => {
    const ids = SOURCE_ADAPTERS.map((module) => module.descriptor.id);
    expect(ids).toContain("gemini");
    expect(ids.indexOf("gemini")).toBeGreaterThan(ids.indexOf("codex"));
  });
});
