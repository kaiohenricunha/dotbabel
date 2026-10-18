import { describe, it, expect, vi } from "vitest";
import { createCodexTurnRouter } from "../src/adaptive-session-routing/codex.mjs";
import { input, model, evidence } from "./fixtures/model-intelligence/resolver.mjs";

const current = { axes: { model: "native-a", reasoning: "medium" } };
const inherited = { model: { source: "inherited" }, reasoning: { source: "inherited" } };
const capability = { support: "supported", axes: { model: "supported", reasoning: "supported" } };
const proposal = (model = "native-b", reasoning = "high") => ({ status: "proposed", changes: { model, reasoning }, confidence: "high", diagnostics: [] });
function setup(options = {}) {
  let turns = 0;
  const request = vi.fn(async () => ({ turn: { id: `turn-${++turns}`, status: "completed" } }));
  const prepare = vi.fn(async () => proposal());
  const router = createCodexTurnRouter({ threadId: "thread-1", repoRoot: "/project", current, manual: inherited, runtimeCapability: capability, request, prepare, ...options });
  return { router, request, prepare };
}
const submission = (text = "Implement integration tests for payments.") => ({ threadId: "thread-1", input: [{ type: "text", text, text_elements: [] }], approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" }, approvalsReviewer: "user", disabledPluginIds: ["user-disabled"] });

describe("Codex main-session submission routing", () => {
  it("routes an ordinary main-session prompt before execution", async () => {
    const { router, request, prepare } = setup();
    const original = submission(); const before = structuredClone(original);
    const result = await router.submit("submission-1", original);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0][0].prompt).toBe(original.input[0].text);
    expect(request).toHaveBeenCalledExactlyOnceWith("turn/start", { ...original, model: "native-b", effort: "high" });
    expect(original).toEqual(before);
    expect(result).toMatchObject({ status: "accepted", requested: { model: "native-b", reasoning: "high" }, accepted: { turnId: "turn-1" }, effective: { state: "unknown" } });
  });
  it("two configurations retain the same thread and original input exactly once", async () => {
    const { router, request, prepare } = setup();
    prepare.mockResolvedValueOnce(proposal("native-a", "medium")).mockResolvedValueOnce(proposal("native-b", "high"));
    const first = submission("Implement the bounded integration tests.");
    first.input.push({ type: "image", url: "data:image/png;base64,cGl4ZWw=", detail: "auto" });
    const second = submission("Investigate the authentication race.");
    await router.submit("first", first); await router.submit("second", second);
    expect(request.mock.calls).toEqual([["turn/start", { ...first, model: "native-a", effort: "medium" }], ["turn/start", { ...second, model: "native-b", effort: "high" }]]);
    expect(request.mock.calls.every(([, params]) => params.threadId === "thread-1")).toBe(true);
    expect(request.mock.calls[0][1].input).toEqual(first.input);
  });
  it.each([{ model: null }, { effort: null }, { model: null, effort: null }])("preserves nullable native override parameters during a conservative fallback", async overrides => {
    const { router, request } = setup({ prepare: async () => ({ status: "preserved", diagnostics: [{ code: "routing_disabled" }] }) });
    const original = { ...submission(), ...overrides }; const before = structuredClone(original);
    const outcome = await router.submit("native-null", original);
    expect(outcome).toMatchObject({ status: "accepted", requested: {}, effective: { state: "unknown" } });
    expect(request).toHaveBeenCalledExactlyOnceWith("turn/start", before);
    expect(original).toEqual(before);
  });
  it("keeps a manual effort while a nullable model inherits automatic selection", async () => {
    const { router, request } = setup();
    const outcome = await router.submit("independent-null", { ...submission(), model: null, effort: "low" });
    expect(outcome).toMatchObject({ status: "accepted", requested: { model: "native-b", reasoning: "low" } });
    expect(request.mock.calls[0][1]).toMatchObject({ model: "native-b", effort: "low" });
  });
  it("deduplicates concurrent and completed submissions without replay", async () => {
    const { router, request } = setup();
    const one = router.submit("same", submission());
    const two = router.submit("same", submission("This changed input must not execute."));
    expect(await one).toEqual(await two);
    await router.submit("same", submission());
    expect(request).toHaveBeenCalledOnce();
  });
  it("never retries a submission whose transport outcome is uncertain", async () => {
    const { router, request } = setup(); request.mockRejectedValue(new Error("private transport detail"));
    const result = await router.submit("uncertain", submission());
    expect(result).toMatchObject({ status: "uncertain", diagnostics: [{ code: "native_submission_unknown" }] });
    expect(JSON.stringify(result)).not.toContain("private transport detail");
    expect(await router.submit("uncertain", submission())).toEqual(result);
    expect(request).toHaveBeenCalledOnce();
  });
  it("preserves explicit model and effort independently and remembers manual intent", async () => {
    const { router, request, prepare } = setup();
    await router.submit("manual-model", { ...submission(), model: "person-model" });
    expect(request.mock.calls[0][1]).toMatchObject({ model: "person-model", effort: "high" });
    expect(prepare.mock.calls[0][0].manual.model).toEqual({ source: "manual", value: "person-model" });
    await router.submit("next", submission());
    expect(request.mock.calls[1][1].model).toBe("person-model");
    const other = setup(); await other.router.submit("manual-effort", { ...submission(), effort: "low" });
    expect(other.request.mock.calls[0][1]).toMatchObject({ model: "native-b", effort: "low" });
  });
  it("does not execute a decision that proves a mandatory floor violation", async () => {
    const { router, prepare, request } = setup(); prepare.mockResolvedValue({ status: "blocked", diagnostics: [{ code: "pin_floor_conflict" }] });
    expect(await router.submit("blocked", submission())).toMatchObject({ status: "blocked" });
    expect(request).not.toHaveBeenCalled();
  });
  it("forwards a preserved route without adding native overrides", async () => {
    const { router, prepare, request } = setup(); prepare.mockResolvedValue({ status: "preserved", diagnostics: [{ code: "routing_disabled" }] });
    const original = submission(); await router.submit("disabled", original);
    expect(request).toHaveBeenCalledExactlyOnceWith("turn/start", original);
  });
  it("rejects another thread and malformed submission identifiers before preparation", async () => {
    const { router, prepare, request } = setup();
    expect(await router.submit("wrong", { ...submission(), threadId: "other-thread" })).toMatchObject({ status: "blocked" });
    for (const id of ["", null, "x".repeat(257)]) expect(await router.submit(id, submission())).toMatchObject({ status: "blocked" });
    expect(prepare).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it("does not evict deduplication entries when the bounded ledger fills", async () => {
    const { router, request } = setup({ maxSubmissions: 1 });
    await router.submit("first", submission());
    expect(await router.submit("second", submission())).toMatchObject({ status: "blocked", diagnostics: [{ code: "submission_ledger_full" }] });
    await router.submit("first", submission()); expect(request).toHaveBeenCalledOnce();
  });
  it("does not treat a malformed acknowledgement as effective execution", async () => {
    const { router, request } = setup(); request.mockResolvedValue({});
    expect(await router.submit("bad-ack", submission())).toMatchObject({ status: "uncertain", effective: { state: "unknown" } });
    expect(request).toHaveBeenCalledOnce();
  });
  it("waits for native completion before routing another main turn", async () => {
    const { router, request, prepare } = setup();
    request.mockResolvedValueOnce({ turn: { id: "active", status: "inProgress" } });
    await router.submit("first", submission());
    expect(await router.submit("second", submission())).toMatchObject({ status: "blocked", diagnostics: [{ code: "submission_in_progress" }] });
    expect(request).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
    router.notify({ method: "turn/completed", params: { threadId: "other", turn: { id: "active", status: "completed" } } });
    expect(await router.submit("second", submission())).toMatchObject({ status: "blocked" });
    router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "active", status: "completed" } } });
    expect(await router.submit("second", submission())).toMatchObject({ status: "accepted" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("handles a native completion notification before the start acknowledgement", async () => {
    const { router, request } = setup();
    request.mockImplementationOnce(async () => {
      router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "fast", status: "completed" } } });
      return { turn: { id: "fast", status: "inProgress" } };
    });
    expect(await router.submit("first", submission())).toMatchObject({ status: "accepted", accepted: { turnId: "fast" } });
    expect(await router.submit("second", submission())).toMatchObject({ status: "accepted" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([["new-turn", "old-turn"], ["old-turn", "new-turn"]])("retains a matching early completion across notification order %s then %s", async (first, second) => {
    const { router, request } = setup();
    request.mockImplementationOnce(async () => {
      for (const id of [first, second]) router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id, status: "completed" } } });
      return { turn: { id: "new-turn", status: "inProgress" } };
    });
    await router.submit("first", submission());
    expect(await router.submit("second", submission())).toMatchObject({ status: "accepted" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("reports completion evidence overflow without erasing a retained match", async () => {
    const { router, request } = setup();
    request.mockImplementationOnce(async () => {
      for (const id of ["new-turn", ...Array.from({ length: 80 }, (_, index) => `old-${index}`)]) router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id, status: "completed" } } });
      return { turn: { id: "new-turn", status: "inProgress" } };
    });
    const first = await router.submit("first", submission());
    expect(first.diagnostics).toContainEqual({ code: "native_completion_buffer_full" });
    const next = await router.submit("second", submission());
    expect(next.status).toBe("accepted");
    expect(next.diagnostics).not.toContainEqual({ code: "native_completion_buffer_full" });
  });
  it.each([31, 32])("bounds early completion evidence after %i distinct prior completions", async count => {
    const { router, request } = setup();
    request.mockImplementationOnce(async () => {
      for (const id of [...Array.from({ length: count }, (_, index) => `old-${index}`), "new-turn"]) router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id, status: "completed" } } });
      return { turn: { id: "new-turn", status: "inProgress" } };
    });
    const first = await router.submit("first", submission());
    expect(first.diagnostics.some(item => item.code === "native_completion_buffer_full")).toBe(count === 32);
    expect((await router.submit("second", submission())).status).toBe(count === 32 ? "blocked" : "accepted");
    if (count === 32) {
      router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "new-turn", status: "completed" } } });
      expect((await router.submit("second", submission())).status).toBe("accepted");
    }
  });
  it("duplicate early completions do not consume distinct evidence slots", async () => {
    const { router, request } = setup();
    request.mockImplementationOnce(async () => {
      for (const id of [...Array(80).fill("old-turn"), "new-turn"]) router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id, status: "completed" } } });
      return { turn: { id: "new-turn", status: "inProgress" } };
    });
    const first = await router.submit("first", submission());
    expect(first.diagnostics).not.toContainEqual({ code: "native_completion_buffer_full" });
    expect(await router.submit("second", submission())).toMatchObject({ status: "accepted" });
  });
  it("stops a prepared submission when native manual state changes before execution", async () => {
    const { router, request, prepare } = setup();
    prepare.mockImplementationOnce(async () => {
      router.updateState({ manual: { ...inherited, model: { source: "manual", value: "person-choice" } } });
      return proposal();
    });
    expect(await router.submit("raced", submission())).toMatchObject({ status: "blocked", diagnostics: [{ code: "session_state_changed" }] });
    expect(request).not.toHaveBeenCalled();
    await router.submit("fresh", submission());
    expect(request.mock.calls[0][1].model).toBe("person-choice");
  });
  it("requires image capability through the shared resolver without changing the attachment", async () => {
    const resolverInput = input({ requirement: { mode: "inherit", binding: "session" } });
    resolverInput.catalog.runtimes[0].models = ["a-text-only", "z-image"].map(id => {
      const record = model(id);
      record.fields.inputModalities = [evidence(id === "z-image" ? ["text", "image"] : ["text"])];
      record.fields.supportedReasoningLevels[0].value.forEach((level, index) => Object.assign(level, { intent: index ? "high" : "medium", order: index }));
      return record;
    });
    const { router, request } = setup({ prepare: undefined, current: undefined, dependencies: { readActivation: async () => ({ enabled: true, routingEnabled: true }), loadResolverInput: async () => resolverInput } });
    const params = submission(); params.input.push({ type: "localImage", path: "/project/private-image.png" });
    const before = structuredClone(params);
    expect(await router.submit("with-image", params)).toMatchObject({ status: "accepted", requested: { model: "z-image" } });
    expect(request.mock.calls[0][1].input).toEqual(before.input);
    expect(params).toEqual(before);
    expect(resolverInput).not.toHaveProperty("invocation");
  });
  it.each([0, -1, 1.5, 4097, "10"])("rejects an invalid submission ledger bound %s", maxSubmissions => {
    expect(() => setup({ maxSubmissions })).toThrow("invalid submission ledger limit");
  });
  it.each([undefined, null, {}, { threadId: "" }, { threadId: "thread-1", request: null }])("rejects an invalid native session before work", options => {
    expect(() => createCodexTurnRouter(options)).toThrow("invalid Codex routing session");
  });
  it("accepts the maximum identifier and ledger boundaries", async () => {
    const { router, request } = setup({ maxSubmissions: 4096 });
    expect(await router.submit("s".repeat(256), submission())).toMatchObject({ status: "accepted" });
    expect(request).toHaveBeenCalledOnce();
  });
  it("keeps explicit native overrides in the requested outcome during a fallback", async () => {
    const { router, request } = setup({ prepare: async () => { throw new Error("private classifier exception"); } });
    const params = { ...submission(), model: "my-model", effort: "low" };
    const outcome = await router.submit("fallback", params);
    expect(request).toHaveBeenCalledExactlyOnceWith("turn/start", params);
    expect(outcome).toMatchObject({ requested: { model: "my-model", reasoning: "low" }, decision: { status: "preserved", diagnostics: [{ code: "routing_preparation_failed" }] } });
    expect(JSON.stringify(outcome)).not.toContain("private classifier exception");
  });
  it.each([null, [], "invalid", { model: 42 }, { reasoning: null }, { model: "native-b", unsafeAxis: "write" }, { model: "native-b", reasoning: "bad\nvalue" }])("rejects malformed proposed changes without native overrides", async changes => {
    const { router, request } = setup({ prepare: async () => ({ status: "proposed", changes }) });
    const original = submission();
    const outcome = await router.submit("invalid-proposal", original);
    expect(request).toHaveBeenCalledExactlyOnceWith("turn/start", original);
    expect(outcome.decision).toMatchObject({ status: "preserved", diagnostics: [{ code: "invalid_routing_decision" }] });
  });
  it.each([undefined, { support: "unverified", axes: capability.axes }, { support: "supported", axes: { model: "unsupported", reasoning: "supported" } }])("requires verified native control before forwarding proposed overrides", async runtimeCapability => {
    const { router, request } = setup({ runtimeCapability });
    const original = submission(); const outcome = await router.submit("unverified", original);
    expect(request).toHaveBeenCalledExactlyOnceWith("turn/start", original);
    expect(outcome.decision.diagnostics).toEqual([{ code: "invalid_routing_decision" }]);
  });
  it("snapshots input before awaiting preparation and rejects a second active submission", async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const { router, request } = setup({ prepare: async () => { await gate; return proposal(); } });
    const original = submission(); const before = structuredClone(original);
    const first = router.submit("snapshot", original);
    original.input[0].text = "changed after submission";
    expect(await router.submit("busy", submission())).toMatchObject({ status: "blocked", diagnostics: [{ code: "submission_in_progress" }] });
    release(); await first;
    expect(request.mock.calls[0][1].input).toEqual(before.input);
    expect(request).toHaveBeenCalledOnce();
  });
  it("rejects uncloneable or malformed native inputs without preparation", async () => {
    const { router, request, prepare } = setup();
    for (const params of [null, {}, { ...submission(), input: {} }, { ...submission(), callback() {} }]) {
      expect(await router.submit("invalid-input", params)).toMatchObject({ status: "blocked", diagnostics: [{ code: "invalid_submission" }] });
    }
    expect(request).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it.each(["interrupted", "failed"])("a %s turn acknowledgement releases the next submission", async status => {
    const { router, request } = setup(); request.mockResolvedValueOnce({ turn: { id: "finished", status } });
    await router.submit("first", submission());
    expect(await router.submit("next", submission())).toMatchObject({ status: "accepted" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("an uncertain write stays blocked after uncorrelated completion events", async () => {
    const { router, request } = setup(); request.mockRejectedValueOnce(new Error("disconnected"));
    const first = await router.submit("first", submission());
    expect(first).toMatchObject({ status: "uncertain", requested: { model: "native-b", reasoning: "high" }, decision: { status: "proposed" } });
    expect(await router.submit("next", submission())).toMatchObject({ status: "blocked", diagnostics: [{ code: "submission_in_progress" }] });
    for (const event of [null, {}, { method: "turn/started" }, { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "native-turn", status: "inProgress" } } }]) expect(router.notify(event)).toBe(false);
    expect(await router.submit("next", submission())).toMatchObject({ status: "blocked" });
    expect(router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "native-turn", status: "completed" } } })).toBe(true);
    expect(await router.submit("next", submission())).toMatchObject({ status: "blocked", diagnostics: [{ code: "submission_in_progress" }] });
    expect(request).toHaveBeenCalledOnce();
  });
  it("a stale completion cannot release an uncertain submission", async () => {
    const { router, request } = setup();
    await router.submit("finished", submission());
    request.mockRejectedValueOnce(new Error("acknowledgement lost"));
    expect(await router.submit("uncertain-new", submission())).toMatchObject({ status: "uncertain" });
    router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    expect(await router.submit("third", submission())).toMatchObject({ status: "blocked", diagnostics: [{ code: "submission_in_progress" }] });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("a different completed turn cannot release a known active turn", async () => {
    const { router, request } = setup(); request.mockResolvedValueOnce({ turn: { id: "active", status: "inProgress" } });
    await router.submit("first", submission());
    router.notify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "old", status: "completed" } } });
    expect(await router.submit("next", submission())).toMatchObject({ status: "blocked" });
    expect(request).toHaveBeenCalledOnce();
  });
  it("takes current and manual state updates independently", async () => {
    const { router, request, prepare } = setup();
    expect(router.updateState({ current: { axes: { model: "observed-model", reasoning: "low" } } })).toBe(true);
    await router.submit("current", submission());
    expect(prepare.mock.calls[0][0].current.axes).toEqual({ model: "observed-model", reasoning: "low" });
    router.updateState({ manual: { model: { source: "manual" }, reasoning: { source: "manual" } } });
    await router.submit("manual", submission());
    expect(request.mock.calls[1][1]).toMatchObject({ model: "observed-model", effort: "low" });
    router.updateState({ manual: inherited }); await router.submit("automatic-again", submission());
    expect(request.mock.calls[2][1]).toMatchObject({ model: "native-b", effort: "high" });
  });
  it("keeps prompt text separate from native attachments and joins text blocks", async () => {
    const { router, request, prepare } = setup();
    const params = submission("First text."); params.input.push({ type: "image", url: "private-image" }, { type: "text", text: "Second text." });
    await router.submit("multi-input", params);
    expect(prepare.mock.calls[0][0].prompt).toBe("First text.\nSecond text.");
    expect(request.mock.calls[0][1].input).toEqual(params.input);
  });
  it("rejects an unverified attachment modality before capability loading", async () => {
    const loadResolverInput = vi.fn();
    const { router, request } = setup({ prepare: undefined, dependencies: { readActivation: async () => ({ enabled: true, routingEnabled: true }), loadResolverInput } });
    const params = submission(); params.input.push({ type: "unknownAttachment", private: "unexamined" });
    const outcome = await router.submit("unverified-attachment", params);
    expect(loadResolverInput).not.toHaveBeenCalled();
    expect(outcome.decision.status).toBe("preserved");
    expect(request).toHaveBeenCalledExactlyOnceWith("turn/start", params);
  });

});
