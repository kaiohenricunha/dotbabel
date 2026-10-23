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
  it("retains the actually observed model across prompts while keeping the native UI baseline separate", async () => {
    const f = fixture(); await f.start(); await f.step();
    await f.hooks.get("turn.complete")(f.$, { turnId: "one", reason: "answer" }, async () => ({}));
    f.prepare.mockResolvedValueOnce({ status: "preserved", configuration: { axes: { model: "selected", reasoning: "high" } }, changes: {}, diagnostics: [{ code: "current_model_retained" }] });
    await f.start("two"); await f.step({ turnId: "two" });
    expect(f.prepare.mock.calls[1][0].current).toMatchObject({ axes: { model: "selected" }, turnExecuted: true });
    expect(f.prepare.mock.calls[1][0].nativeAxes).toEqual({ model: "native", reasoning: "medium" });
    expect(f.next.mock.calls[1][0]).toMatchObject({ model: "selected", effort: "high" });
  });
  it("does not label an unknown or restored native conversation as a verified cold thread", async () => {
    const f = fixture(); await f.hooks.get("command.run")(f.$, { command: "resume", args: "", origin: { kind: "composer" } }, async () => ({}));
    await f.start(); await f.step(); expect(f.prepare.mock.calls[0][0].current.turnExecuted).not.toBe(false);
  });
  it("uses native Stop effort evidence only for a correlated MAIN response and reports observation rather than completion", async () => {
    // The turn sent the session's own effort, so the session setting that Stop reports is what ran.
    const f = fixture({ prepare: vi.fn(async () => ({ status: "proposed", changes: { model: "selected" }, confidence: "high", diagnostics: [] })) });
    await f.start(); await f.step();
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "selected", effort: "medium" });
    await f.hooks.get("classic.Stop")(f.$, { effort: { level: "medium" } }, async () => ({}));
    expect(f.reports.at(-1)).toMatchObject({ status: "observed", effective: { state: "observed", axes: { model: "selected", reasoning: "medium" }, reasoningSource: "classic.Stop:effort.level" } });
    const count = f.reports.length;
    await f.hooks.get("classic.Stop")(f.$, { agent_id: "worker", effort: { level: "low" } }, async () => ({}));
    expect(f.reports).toHaveLength(count);
  });
  it("never reports the session effort from Stop as effective when the turn rewrote the effort (AC-11)", async () => {
    // #572: classic.Stop reports the session setting, not the effort of a rewritten request.
    const f = fixture(); await f.start(); await f.step();
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "selected", effort: "high" });
    const count = f.reports.length;
    await f.hooks.get("classic.Stop")(f.$, { effort: { level: "medium" } }, async () => ({}));
    expect(f.reports).toHaveLength(count);
    expect(f.reports.at(-1).effective).toEqual({ state: "observed", axes: { model: "selected" }, source: "turn.step:usage.model" });
    // The next turn starts from the observed model only, never from the session effort.
    await f.hooks.get("turn.complete")(f.$, { turnId: "one", reason: "answer" }, async () => ({}));
    await f.start("two"); await f.step({ turnId: "two" });
    expect(f.prepare.mock.calls[1][0].current.axes).toEqual({ model: "selected" });
  });
  it("does not turn the read-only effort status command into a manual override", async () => {
    const f = fixture(); const event = { command: "effort", args: "status", origin: { kind: "composer" } };
    const next = vi.fn(async () => ({})); await f.hooks.get("command.run")(f.$, event, next);
    await f.start(); await f.step();
    expect(f.prepare.mock.calls[0][0].manual.reasoning).toEqual({ source: "inherited" });
    expect(f.next.mock.calls[0][0].effort).toBe("high"); expect(next).toHaveBeenCalledExactlyOnceWith(event);
  });
  it("does not reapply a turn route after a native automatic fallback before usage is returned", async () => {
    const f = fixture(); await f.start(); await f.step();
    await f.hooks.get("classic.PostModelSwitch")(f.$, { source: "auto", to_model: "fallback" }, async () => ({}));
    await f.step({ index: 1, model: "fallback", effort: "low" });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.next.mock.calls[1][0]).toMatchObject({ model: "fallback", effort: "low" });
    expect(f.reports.at(-1).status).toBe("preserved");
    expect(f.reports.at(-1).accepted.state).toBe("unknown");
  });
  it("reports a provider substitution as preserved rather than an accepted automatic proposal", async () => {
    const f = fixture(); await f.start();
    f.next.mockImplementationOnce(async function* () { return { usage: { model: "fallback" } }; });
    await f.step();
    expect(f.reports.at(-1)).toMatchObject({ status: "preserved", effective: { state: "observed", axes: { model: "fallback" } } });
  });
  it.each(["command", "picker", "sdk"])("retains an explicit %s model independently from automatic effort", async source => {
    const f = fixture(); const event = { source, to_model: "manual-model" }; const next = vi.fn(async () => ({ native: true }));
    expect(await f.hooks.get("classic.PostModelSwitch")(f.$, event, next)).toEqual({ native: true });
    await f.start(); await f.step({ model: "manual-model" });
    expect(f.prepare.mock.calls[0][0].manual.model).toEqual({ source: "manual", value: "manual-model" });
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "manual-model", effort: "high" });
    expect(next).toHaveBeenCalledExactlyOnceWith(event);
  });
  it.each(["auto", "resume", "future"])("does not invent manual intent from a %s model event", async source => {
    const f = fixture(); await f.hooks.get("classic.PostModelSwitch")(f.$, { source, to_model: "other" }, async () => ({}));
    await f.start(); await f.step(); expect(f.prepare.mock.calls[0][0].manual.model).toEqual({ source: "inherited" });
  });
  it.each(["model", "effort", "effortLevel", "thinking"])("ignores denied and plugin-owned %s config mutations", async key => {
    const f = fixture(); const denied = { key, origin: { kind: "composer" } };
    await f.hooks.get("config.set")(f.$, denied, async () => ({ deny: true, value: "low" }));
    await f.hooks.get("config.set")(f.$, { key, origin: { kind: "plugin" } }, async () => ({ value: "low" }));
    await f.start(); await f.step();
    expect(f.prepare.mock.calls[0][0].manual).toEqual({ model: { source: "inherited" }, reasoning: { source: "inherited" } });
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "selected", effort: "high" });
  });
  it.each(["effort", "effortLevel", "thinking"])("retains an accepted native %s selection", async key => {
    const f = fixture(); const event = { key, value: "requested", origin: { kind: "bridge" } };
    const next = vi.fn(async () => ({ value: "low" })); expect(await f.hooks.get("config.set")(f.$, event, next)).toEqual({ value: "low" });
    await f.start(); await f.step({ effort: "low" });
    expect(f.prepare.mock.calls[0][0].manual.reasoning).toEqual({ source: "manual", value: "low" });
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "selected", effort: "low" });
  });
  it.each([0, null, "", "-flag", "x\u0000", "x\u200d", "x".repeat(201)])("treats invalid native effort as unknown: %j", async value => {
    const f = fixture(); await f.hooks.get("config.set")(f.$, { key: "thinking" }, async () => ({ value }));
    await f.start(); await f.step(); expect(f.prepare.mock.calls[0][0].manual.reasoning).toEqual({ source: "unknown" });
    expect(f.next.mock.calls[0][0].effort).toBe("medium");
  });
  it.each(["model", "effort"])("ignores plugin-origin %s commands", async command => {
    const f = fixture(); await f.hooks.get("command.run")(f.$, { command, args: "", origin: { kind: "plugin" } }, async () => ({}));
    await f.start(); await f.step(); expect(f.next.mock.calls[0][0]).toMatchObject({ model: "selected", effort: "high" });
  });
  it("preserves accepted native model changes with unknown provenance without freezing effort", async () => {
    const f = fixture(); await f.hooks.get("config.set")(f.$, { key: "model" }, async () => ({ value: "native-chosen" }));
    await f.start(); await f.step({ model: "native-chosen" });
    expect(f.prepare.mock.calls[0][0].manual.model).toEqual({ source: "unknown" });
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native-chosen", effort: "high" });
  });
  it.each(["startup", "resume", "clear", "compact", "fork"])("tracks %s lifecycle without assuming restored conversations are cold", async source => {
    const f = fixture({ freshSession: true }); await f.hooks.get("classic.SessionStart")(f.$, { source }, async () => ({}));
    await f.start(); await f.step();
    expect(f.prepare.mock.calls[0][0].current.turnExecuted).toBe(["startup", "clear"].includes(source) ? false : undefined);
  });
  it("does not let a worker lifecycle, configuration change or model switch change MAIN", async () => {
    const f = fixture({ freshSession: true });
    await f.hooks.get("classic.SessionStart")(f.$, { source: "resume", agent_id: "worker" }, async () => ({}));
    await f.hooks.get("classic.ConfigChange")(f.$, { agent_id: "worker" }, async () => ({}));
    await f.hooks.get("classic.PostModelSwitch")(f.$, { source: "picker", to_model: "worker", agent_id: "worker" }, async () => ({}));
    await f.start(); await f.step();
    expect(f.prepare.mock.calls[0][0].current.turnExecuted).toBe(false);
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "selected", effort: "high" });
  });
  it("latches a main native configuration change for both axes", async () => {
    const f = fixture(); await f.hooks.get("classic.ConfigChange")(f.$, {}, async () => ({}));
    await f.start(); await f.step();
    expect(f.prepare.mock.calls[0][0].manual).toEqual({ model: { source: "unknown" }, reasoning: { source: "unknown" } });
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native", effort: "medium" });
  });
  it.each(["", "-flag", "x\u0000", "x\u200d", "x".repeat(201), 3])("never sends an invalid proposed axis to the native engine: %j", async value => {
    const f = fixture(); f.prepare.mockResolvedValue({ status: "proposed", changes: { model: value, reasoning: value } });
    await f.start(); await f.step(); expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native", effort: "medium" });
  });
  it("accepts bounded opaque model values without interpreting their names", async () => {
    const f = fixture(); const model = "z".repeat(200); f.prepare.mockResolvedValue({ status: "proposed", changes: { model } });
    await f.start(); await f.step(); expect(f.next.mock.calls[0][0].model).toBe(model);
  });
  it("never reroutes if the first observed MAIN step is already a continuation", async () => {
    const f = fixture(); await f.start(); await f.step({ index: 1 });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.reports[0].diagnostics).toEqual([{ code: "turn_boundary_unverified" }]);
    expect(f.next.mock.calls[0][0].model).toBe("native");
  });
  it("preserves unknown roots and passes the native input unchanged", async () => {
    const f = fixture(); f.$.session.root.mockRejectedValue(Error("private root failure")); await f.start(); await f.step();
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native", effort: "medium" });
    expect(JSON.stringify(f.reports)).not.toContain("private root failure");
  });
  it("limits failure context to 20 and resets it only after a correlated main answer", async () => {
    const f = fixture();
    for (let index = 0; index < 23; index++) {
      await f.start(String(index)); await f.step({ turnId: String(index) });
      expect(f.prepare.mock.calls.at(-1)[0].context.priorFailures).toBe(Math.min(index, 20));
      await f.hooks.get("turn.complete")(f.$, { turnId: String(index), reason: "error" }, async () => ({}));
    }
    await f.start("answer"); await f.step({ turnId: "answer" });
    await f.hooks.get("turn.complete")(f.$, { turnId: "foreign", reason: "answer" }, async () => ({}));
    await f.hooks.get("turn.complete")(f.$, { turnId: "answer", agentId: "worker", reason: "answer" }, async () => ({}));
    await f.hooks.get("turn.complete")(f.$, { turnId: "answer", reason: "cancelled" }, async () => ({}));
    await f.start("again"); await f.step({ turnId: "again" }); expect(f.prepare.mock.calls.at(-1)[0].context.priorFailures).toBe(20);
    await f.hooks.get("turn.complete")(f.$, { turnId: "again", reason: "answer" }, async () => ({}));
    await f.start("reset"); await f.step({ turnId: "reset" }); expect(f.prepare.mock.calls.at(-1)[0].context.priorFailures).toBe(0);
  });
  it("reports unknown effective values when a native request returns no model evidence", async () => {
    const f = fixture(); f.next.mockImplementationOnce(async function* () { return { usage: null }; });
    await f.start(); await f.step();
    expect(f.reports.at(-1)).toMatchObject({ envelope: "ClaudeRouting", version: 1, accepted: { state: "unknown" }, effective: { state: "unknown" } });
    const count = f.reports.length; await f.hooks.get("classic.Stop")(f.$, { effort: { level: "high" } }, async () => ({}));
    expect(f.reports).toHaveLength(count);
  });
  it("starts with unknown execution and manual lineage unless the launcher supplies proof", async () => {
    const f = fixture({ manual: undefined }); await f.start(); await f.step();
    const input = f.prepare.mock.calls[0][0]; expect(input.current).not.toHaveProperty("turnExecuted");
    expect(input.manual).toEqual({ model: { source: "unknown" }, reasoning: { source: "unknown" } });
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native", effort: "medium" });
  });
  it("uses the native preparation boundary's independent manual provenance", async () => {
    const f = fixture(); f.prepare.mockResolvedValueOnce({ status: "proposed", changes: { model: "selected", reasoning: "high" }, manual: { model: { source: "manual", value: "native" }, reasoning: { source: "inherited" } } });
    await f.start(); await f.step(); expect(f.next.mock.calls[0][0]).toMatchObject({ model: "native", effort: "high" });
    await f.start("two"); await f.step({ turnId: "two" }); expect(f.prepare.mock.calls[1][0].manual.model).toEqual({ source: "manual", value: "native" });
  });
  it("does not replace manual intent that changes during asynchronous preparation", async () => {
    const f = fixture(); f.prepare.mockImplementationOnce(async () => {
      await f.hooks.get("classic.PostModelSwitch")(f.$, { source: "picker", to_model: "manual-now" }, async () => ({}));
      await f.hooks.get("config.set")(f.$, { key: "effortLevel" }, async () => ({ value: "low" }));
      return { status: "proposed", changes: { model: "selected", reasoning: "high" }, manual: { model: { source: "inherited" }, reasoning: { source: "inherited" } } };
    });
    await f.start(); await f.step({ model: "manual-now", effort: "low" });
    expect(f.next.mock.calls[0][0]).toMatchObject({ model: "manual-now", effort: "low" });
    await f.start("two"); await f.step({ turnId: "two", model: "manual-now", effort: "low" });
    expect(f.prepare.mock.calls[1][0].manual).toEqual({ model: { source: "manual", value: "manual-now" }, reasoning: { source: "manual", value: "low" } });
  });
  it.each(["resume", "fork", "compact"])("clears an observed execution when %s restores another conversation", async command => {
    const f = fixture(); await f.start(); await f.step();
    await f.hooks.get("command.run")(f.$, { command, args: "" }, async () => ({}));
    await f.start("two"); await f.step({ turnId: "two" });
    expect(f.prepare.mock.calls[1][0].current).toEqual({ axes: { model: "native", reasoning: "medium" } });
  });
  it.each([["effort", "low", { model: "selected", effort: "medium" }], ["model", "chosen", { model: "native", effort: "high" }], ["effort", " status ", { model: "selected", effort: "high" }]])("distinguishes command intent from status: %s %s", async (command, args, expected) => {
    const f = fixture(); await f.hooks.get("command.run")(f.$, { command, args }, async () => ({}));
    await f.start(); await f.step(); expect(f.next.mock.calls[0][0]).toMatchObject(expected);
  });
  it("does not replace MAIN state when the native engine starts a worker turn", async () => {
    const f = fixture(); await f.start(); const event = { agentId: "worker", turnId: "worker", text: "private worker" }; const next = vi.fn(async () => ({ turnId: "worker" }));
    expect(await f.hooks.get("turn.start")(f.$, event, next)).toEqual({ turnId: "worker" });
    await f.step(); expect(f.prepare.mock.calls[0][0].prompt).toBe("Implement payment integration tests.");
    expect(next).toHaveBeenCalledExactlyOnceWith(event);
  });
  it.each([undefined, [], [{ type: "image" }]])("keeps supported or absent attachments eligible for ordinary preparation", async attachments => {
    const f = fixture(); const input = { text: "original", attachments };
    await f.hooks.get("prompt.submit")(f.$, input, async () => ({})); await f.start(); await f.step();
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it("preserves mixed media and does not forget unverified conversation media on the next prompt", async () => {
    const f = fixture(); await f.hooks.get("prompt.submit")(f.$, { attachments: [{ type: "image" }, { type: "document" }] }, async () => ({}));
    await f.start(); await f.step(); await f.hooks.get("prompt.submit")(f.$, {}, async () => ({}));
    await f.start("two"); await f.step({ turnId: "two" }); expect(f.prepare).not.toHaveBeenCalled();
    expect(f.reports[0]).toMatchObject({ status: "preserved", diagnostics: [{ code: "input_modality_unverified" }], effective: { state: "unknown" } });
  });
  it("passes an uncorrelated step and a Stop event without inventing an active MAIN turn", async () => {
    const f = fixture(); await f.step(); await f.hooks.get("classic.Stop")(f.$, {}, async () => ({}));
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.reports).toEqual([]);
  });
  it.each([undefined, [], [{ code: "-private" }], [{ code: "valid\nprivate" }], [{ code: "a".repeat(102) }]])("uses a stable local block result when diagnostics have no safe code", async diagnostics => {
    const f = fixture(); f.prepare.mockResolvedValue({ status: "blocked", diagnostics }); await f.start(); const result = await f.step();
    const answer = "Routing blocked: resolution_unavailable. No model request was sent.";
    expect(result).toEqual({ chunks: [{ kind: "text", index: 0, text: answer }], result: { turnId: "one", index: 0, answer, toolUses: [], stopReason: "end_turn", usage: null } });
    expect(f.reports).toEqual([{ envelope: "ClaudeRouting", version: 1, status: "blocked", diagnostics: [{ code: "resolution_unavailable" }], effective: { state: "unknown" } }]);
    expect(f.next).not.toHaveBeenCalled();
  });
  it("returns the complete native local-answer protocol after interruption without any retry", async () => {
    const f = fixture(); const result = await consume(f.errors.get("turn.step")(f.$, { turnId: "one", index: 4 }));
    expect(result.result).toMatchObject({ turnId: "one", index: 4, toolUses: [], stopReason: "end_turn", usage: null });
    expect(result.chunks).toEqual([{ kind: "text", index: 0, text: result.result.answer }]);
    expect(f.reports).toEqual([{ envelope: "ClaudeRouting", version: 1, status: "interrupted", diagnostics: [{ code: "native_routing_interrupted" }], effective: { state: "unknown" } }]);
  });
});
