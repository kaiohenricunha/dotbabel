import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as domain from "../src/model-intelligence/domain/index.mjs";
import { RUNTIMES } from "../src/agents.mjs";

const DOMAIN_SOURCE = fileURLToPath(new URL("../src/model-intelligence/domain/index.mjs", import.meta.url));

const VOCABULARIES = {
  WORKLOAD_CLASSES: ["mechanical", "routine", "deep", "frontier", "exceptional"],
  BINDINGS: ["self", "session", "consumer"],
  RESOLUTION_MODES: ["dynamic", "floor", "pin", "inherit"],
  SUPPORT_STATES: ["supported", "unsupported", "unverified"],
  ADAPTER_RESULT_STATUSES: ["ok", "unsupported", "unavailable", "unknown"],
  FRESHNESS_STATES: ["fresh", "stale", "expired", "unknown"],
  REFRESH_STATES: ["idle", "in_progress"],
  AVAILABILITY_STATES: ["available", "unavailable", "unknown"],
  RESOLVER_STATUSES: ["resolved", "unresolved", "conflict", "invalid"],
  ENFORCEMENT_STATES: ["enforced", "satisfied-not-enforced", "unsatisfied", "unknown"],
  ENFORCEMENT_BASES: ["artifact-binding", "session-observation", "invocation", "none"],
  REPRESENTATION_KINDS: ["stable-alias", "native-id", "opaque-selector"],
  ARTIFACT_KINDS: ["agent", "command", "skill", "workflow"],
  SOURCE_KINDS: ["runtime", "knowledge-source", "artifact"],
};

describe("model-intelligence domain vocabulary", () => {
  it("exports frozen enums for workload classes, bindings, modes, support states, result statuses, freshness, refresh states, and enforcement states", () => {
    for (const [name, values] of Object.entries(VOCABULARIES)) {
      expect(domain[name], name).toEqual(values);
      expect(Object.isFrozen(domain[name]), `${name} is frozen`).toBe(true);
    }
  });

  it("workload classes are ordered mechanical < routine < deep < frontier < exceptional and compare by rank only", () => {
    const { compareWorkloadClass, satisfiesWorkloadClass, WORKLOAD_CLASSES } = domain;
    for (let i = 0; i < WORKLOAD_CLASSES.length; i++) {
      for (let j = 0; j < WORKLOAD_CLASSES.length; j++) {
        expect(Math.sign(compareWorkloadClass(WORKLOAD_CLASSES[i], WORKLOAD_CLASSES[j]))).toBe(Math.sign(i - j));
      }
    }
    expect(satisfiesWorkloadClass("frontier", "deep")).toBe(true);
    expect(satisfiesWorkloadClass("deep", "deep")).toBe(true);
    expect(satisfiesWorkloadClass("routine", "deep")).toBe(false);
    // Rank is an ordering, never a numeric model score: no rank number is exported.
    expect(Object.values(domain).some((value) => typeof value === "number")).toBe(false);
    expect(() => compareWorkloadClass("deep", "genius")).toThrow(/unknown workload class/);
  });

  it("each vocabulary has unique values, and support state, adapter status, and freshness are separate vocabularies", () => {
    for (const [name, values] of Object.entries(VOCABULARIES)) {
      expect(new Set(domain[name]).size, `${name} has no duplicate`).toBe(values.length);
    }
    // §5: static support ≠ current operation outcome ≠ freshness. The words overlap on purpose
    // ("unsupported", "unknown"), so the vocabularies must stay distinct objects and distinct sets.
    const { SUPPORT_STATES, ADAPTER_RESULT_STATUSES, FRESHNESS_STATES } = domain;
    expect(SUPPORT_STATES).not.toBe(ADAPTER_RESULT_STATUSES);
    expect(SUPPORT_STATES).not.toEqual(ADAPTER_RESULT_STATUSES);
    expect(ADAPTER_RESULT_STATUSES).not.toEqual(FRESHNESS_STATES);
    expect(ADAPTER_RESULT_STATUSES).not.toContain("stale");
    expect(ADAPTER_RESULT_STATUSES).not.toContain("refresh_in_progress");
    expect(SUPPORT_STATES).not.toContain("unavailable");
  });

  it("domain module has no import of node:fs, node:child_process, node:http, or node:os", () => {
    const source = readFileSync(DOMAIN_SOURCE, "utf8");
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    const forbidden = /^(node:)?(fs|fs\/promises|child_process|http|https|net|os)$/;
    expect(imports.filter((specifier) => forbidden.test(specifier))).toEqual([]);
    expect(source).not.toMatch(/\bprocess\.env\b|\bDate\.now\(|\bnew Date\(/);
  });

  it("Provenance and ResolvedRuntimeConfiguration constructors reject unknown fields", () => {
    const { makeProvenance, makeResolvedRuntimeConfiguration } = domain;
    const provenance = makeProvenance({ sourceId: "codex", sourceKind: "runtime", sourceVersion: "0.154.0" });
    expect(provenance).toEqual({ sourceId: "codex", sourceKind: "runtime", sourceVersion: "0.154.0" });
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(() => makeProvenance({ sourceId: "codex", sourceKind: "runtime", account: "someone" })).toThrow(/unknown field "account"/);
    expect(() => makeProvenance({ sourceKind: "runtime" })).toThrow(/sourceId/);
    expect(() => makeProvenance({ sourceId: "codex", sourceKind: "vendor" })).toThrow(/sourceKind/);

    const configuration = makeResolvedRuntimeConfiguration({
      runtimeId: "claude",
      axes: { model: "opus", effort: "high" },
      representation: { kind: "stable-alias", provenance },
    });
    expect(configuration.axes).toEqual({ model: "opus", effort: "high" });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.axes)).toBe(true);
    expect(() => makeResolvedRuntimeConfiguration({ runtimeId: "claude", axes: { model: "opus" }, representation: { kind: "stable-alias", provenance }, score: 9 })).toThrow(/unknown field "score"/);
    expect(() => makeResolvedRuntimeConfiguration({ runtimeId: "claude", axes: {}, representation: { kind: "stable-alias", provenance } })).toThrow(/axes/);
    expect(() => makeResolvedRuntimeConfiguration({ runtimeId: "claude", axes: { model: "opus" }, representation: { kind: "guess", provenance } })).toThrow(/representation\.kind/);
  });

  it("runtime ids come from the RUNTIMES registry and are not redeclared", () => {
    expect(domain.RUNTIME_IDS).toEqual(Object.keys(RUNTIMES));
    expect(domain.isRuntimeId("opencode")).toBe(true);
    expect(domain.isRuntimeId("anthropic")).toBe(false);
    expect(() => domain.makeResolvedRuntimeConfiguration({
      runtimeId: "anthropic",
      axes: { model: "x" },
      representation: { kind: "native-id", provenance: domain.makeProvenance({ sourceId: "x", sourceKind: "runtime" }) },
    })).toThrow(/runtimeId/);
  });
});

