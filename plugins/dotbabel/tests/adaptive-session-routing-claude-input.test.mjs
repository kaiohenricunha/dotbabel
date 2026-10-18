import { describe, expect, it, vi } from "vitest";
import { createClaudeSessionInputLoader } from "../src/adaptive-session-routing/claude-input.mjs";
import { readSnapshot } from "../src/model-intelligence/snapshot/index.mjs";
import { prepareRoute } from "../src/adaptive-session-routing/prepare.mjs";
import { SHIPPED_POLICY } from "../src/model-intelligence/policy/index.mjs";

const clock = "2026-10-18T18:00:00.000Z";
const version = "2.1.302";
const model = "claude-haiku-5-5";
const native = () => ({ version, selectors: ["small"], observedAt: clock, providerPages: [{ data: [{ id: model, capabilities: { thinking: { supported: true }, image_input: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true } } } }], has_more: false }] });
function fixture(options = {}) {
  const observe = vi.fn(async () => ({ status: "ok", provenance: { sourceId: "claude", sourceKind: "runtime", sourceVersion: version, adapterVersion: "3" }, observedAt: clock, evidence: { axes: { model }, runtimeVersion: version, turnExecuted: false } }));
  const loadPolicy = vi.fn(() => ({ shipped: SHIPPED_POLICY }));
  const loader = createClaudeSessionInputLoader({ observe, loadPolicy, snapshot: readSnapshot(), now: () => clock, ...options });
  return { loader, observe, loadPolicy };
}
describe("Claude session resolver input", () => {
  it("resolves semantic effort for a real shared-resolver route rather than only constructing native facts", async () => {
    const f = fixture(); await f.loader.load("/project", native());
    const decision = await prepareRoute({ repoRoot: "/project", prompt: "Format the supplied JSON with two-space indentation.", runtimeCapability: { support: "supported", axes: { model: "supported", reasoning: "supported" } }, current: { axes: {}, turnExecuted: false }, manual: { model: { source: "inherited" }, reasoning: { source: "inherited" } } }, { readActivation: async () => ({ enabled: true, routingEnabled: true }), loadResolverInput: f.loader.load });
    expect(decision).toMatchObject({ status: "proposed", changes: { model, reasoning: "low" } });
  });
  it("requires native evidence instead of using release eligibility as live availability", async () => {
    const f = fixture(); await expect(f.loader.load("/project")).rejects.toMatchObject({ code: "native_catalog_required" });
    expect(f.observe).not.toHaveBeenCalled();
  });
  it("joins current native selector mappings, provider facts and exact reviewed documentation", async () => {
    const f = fixture(); const input = await f.loader.load("/project", native());
    expect(input.target).toEqual({ runtimeId: "claude", artifactKind: "workflow" });
    expect(input.catalog.scope).not.toBe("release");
    const candidate = input.catalog.runtimes[0].models[0];
    expect(candidate.model).toBe(model);
    expect(candidate.fields.id[0]).toMatchObject({ availability: "available", freshness: "fresh", provenance: { sourceKind: "runtime" } });
    expect(candidate.fields.capabilities[0].value).toEqual({ tool_call: true, reasoning: true });
    expect(candidate.fields.selectionVisibility[0].value).toBe("listed");
    expect(candidate.fields.supportedReasoningLevels[0].value).toEqual([{ effort: "high", intent: "high", order: 2 }, { effort: "low", intent: "low", order: 0 }, { effort: "medium", intent: "medium", order: 1 }]);
    expect(input.invocation.requiredModalities).toEqual(["text", "image"]);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: "small" }));
  });
  it("uses a bounded session cache but reads each project's policy independently", async () => {
    const f = fixture(); await f.loader.load("/a", native()); await f.loader.load("/a");
    expect(f.observe).toHaveBeenCalledTimes(1); expect(f.loadPolicy).toHaveBeenCalledTimes(2);
    await expect(f.loader.load("/b")).rejects.toMatchObject({ code: "native_catalog_required" });
  });
  it.each(["9.9.9", undefined])("rejects an unmeasured native version %s", async nativeVersion => {
    const f = fixture(); await expect(f.loader.load("/project", { ...native(), version: nativeVersion })).rejects.toMatchObject({ code: "routing_unverified" });
    expect(f.observe).not.toHaveBeenCalled();
  });
  it("does not invent runtime availability from provider API membership or a failed probe", async () => {
    const f = fixture(); f.observe.mockResolvedValue({ status: "unknown" });
    await expect(f.loader.load("/project", native())).rejects.toMatchObject({ code: "native_catalog_unavailable" });
  });
  it("rejects mismatched native versions and canonical identities not reported by the provider", async () => {
    const f = fixture(); f.observe.mockResolvedValueOnce({ status: "ok", evidence: { axes: { model: "unlisted" }, runtimeVersion: version, turnExecuted: false } });
    await expect(f.loader.load("/project", native())).rejects.toMatchObject({ code: "native_catalog_unavailable" });
  });
  it("keeps unknown tools unknown for a newly introduced provider model", async () => {
    const fresh = "future-provider-model"; const f = fixture(); const payload = native(); payload.providerPages[0].data[0].id = fresh;
    f.observe.mockResolvedValueOnce({ status: "ok", provenance: { sourceId: "claude", sourceKind: "runtime", sourceVersion: version, adapterVersion: "3" }, observedAt: clock, evidence: { axes: { model: fresh }, runtimeVersion: version, turnExecuted: false } });
    const input = await f.loader.load("/project", payload);
    expect(input.catalog.runtimes[0].models[0].fields.capabilities[0].value).not.toHaveProperty("tool_call");
  });
  it("expires old native/provider evidence without renewing retained documentation dates", async () => {
    let now = clock; const f = fixture({ now: () => now }); await f.loader.load("/project", native());
    now = "2026-10-19T01:00:00.000Z";
    await expect(f.loader.load("/project")).rejects.toMatchObject({ code: "native_catalog_required" });
  });
  it.each([[], Array(33).fill("a"), ["--permission-mode=bypassPermissions"], ["bad\nselector"]])("rejects invalid selector lists without invoking the runtime", async selectors => {
    const f = fixture(); await expect(f.loader.load("/project", { ...native(), selectors })).rejects.toMatchObject({ code: "native_catalog_invalid" });
    expect(f.observe).not.toHaveBeenCalled();
  });
});
