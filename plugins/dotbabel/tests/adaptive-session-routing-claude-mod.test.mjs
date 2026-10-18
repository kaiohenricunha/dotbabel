import { describe, expect, it, vi } from "vitest";
import { registerClaudeRouting } from "../src/adaptive-session-routing/claude-mod.mjs";

const consume = async stream => {
  const chunks = [];
  let item = await stream.next();
  while (!item.done) { chunks.push(item.value); item = await stream.next(); }
  return { chunks, result: item.value };
};
function fixture(options = {}) {
  const hooks = new Map();
  const prepare = vi.fn(async () => ({ status: "proposed", changes: { model: "selected", reasoning: "high" }, confidence: "high", diagnostics: [] }));
  const reports = [];
  const errors = new Map();
  const $ = { session: { root: vi.fn(async () => "/project-a") }, ui: { log: vi.fn(text => reports.push(JSON.parse(text))) } };
  registerClaudeRouting((name, handler) => { hooks.set(name, handler); return { catch: handler => errors.set(name, handler) }; }, { prepare, manual: { model: { source: "inherited" }, reasoning: { source: "inherited" } }, ...options });
  const next = vi.fn(async function* (e) {
    yield { kind: "text", index: 0, text: "native response" };
    return { turnId: e.turnId, index: e.index, answer: "native response", toolUses: [], stopReason: "end_turn", usage: { model: e.model } };
  });
  const start = async (turnId = "one", text = "Implement payment integration tests.") => hooks.get("turn.start")($, { turnId, text }, vi.fn(async e => ({ turnId: e.turnId })));
  const step = (e = {}) => consume(hooks.get("turn.step")($, { turnId: "one", index: 0, model: "native", effort: "medium", messageCount: 4, ...e }, next));
  return { hooks, errors, $, prepare, next, start, step, reports };
}

