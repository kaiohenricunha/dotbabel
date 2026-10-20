import { describe, expect, it, vi } from "vitest";
import { createClaudeSessionInputLoader } from "../src/model-intelligence/cli/claude-session-input.mjs";
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
  it.each([
    ["a successful model turn", value => { value.evidence.turnExecuted = true; }],
    ["unknown execution", value => { delete value.evidence.turnExecuted; }],
    ["another runtime version", value => { value.evidence.runtimeVersion = "9.9.9"; }],
    ["missing runtime version", value => { delete value.evidence.runtimeVersion; }],
    ["another source", value => { value.provenance.sourceId = "codex"; }],
    ["provider-only provenance", value => { value.provenance.sourceKind = "knowledge-source"; }],
    ["unmatched source version", value => { value.provenance.sourceVersion = "9.9.9"; }],
    ["missing observation time", value => { delete value.observedAt; }],
    ["future observation", value => { value.observedAt = "2026-10-18T18:00:00.001Z"; }],
    ["stale observation", value => { value.observedAt = "2026-10-18T11:59:59.999Z"; }],
    ["failed probe with otherwise valid fields", value => { value.status = "unavailable"; }],
  ])("never accepts %s as live native eligibility", async (label, change) => {
    const f = fixture(); const value = await f.observe(); f.observe.mockClear(); change(value); f.observe.mockResolvedValue(value);
    await expect(f.loader.load("/project", native())).rejects.toMatchObject({ code: "native_catalog_unavailable" });
    await expect(f.loader.load("/project")).rejects.toMatchObject({ code: "native_catalog_required" });
  });
  it.each([
    value => { value.selectors = ["valid", 23]; }, value => { value.selectors = [""]; },
    value => { value.selectors = ["x".repeat(201)]; }, value => { value.selectors = ["invisible\u200bvalue"]; },
    value => { value.observedAt = "2026-10-18T18:00:00.001Z"; },
    value => { value.observedAt = "2026-10-18T11:59:59.999Z"; },
    value => { value.providerPages = null; }, value => { value.providerPages = []; },
    value => { value.providerPages = Array(11).fill({ data: [], has_more: false }); },
    value => { value.providerPages[0].padding = "x".repeat(1048576); },
  ])("rejects malformed and over-bound native catalogs before a probe", async change => {
    const f = fixture(); const payload = native(); change(payload);
    await expect(f.loader.load("/project", payload)).rejects.toMatchObject({ code: "native_catalog_invalid" }); expect(f.observe).not.toHaveBeenCalled();
  });
  it.each([[null], [{ data: [], has_more: false }], [native().providerPages[0], native().providerPages[0]]])("rejects malformed, empty or unconsumed provider pages", async providerPages => {
    const f = fixture(); await expect(f.loader.load("/project", { ...native(), providerPages })).rejects.toMatchObject({ code: "native_catalog_invalid" }); expect(f.observe).not.toHaveBeenCalled();
  });
  it("accepts exact selector length and count boundaries without reading a model name as policy", async () => {
    const f = fixture(); const selectors = ["x".repeat(200), ...Array.from({ length: 31 }, (_, index) => `opaque-${index}`)];
    const value = await f.loader.load("/project", { ...native(), selectors }); expect(value.catalog.runtimes[0].models).toHaveLength(1);
    expect(f.observe).toHaveBeenCalledTimes(32); expect(f.observe.mock.calls[0][0].model).toBe(selectors[0]);
  });
  it("does not promote a contradictory provider capability through retained documentation", async () => {
    const f = fixture(); const payload = native(); payload.providerPages[0].data[0].capabilities.thinking.supported = false;
    const value = await f.loader.load("/project", payload); const facts = value.catalog.runtimes[0].models[0].fields.capabilities;
    expect(facts[0].value).toEqual({ reasoning: false }); expect(facts[0].provenance.sourceId).toBe("anthropic-models-api");
  });
  it("does not count future provider effort levels as verified native controls", async () => {
    const f = fixture(); const payload = native(); payload.providerPages[0].data[0].capabilities.effort.future = { supported: true };
    const value = await f.loader.load("/project", payload);
    expect(value.catalog.runtimes[0].models[0].fields.supportedReasoningLevels[0].value.map(level => level.effort)).toEqual(["high", "low", "medium"]);
  });
  it.each(["capabilities", "supportedReasoningLevels"])("retains unknown native %s facts rather than throwing or inventing them", async key => {
    const snapshot = structuredClone(readSnapshot()); delete snapshot.runtimes.claude.models.find(item => item.model === model).fields[key];
    const f = fixture({ snapshot }); const value = await f.loader.load("/project", native());
    if (key === "capabilities") expect(value.catalog.runtimes[0].models[0].fields.capabilities[0].value).toEqual({ reasoning: true });
    else expect(value.catalog.runtimes[0].models[0].fields).not.toHaveProperty(key);
  });
  it("expires at the oldest provider observation instead of renewing it with a later selector probe", async () => {
    let time = clock; const f = fixture({ now: () => time });
    await f.loader.load("/project", { ...native(), observedAt: "2026-10-18T12:10:00.000Z" });
    time = "2026-10-18T18:10:00.000Z"; await expect(f.loader.load("/project")).resolves.toBeDefined();
    time = "2026-10-18T18:10:00.001Z"; await expect(f.loader.load("/project")).rejects.toMatchObject({ code: "native_catalog_required" });
  });
  it("bounds the session to eight independent project catalogs and permits refreshing an existing one", async () => {
    const f = fixture(); for (let index = 0; index < 8; index++) await f.loader.load(`/project-${index}`, native());
    await expect(f.loader.load("/project-8", native())).rejects.toMatchObject({ code: "session_project_limit" });
    expect(f.observe).toHaveBeenCalledTimes(8); await expect(f.loader.load("/project-0", native())).resolves.toBeDefined();
  });
  it("a failed explicit candidate preserves the prior valid catalog", async () => {
    const f = fixture(); const original = await f.loader.load("/project", native());
    await expect(f.loader.load("/project", { ...native(), providerPages: [] })).rejects.toMatchObject({ code: "native_catalog_invalid" });
    expect((await f.loader.load("/project")).catalog).toEqual(original.catalog);
  });
  it("stops selector collection at its whole-operation budget without probing another selector", async () => {
    let elapsed = 0; const f = fixture({ monotonic: () => elapsed }); const response = await f.observe(); f.observe.mockClear();
    f.observe.mockImplementation(async () => { elapsed += 5000; return structuredClone(response); });
    await f.loader.load("/project", { ...native(), selectors: ["one", "two", "three"] });
    expect(f.observe).toHaveBeenCalledTimes(2); expect(f.observe.mock.calls.map(([args]) => args.timeoutMs)).toEqual([10000, 5000]);
  });
});