describe("model-intelligence domain shape guards", () => {
  it("rejects a non-object where a shape is required", async () => {
    const { makeProvenance, makeResolvedRuntimeConfiguration } = await import("../src/model-intelligence/domain/index.mjs");
    for (const value of [null, "codex", 7, ["codex"]]) {
      expect(() => makeProvenance(value)).toThrow(/Provenance must be an object/);
    }
    const provenance = makeProvenance({ sourceId: "codex", sourceKind: "runtime" });
    for (const representation of [null, "stable-alias", []]) {
      expect(() => makeResolvedRuntimeConfiguration({ runtimeId: "codex", axes: { model: "m" }, representation })).toThrow(/representation must be an object/);
    }
    for (const axes of [null, "model", ["model"]]) {
      expect(() => makeResolvedRuntimeConfiguration({ runtimeId: "codex", axes, representation: { kind: "native-id", provenance } })).toThrow(/axes/);
    }
  });

  it("carries an artifact source kind so a declaration cannot pose as a runtime observation", async () => {
    const { SOURCE_KINDS, makeProvenance } = await import("../src/model-intelligence/domain/index.mjs");
    expect(SOURCE_KINDS).toContain("artifact");
    // A canonical declaration states its own requirement; no adapter observed it.
    // Consumers read `runtime` as "observed from a harness", so the two must differ.
    const declared = makeProvenance({ sourceId: "skills/probe/SKILL.md", sourceKind: "artifact" });
    expect(declared.sourceKind).toBe("artifact");
    expect(declared.adapterVersion).toBeUndefined();
    expect(() => makeProvenance({ sourceId: "x", sourceKind: "declaration" })).toThrow(/sourceKind/);
  });

  it("rejects a non-string version field in provenance", async () => {
    const { makeProvenance } = await import("../src/model-intelligence/domain/index.mjs");
    expect(() => makeProvenance({ sourceId: "codex", sourceKind: "runtime", sourceVersion: 154 })).toThrow(/sourceVersion must be a string/);
    expect(() => makeProvenance({ sourceId: "codex", sourceKind: "runtime", adapterVersion: {} })).toThrow(/adapterVersion must be a string/);
  });
});