describe("Claude MAIN mod boundary", () => {
  it("rewrites only MAIN axes once and passes every native chunk and result unchanged", async () => {
    const f = fixture(); await f.start(); const result = await f.step();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.prepare.mock.calls[0][0]).toMatchObject({ repoRoot: "/project-a", prompt: "Implement payment integration tests.", current: { axes: { model: "native", reasoning: "medium" } } });
    expect(f.next).toHaveBeenCalledExactlyOnceWith({ turnId: "one", index: 0, model: "selected", effort: "high", messageCount: 4 });
    expect(result.chunks).toEqual([{ kind: "text", index: 0, text: "native response" }]);
    expect(result.result.answer).toBe("native response");
    expect(f.hooks.has("tool.call")).toBe(false);
  });
  it("reuses the same turn decision across tool steps and never retries a failed native stream", async () => {
    const f = fixture(); await f.start(); await f.step(); await f.step({ index: 1, messageCount: 8 });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.next.mock.calls[1][0]).toMatchObject({ model: "selected", effort: "high", messageCount: 8 });
    f.next.mockImplementationOnce(async function* () { throw Error("native failure"); });
    await expect(f.step({ index: 2 })).rejects.toThrow("native failure");
    expect(f.next).toHaveBeenCalledTimes(3);
  });
  it("allows different decisions in the same session without resubmitting any prompt", async () => {
    const f = fixture(); await f.start(); await f.step();
    await f.hooks.get("turn.complete")(f.$, { turnId: "one", reason: "answer" }, async () => ({ text: "native" }));
    f.prepare.mockResolvedValueOnce({ status: "proposed", changes: { reasoning: "low" }, diagnostics: [] });
    await f.start("two", "Format the supplied JSON."); await f.step({ turnId: "two" });
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.next.mock.calls[1][0]).toMatchObject({ model: "native", effort: "low" });
  });
  it("leaves subagents and uncorrelated continuations untouched without classification", async () => {
    const f = fixture(); await f.start(); await f.step({ agentId: "worker", model: "worker-model", effort: "max" });
    await f.step({ turnId: "unrelated" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.next.mock.calls[0][0]).toMatchObject({ agentId: "worker", model: "worker-model", effort: "max" });
  });
  it.each(["preserved", "unavailable"])("preserves native configuration on %s or preparation failure", async status => {
    const f = fixture(); f.prepare.mockResolvedValueOnce({ status, diagnostics: [{ code: "routing_disabled" }] });
    await f.start(); await f.step();
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native", effort: "medium" });
    f.prepare.mockRejectedValueOnce(Error("private failure")); await f.start("two"); await f.step({ turnId: "two" });
    expect(JSON.stringify(f.reports)).not.toContain("private failure");
  });
  it("does not apply an old project's route after a project change, even within a tool loop", async () => {
    const f = fixture(); await f.start(); await f.step();
    f.$.session.root.mockResolvedValue("/project-b"); await f.step({ index: 1 });
    expect(f.next.mock.calls[1][0]).toMatchObject({ model: "native", effort: "medium" });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.reports.some(r => r.diagnostics?.some(d => d.code === "active_project_changed"))).toBe(true);
  });
  it("never executes a native request when the resolver reports a binding conflict", async () => {
    const f = fixture(); f.prepare.mockResolvedValue({ status: "blocked", diagnostics: [{ code: "pin_floor_conflict" }] });
    await f.start(); const result = await f.step();
    expect(f.next).not.toHaveBeenCalled();
    expect(result.result.usage).toBeNull();
    expect(result.chunks[0].text).toContain("pin_floor_conflict");
  });
  it("records actual response models separately and leaves effort unknown without native evidence", async () => {
    const f = fixture(); await f.start();
    f.next.mockImplementationOnce(async function* (e) { return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn", usage: { model: "provider-fallback" } }; });
    await f.step();
    const final = f.reports.at(-1);
    expect(final).toMatchObject({ intended: { model: "selected", reasoning: "high" }, effective: { state: "observed", axes: { model: "provider-fallback" } } });
    expect(final.effective.axes).not.toHaveProperty("reasoning");
    expect(final.accepted.state).toBe("unknown");
    await f.step({ index: 1, model: "provider-fallback", effort: "medium" });
    expect(f.next.mock.calls[1][0]).toMatchObject({ model: "provider-fallback", effort: "medium" });
  });
  it("keeps explicit manual selections independent and respects later manual changes", async () => {
    const f = fixture(); await f.start();
    await f.hooks.get("classic.PostModelSwitch")(f.$, { source: "picker", to_model: "chosen" }, async () => ({}));
    await f.step({ model: "chosen" });
    expect(f.prepare.mock.calls[0][0].manual.model).toEqual({ source: "manual", value: "chosen" });
    await f.hooks.get("config.set")(f.$, { key: "effortLevel", value: "low", origin: { kind: "composer" } }, async () => ({ value: "low" }));
    await f.step({ index: 1, model: "chosen", effort: "low" });
    expect(f.next.mock.calls[1][0]).toMatchObject({ model: "chosen", effort: "low" });
  });
  it("does not let diagnostic display failure replay or replace the native request", async () => {
    const f = fixture(); f.$.ui.log.mockImplementation(() => { throw Error("display"); });
    await f.start(); const result = await f.step(); expect(result.result.answer).toBe("native response"); expect(f.next).toHaveBeenCalledTimes(1);
  });
  it("forwards the exact original prompt and attachments once, without reading or copying attachment bytes", async () => {
    const f = fixture();
    const original = Object.freeze({ text: "Implement integration tests.", attachments: Object.freeze([{ type: "image", id: "native-opaque-id" }]), origin: { kind: "composer" }, wait: false });
    const next = vi.fn(async () => ({ text: original.text }));
    await f.hooks.get("prompt.submit")(f.$, original, next);
    expect(next).toHaveBeenCalledExactlyOnceWith(original);
    expect(next.mock.calls[0][0]).toBe(original);
  });
  it.each(["audio", "document"])("preserves native multimodal behavior when %s compatibility is unverified", async type => {
    const f = fixture(); await f.hooks.get("prompt.submit")(f.$, { text: "Implement integration tests.", attachments: [{ type }] }, async () => ({}));
    await f.start(); await f.step(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.next.mock.calls[0][0].model).toBe("native");
  });
  it("keeps unknown manual provenance conservative even when an injected strategy proposes both axes", async () => {
    const f = fixture({ manual: { model: { source: "unknown" }, reasoning: { source: "inherited" } } });
    await f.start(); await f.step(); expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native", effort: "high" });
  });
  it("rechecks project identity after asynchronous preparation and never revives the old turn route", async () => {
    const f = fixture(); f.prepare.mockImplementationOnce(async () => { f.$.session.root.mockResolvedValue("/b"); return { status: "proposed", changes: { model: "selected" } }; });
    await f.start(); await f.step(); expect(f.next.mock.calls[0][0].model).toBe("native");
    f.$.session.root.mockResolvedValue("/project-a"); await f.step({ index: 1 }); expect(f.next.mock.calls[1][0].model).toBe("native");
  });
  it("treats a native model picker as manual intent for both axes while passing the command unchanged", async () => {
    const f = fixture(); const command = { command: "model", args: "", origin: { kind: "composer" } };
    const next = vi.fn(async () => ({ text: "native picker" })); await f.hooks.get("command.run")(f.$, command, next);
    await f.start(); await f.step(); expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native", effort: "medium" }); expect(next).toHaveBeenCalledExactlyOnceWith(command);
  });
  it("answers a native hook timeout without any automatic provider replay", async () => {
    const f = fixture(); const next = vi.fn(); const fallback = await consume(f.errors.get("turn.step")(f.$, { turnId: "one", index: 0 }, next));
    expect(next).not.toHaveBeenCalled(); expect(fallback.result.usage).toBeNull(); expect(fallback.result.answer).toContain("No automatic retry");
  });
});
