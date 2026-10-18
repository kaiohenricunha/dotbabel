import { expect, it } from "vitest";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { input, model, evidence, requirement } from "./fixtures/model-intelligence/resolver.mjs";
const single = record => { const value = input(); value.catalog.runtimes[0].models = [record]; return value; };
it("accepts corroborating same-authority evidence instead of treating agreement as conflict", () => {
  const record = model("corroborated");
  for (const entries of Object.values(record.fields)) entries.push(structuredClone(entries[0]));
  expect(resolve(single(record))).toMatchObject({ status: "resolved", confidence: "high", configuration: { axes: { model: "corroborated", reasoning: "focused" } } });
});
it("preserves native authority over contradictory fresh knowledge without hiding stale native evidence", () => {
  const record = model("native-authority");
  record.fields.capabilities = [evidence({ reasoning: true, tool_call: true }, { provenance: { sourceId: "public-docs", sourceKind: "knowledge-source" } }), evidence({ reasoning: false, tool_call: true }, { freshness: "stale" })];
  const value = single(record);
  expect(resolve(value).diagnostics[0].code).toBe("insufficient_capability_evidence");
  value.policy.preferences.allow_stale_evidence = false;
  expect(resolve(value).status).toBe("resolved");
});
it("selects the freshest same-authority peer while retaining contradictory equal-age peers as unknown", () => {
  const record = model("current-native");
  record.fields.capabilities = [evidence({ reasoning: false, tool_call: true }, { freshness: "stale" }), evidence({ reasoning: true, tool_call: true })];
  expect(resolve(single(record)).status).toBe("resolved");
  record.fields.capabilities[0].freshness = "fresh";
  expect(resolve(single(record)).diagnostics[0].code).toBe("insufficient_capability_evidence");
});
it("does not let missing source metadata override a verified runtime peer", () => {
  const record = model("native-peer"); record.fields.capabilities.unshift(evidence({ reasoning: false }, { provenance: undefined }));
  expect(resolve(single(record)).status).toBe("resolved");
});
it("compares the worst used evidence age when ordering otherwise equally capable candidates", () => {
  const stale = model("a-partially-stale"); stale.fields.capabilities[0].freshness = "stale";
  const fresh = model("z-all-fresh"); const value = input(); value.catalog.runtimes[0].models = [stale, fresh];
  expect(resolve(value).configuration.axes.model).toBe("z-all-fresh");
});
it("does not lower confidence from an irrelevant native default after an exact effort pin", () => {
  const record = model("manual-effort"); record.fields.defaultReasoningLevel[0].confidence = "low";
  const value = single(record); value.invocation = { pin: { runtime: "codex", config: { model: record.model, reasoning: "calm" } } };
  expect(resolve(value).confidence).toBe("high");
  value.invocation.pin.config.reasoning = "focused";
  expect(resolve(value).confidence).toBe("low");
});
it.each(["mismatched-value", "foreign-source", "nonruntime", "missing-provenance"])("refuses unverified identity: %s", cause => {
  const record = model("native-identity"); const fact = record.fields.id[0];
  if (cause === "mismatched-value") fact.value = "another-model";
  else if (cause === "foreign-source") fact.provenance = { sourceKind: "runtime", sourceId: "claude" };
  else if (cause === "nonruntime") fact.provenance = { sourceKind: "knowledge-source", sourceId: "codex" };
  else delete fact.provenance;
  expect(resolve(single(record)).diagnostics[0].code).toBe("insufficient_capability_evidence");
});
it("keeps a missing class predicate unknown rather than inventing its capability", () => {
  const value = single(model("unknown-class")); value.policy = { ...value.policy, classes: { ...value.policy.classes, deep: { satisfied_by: null } } };
  expect(resolve(value).diagnostics[0].code).toBe("insufficient_capability_evidence");
});
it("enforces a factual false predicate independently of optional reasoning", () => {
  const withTools = model("a-tools"); const withoutTools = model("z-without-tools", "routine"); withoutTools.fields.capabilities[0].value.tool_call = false;
  const value = input({ requirement: requirement("mechanical") }); value.catalog.runtimes[0].models = [withTools, withoutTools];
  value.policy = { ...value.policy, classes: { ...value.policy.classes, mechanical: { satisfied_by: { reasoning: "optional", tool_call: false } } } };
  expect(resolve(value).configuration.axes.model).toBe("z-without-tools");
});
it("does not substitute a capable model when an exact pin has unknown semantic support", () => {
  const unavailable = model("unknown-pin"); delete unavailable.fields.capabilities;
  const value = input({ invocation: { pin: { runtime: "codex", config: { model: "unknown-pin" } } } }); value.catalog.runtimes[0].models.push(unavailable);
  expect(resolve(value).diagnostics[0].code).toBe("insufficient_capability_evidence");
});
it("rejects unsafe evidence-sourced effort without echoing the raw selector", () => {
  const record = model("unsafe-effort"); const unsafe = "bad\nprivate-marker";
  record.fields.supportedReasoningLevels[0].value = [{ effort: unsafe }]; record.fields.defaultReasoningLevel[0].value = unsafe;
  const result = resolve(single(record));
  expect(result.status).toBe("invalid"); expect(result.diagnostics[0].code).toBe("invalid_axis_value"); expect(JSON.stringify(result)).not.toContain("private-marker");
});
