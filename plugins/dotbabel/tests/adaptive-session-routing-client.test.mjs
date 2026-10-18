import { describe, it, expect, vi } from "vitest";
import { openCodexSession } from "../src/adaptive-session-routing/client.mjs";
import { makeAdapterResult } from "../src/model-intelligence/sources/contract.mjs";
import { makeDiscoveryEvidence, makeModelFact } from "../src/model-intelligence/sources/evidence.mjs";
import { input as resolverInput, model, evidence } from "./fixtures/model-intelligence/resolver.mjs";
import { prepareRoute } from "../src/adaptive-session-routing/prepare.mjs";

function native(id) {
 const value=model(id); value.fields.inputModalities=[evidence(["text"])]; value.fields.supportedReasoningLevels[0].value.forEach((entry,index)=>Object.assign(entry,{intent:index?"high":"medium",order:index})); return value;
}

function fixture(options = {}) {
  let notify;
  let number = 0;
  let initialized = false;
  const calls = [];
  const rpc = {
    close: vi.fn(), sendNotification: vi.fn((method, params) => { expect(method).toBe("initialized"); expect(params).toEqual({}); initialized = true; }), onNotification: fn => { notify = fn; return () => {}; },
    request: vi.fn(async (method, params) => {
      calls.push([method, structuredClone(params)]);
      if (method === "initialize") { expect(params.clientInfo.name).toBeTruthy(); expect(params.clientInfo.version).toMatch(/^\d+\.\d+\.\d+$/); expect(params.capabilities.experimentalApi).toBe(true); return { userAgent: options.userAgent ?? "dotbabel-managed-session/0.163.0 (fixture)" }; }
      expect(initialized).toBe(true);
      if (method === "config/read") { expect(params).toEqual({ cwd: options.repoRoot ?? "/project", includeLayers: false }); return options.config ?? { config: {}, origins: {} }; }
      if (method === "thread/start") return { thread: { id: "retained-thread", turns: [] }, model: "default", reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: { type: "readOnly" } };
      if (method === "turn/start") {
        if (options.turnFailure) throw Error("private native request text");
        const id = `turn-${++number}`;
        if (!options.noCompletion) queueMicrotask(() => {
          if (options.reroute) notify({ method: "model/rerouted", params: { threadId: "retained-thread", turnId: id, fromModel: "selected", toModel: "other" } });
          notify({ method: "turn/completed", params: { threadId: "retained-thread", turn: { id, status: options.turnStatus ?? "completed" } } });
        });
        return { turn: { id, status: "inProgress" } };
      }
      if (method === "thread/read") { expect(params).toEqual({ threadId: "retained-thread", includeTurns: false }); return options.observation ?? { thread: { model: "selected", reasoningEffort: "high", modelProvider: "native-provider" } }; }
      if (method === "model/list") return { data: [{ model: "visible", hidden: false }, { model: "hidden", hidden: true }] };
      throw Error("unexpected native request");
    }),
  };
  const prepare = vi.fn(async (request, dependencies) => {
    options.prepared?.(request);
    if (options.load) options.loaded.push(await dependencies.loadResolverInput(request.repoRoot));
    return { status: "proposed", changes: { model: "selected", reasoning: "high" }, confidence: "high", diagnostics: [] };
  });
  const createTransport = vi.fn(() => rpc);
  const deps = { createTransport, readActivation: () => ({ enabled: true, routingEnabled: true }), prepare, loadResolverInput: vi.fn() };
  return { rpc, calls, prepare, createTransport, deps, notify: msg => notify(msg) };
}

describe("managed Codex session", () => {
  it.each(["dotbabel-managed-session/99.0.0", "unknown-native-interface"])("keeps automatic routing unverified for an unmeasured native interface: %s", async userAgent => {
    const f = fixture({ userAgent }); delete f.deps.prepare;
    const session = await openCodexSession({ repoRoot: "/project", model: "auto", effort: "auto" }, f.deps);
    const result = await session.submit([{ type: "text", text: "Implement integration tests for the payment gateway." }]);
    expect(session.routing.support).toBe("unverified"); expect(result.decision.diagnostics.map(x => x.code)).toContain("routing_unverified");
    expect(f.deps.loadResolverInput).not.toHaveBeenCalled();
    expect(f.calls.find(([m]) => m === "turn/start")[1]).toEqual({ threadId: "retained-thread", input: [{ type: "text", text: "Implement integration tests for the payment gateway." }] }); session.close();
  });
  it("gates activation before starting a native process", async () => {
    for (const activation of [{ enabled: false, routingEnabled: true }, { enabled: true, routingEnabled: false }, { enabled: "true", routingEnabled: true }, { enabled: true, routingEnabled: "true" }]) {
      const f = fixture(); f.deps.readActivation = () => activation;
      await expect(openCodexSession({ repoRoot: "/project" }, f.deps)).rejects.toMatchObject({ code: "routing_disabled" });
      expect(f.createTransport).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    }
  });
  it("submits two ordinary inputs once on one native thread and observes each completed turn", async () => {
    const f = fixture(); const session = await openCodexSession({ repoRoot: "/project", model: "auto", effort: "auto" }, f.deps);
    const input = [{ type: "text", text: "Implement integration tests.", text_elements: [] }, { type: "image", url: "data:image/png;base64,eA==" }];
    const before = structuredClone(input);
    const first = await session.submit(input); const second = await session.submit([{ type: "text", text: "Check the race.", text_elements: [] }]);
    const turns = f.calls.filter(([method]) => method === "turn/start");
    expect(turns).toHaveLength(2); expect(turns[0][1].input).toEqual(before); expect(input).toEqual(before);
    expect(turns.map(([, p]) => p.threadId)).toEqual(["retained-thread", "retained-thread"]);
    expect(first).toMatchObject({ status: "completed", effective: { state: "observed", axes: { model: "selected", reasoning: "high" }, provider: "codex.native-provider" } });
    expect(second.accepted.turnId).not.toBe(first.accepted.turnId); session.close(); expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it("preserves explicit user native settings on each axis", async () => {
    const f = fixture({ config: { config: { model: "user-model", model_reasoning_effort: "low" }, origins: { model: { name: { type: "user" } }, model_reasoning_effort: { name: { type: "project" } } } } });
    const session = await openCodexSession({ repoRoot: "/project" }, f.deps); await session.submit([{ type: "text", text: "Do work." }]);
    expect(f.calls.find(([m]) => m === "turn/start")[1]).toMatchObject({ model: "user-model", effort: "low" }); session.close();
  });
  it("lets an explicit automatic-axis option replace only that manual axis", async () => {
    const f = fixture({ config: { config: { model: "user-model", model_reasoning_effort: "low" }, origins: { model: { name: { type: "user" } }, model_reasoning_effort: { name: { type: "user" } } } } });
    const session = await openCodexSession({ repoRoot: "/project", model: "auto" }, f.deps); await session.submit([{ type: "text", text: "Do work." }]);
    expect(f.calls.find(([m]) => m === "turn/start")[1]).toMatchObject({ model: "selected", effort: "low" }); session.close();
  });
  it("passes no approval or sandbox override when starting the native thread", async () => {
    const f = fixture(); const session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    expect(f.calls.find(([m]) => m === "thread/start")[1]).toEqual({ cwd: "/project" });
    expect(session.native).toMatchObject({ approvalPolicy: "on-request", sandbox: { type: "readOnly" } }); session.close();
  });
  it("passes the caller's native approval handler unchanged to the existing transport", async () => {
    const f = fixture(), onServerRequest = vi.fn(); const session = await openCodexSession({ repoRoot: "/project", onServerRequest }, f.deps);
    expect(f.createTransport.mock.calls[0][0].onServerRequest).toBe(onServerRequest); session.close();
  });
  it("never treats a missing post-turn observation as an effective configuration", async () => {
    const f = fixture({ observation: { thread: {} } }); const session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    const result = await session.submit([{ type: "text", text: "Do work." }]); expect(result.effective).toEqual({ state: "unknown" }); session.close();
  });
  it("preserves a known native model without inventing an unreported effort", async () => {
    const f = fixture({ observation: { thread: { model: "model-only", reasoningEffort: null, modelProvider: "openai" } } }), session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    const result = await session.submit([{ type: "text", text: "Prompt" }]);
    expect(result.effective).toMatchObject({ state: "observed", axes: { model: "model-only" }, provider: "openai" }); expect(result.effective.axes).not.toHaveProperty("reasoning"); session.close();
  });
  it("never calls an executed thread cold when post-turn observation is unavailable", async () => {
    const seen = [], f = fixture({ observation: { thread: {} }, prepared: request => seen.push(request.current) });
    const session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    await session.submit([{ type: "text", text: "First." }]); await session.submit([{ type: "text", text: "Second." }]);
    expect(seen[0].turnExecuted).toBe(false); expect(seen[1]).toEqual({ axes: {}, turnExecuted: true }); session.close();
  });
  it("does not claim effective axes after a native reroute", async () => {
    const f = fixture({ reroute: true }), session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    const result = await session.submit([{ type: "text", text: "Do work." }]);
    expect(result.effective).toEqual({ state: "unknown" }); expect(result.diagnostics).toContainEqual({ code: "native_model_rerouted" }); session.close();
  });
  it("does not replay a native request whose outcome is uncertain", async () => {
    const f = fixture({ turnFailure: true }), session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    expect((await session.submit([{ type: "text", text: "First." }])).status).toBe("uncertain");
    expect((await session.submit([{ type: "text", text: "Second." }])).status).toBe("blocked");
    expect(f.calls.filter(([m]) => m === "turn/start")).toHaveLength(1); session.close();
  });
  it("supplies the real completed-turn observation so a later mandatory floor can block unsafe fallback", async () => {
    const f = fixture({ observation: { thread: { model: "weak", reasoningEffort: "calm" } } });
    const base = resolverInput({ requirement: { mode: "inherit", binding: "session" } }); base.catalog.runtimes[0].models = [model("weak", "routine")];
    f.deps.loadResolverInput = async () => base;
    f.deps.prepare.mockImplementationOnce(async () => ({ status: "proposed", changes: { model: "weak", reasoning: "calm" } })).mockImplementation(prepareRoute);
    const session = await openCodexSession({ repoRoot: "/project", model: "auto", effort: "auto" }, f.deps);
    await session.submit([{ type: "text", text: "Format the sample JSON: {a:1}" }]);
    base.policy = { ...base.policy, floor: { mode: "floor", requirement: "frontier" } };
    const result = await session.submit([{ type: "text", text: "Format the sample JSON: {a:2}" }]);
    expect(result.status).toBe("blocked"); expect(result.decision.resolution.enforcement.state).toBe("unsatisfied");
    expect(f.calls.filter(([m]) => m === "turn/start")).toHaveLength(1); session.close();
  });
  it("preserves the native in-progress barrier after a completion deadline", async () => {
    const f = fixture({ noCompletion: true }), session = await openCodexSession({ repoRoot: "/project", completionTimeoutMs: 5 }, f.deps);
    await expect(session.submit([{ type: "text", text: "First." }])).rejects.toMatchObject({ code: "native_completion_unknown" });
    expect((await session.submit([{ type: "text", text: "Second." }])).status).toBe("blocked");
    expect(f.calls.filter(([m]) => m === "turn/start")).toHaveLength(1); session.close();
  });
  it("rejects invalid input before submitting a native turn", async () => {
    const f = fixture(); const session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    for (const input of [[], "text", [{ type: "text", text: "x".repeat(1048577) }]]) await expect(session.submit(input)).rejects.toMatchObject({ code: "session_input_invalid" });
    expect(f.calls.some(([m]) => m === "turn/start")).toBe(false); session.close();
  });
  it("closes the transport on a failed native initialization", async () => {
    const f = fixture(); f.rpc.request.mockRejectedValueOnce(Error("private native text"));
    await expect(openCodexSession({ repoRoot: "/project" }, f.deps)).rejects.toMatchObject({ code: "session_initialization_failed", message: "session_initialization_failed" });
    expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it("does not consume another thread's completion", async () => {
    const f = fixture(); const session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    f.notify({ method: "turn/completed", params: { threadId: "another-thread", turn: { id: "turn-1", status: "failed" } } });
    expect((await session.submit([{ type: "text", text: "Do work." }])).status).toBe("completed"); session.close();
  });
  it("refreshes expired local discovery and checks native eligibility on each classified turn", async () => {
    let now = "2026-10-18T00:00:00.000Z";
    const loaded = [], f = fixture({ load: true, loaded, repoRoot: process.cwd() }); delete f.deps.loadResolverInput;
    f.deps.now = () => now;
    f.deps.discover = vi.fn(async () => makeAdapterResult({ status: "ok", provenance: { sourceId: "codex", sourceKind: "runtime", adapterVersion: "4" }, observedAt: now,
      evidence: makeDiscoveryEvidence({ models: ["visible", "hidden"].map(id => makeModelFact({ id, supportedReasoningLevels: [] })) }) }));
    const session = await openCodexSession({ repoRoot: process.cwd() }, f.deps);
    await session.submit([{ type: "text", text: "First prompt" }]);
    await session.submit([{ type: "text", text: "Second prompt" }]);
    now = "2026-10-20T00:00:00.000Z";
    await session.submit([{ type: "text", text: "Third prompt" }]);
    expect(f.deps.discover).toHaveBeenCalledTimes(2);
    expect(f.calls.filter(([m]) => m === "model/list")).toHaveLength(3);
    expect(loaded).toHaveLength(3);
    expect(loaded[0].catalog.runtimes[0].models.map(m => m.model)).toEqual(["visible"]); session.close();
  });
  it("does not cache a failed discovery as usable fresh input", async () => {
    const loaded = [], f = fixture({ load: true, loaded, repoRoot: process.cwd() }); delete f.deps.loadResolverInput;
    const now = "2026-10-18T00:00:00.000Z"; f.deps.now = () => now;
    f.deps.discover = vi.fn().mockResolvedValueOnce({ status: "unavailable", observedAt: now }).mockResolvedValue(makeAdapterResult({ status: "ok", provenance: { sourceId: "codex", sourceKind: "runtime", adapterVersion: "4" }, observedAt: now, evidence: makeDiscoveryEvidence({ models: [makeModelFact({ id: "visible", supportedReasoningLevels: [] })] }) }));
    const session = await openCodexSession({ repoRoot: process.cwd() }, f.deps);
    await session.submit([{ type: "text", text: "First" }]); await session.submit([{ type: "text", text: "Second" }]);
    expect(f.deps.discover).toHaveBeenCalledTimes(2); expect(loaded).toHaveLength(1); expect(loaded[0].catalog.runtimes[0].models[0].model).toBe("visible"); session.close();
  });
  it.each([0, -1, 1.5, 43200001, Number.NaN])("rejects invalid completion bound %s before starting a process", async completionTimeoutMs => {
    const f = fixture(); await expect(openCodexSession({ repoRoot: "/project", completionTimeoutMs }, f.deps)).rejects.toMatchObject({ code: "session_timeout_invalid" }); expect(f.createTransport).not.toHaveBeenCalled();
  });
  it.each([1, 43200000])("accepts completion bound %s and closes without a turn", async completionTimeoutMs => {
    const f = fixture(), session = await openCodexSession({ repoRoot: "/project", completionTimeoutMs }, f.deps); session.close(); session.close();
    expect(f.rpc.close).toHaveBeenCalledOnce(); await expect(session.submit([{ type: "text", text: "After close" }])).rejects.toMatchObject({ code: "session_closed" });
  });
  it("does not infer manual authority from an unknown config origin", async () => {
    let seen; const f = fixture({ config: { config: { model: "configured" }, origins: {} }, prepared: request => { seen = request; } });
    const session = await openCodexSession({ repoRoot: "/project" }, f.deps); await session.submit([{ type: "text", text: "Prompt" }]);
    expect(seen.manual.model).toEqual({ source: "unknown", value: "configured" }); expect(seen.current.axes.model).toBe("configured"); session.close();
  });
  it("preserves explicit launch model and effort independently of native defaults", async () => {
    const f = fixture(), session = await openCodexSession({ repoRoot: "/project", model: "pinned", effort: "low" }, f.deps);
    await session.submit([{ type: "text", text: "Prompt" }]); expect(f.calls.find(([m]) => m === "turn/start")[1]).toMatchObject({ model: "pinned", effort: "low" }); session.close();
  });
  it.each([{ model: "\n" }, { effort: 2 }])("rejects invalid launch axes without creating a thread: %s", async axes => {
    const f = fixture(); await expect(openCodexSession({ repoRoot: "/project", ...axes }, f.deps)).rejects.toMatchObject({ code: "session_initialization_failed" }); expect(f.calls.some(([m]) => m === "thread/start")).toBe(false); expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it("refuses a nonempty native thread and closes its transport", async () => {
    const f = fixture(), original = f.rpc.request.getMockImplementation(); f.rpc.request.mockImplementation((method, params) => method === "thread/start" ? { thread: { id: "old", turns: [{ id: "existing" }] } } : original(method, params));
    await expect(openCodexSession({ repoRoot: "/project" }, f.deps)).rejects.toMatchObject({ code: "session_initialization_failed" }); expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it("rejects concurrent prompts and closing a pending wait never replays input", async () => {
    const f = fixture({ noCompletion: true }), session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    const pending = session.submit([{ type: "text", text: "First" }]); const rejected = expect(pending).rejects.toMatchObject({ code: "session_closed" });
    await expect(session.submit([{ type: "text", text: "Second" }])).rejects.toMatchObject({ code: "session_busy" });
    await vi.waitFor(() => expect(f.calls.filter(([m]) => m === "turn/start")).toHaveLength(1));
    session.close(); await rejected; expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it.each(["failed", "interrupted"])("never labels a %s native turn observed", async turnStatus => {
    const f = fixture({ turnStatus }), session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    const result = await session.submit([{ type: "text", text: "Prompt" }]); expect(result.status).toBe(turnStatus); expect(result.effective.state).toBe("unknown"); session.close();
  });
  it("preserves unknown effective state when native observation fails and does not replay for display failures", async () => {
    const f = fixture(), original = f.rpc.request.getMockImplementation(); f.rpc.request.mockImplementation((method, params) => method === "thread/read" ? Promise.reject(Error("private native text")) : original(method, params));
    const session = await openCodexSession({ repoRoot: "/project", onEvent: () => { throw Error("display failed"); } }, f.deps);
    expect((await session.submit([{ type: "text", text: "Prompt" }])).effective.state).toBe("unknown"); expect(f.calls.filter(([m]) => m === "turn/start")).toHaveLength(1); session.close();
  });
  it("accepts the exact serialized input bound and rejects cyclic or oversized data", async () => {
    const f = fixture(), session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    const base = [{ type: "text", text: "" }], overhead = Buffer.byteLength(JSON.stringify(base)); base[0].text = "x".repeat(1048576 - overhead);
    expect((await session.submit(base)).status).toBe("completed");
    base[0].text += "x"; await expect(session.submit(base)).rejects.toMatchObject({ code: "session_input_invalid" });
    const cycle = []; cycle.push(cycle); await expect(session.submit(cycle)).rejects.toMatchObject({ code: "session_input_invalid" }); session.close();
  });
});


describe("managed native protocol and lifetime boundaries", () => {
  it("correlates a late completion to both thread and turn, forwards events, and cancels its deadline", async () => {
    const f = fixture({ noCompletion: true }), onEvent = vi.fn();
    const session = await openCodexSession({ repoRoot: "/project", onEvent }, f.deps);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const pending = session.submit([{ type: "text", text: "Prompt" }]).then(result => { settled = true; return result; });
      for (let i = 0; i < 30 && vi.getTimerCount() === 0; i++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      f.notify({ method: "turn/completed", params: { threadId: "other", turn: { id: "turn-1", status: "failed" } } });
      f.notify({ method: "turn/completed", params: { threadId: "retained-thread", turn: { id: "other", status: "failed" } } });
      await Promise.resolve(); expect(settled).toBe(false); expect(vi.getTimerCount()).toBe(1);
      const event = { method: "turn/completed", params: { threadId: "retained-thread", turn: { id: "turn-1", status: "completed" } } };
      f.notify(event); expect((await pending).status).toBe("completed"); expect(vi.getTimerCount()).toBe(0); expect(onEvent).toHaveBeenCalledWith(event);
    } finally { session.close(); vi.useRealTimers(); }
  });
  it.each([false, true])("clears per-turn early completion and reroute state across forty ordinary turns: %s", async reroute => {
    const f = fixture({ reroute }), session = await openCodexSession({ repoRoot: "/project", completionTimeoutMs: 20 }, f.deps);
    try {
      for (let i = 0; i < 40; i++) {
        const result = await session.submit([{ type: "text", text: `Prompt ${i}` }]);
        expect(result.status).toBe("completed"); expect(result.effective.state).toBe(reroute ? "unknown" : "observed");
      }
      expect(f.calls.filter(([m]) => m === "turn/start")).toHaveLength(40);
    } finally { session.close(); }
  });
  it.each([{}, { thread: {} }, { thread: { id: 7, turns: [] } }, { thread: { id: "bad" } }])("rejects malformed native thread initialization: %s", async started => {
    const f = fixture(), original = f.rpc.request.getMockImplementation();
    f.rpc.request.mockImplementation((method, params) => method === "thread/start" ? started : original(method, params));
    await expect(openCodexSession({ repoRoot: "/project" }, f.deps)).rejects.toMatchObject({ code: "session_initialization_failed" }); expect(f.rpc.close).toHaveBeenCalledOnce();
  });
  it.each(["prefix-dotbabel-managed-session/0.163.0", "dotbabel-managed-session/0.163.0-preview", "dotbabel-managed-session/0.163.0x", 7])("does not verify a malformed native interface identity: %s", async userAgent => {
    const f = fixture({ userAgent }), session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    expect(session.routing.support).toBe("unverified"); session.close();
  });
  it("reports a measured runtime identity even without an operating-system suffix", async () => {
    const f = fixture({ userAgent: "dotbabel-managed-session/0.163.0" }), session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    expect(session.routing).toEqual({ support: "supported", mechanism: "managed-app-server", runtimeVersion: "0.163.0" }); session.close();
  });
  it.each([undefined, null])("treats an absent native configured axis as inherited: %s", async value => {
    let seen; const f = fixture({ config: { config: { model: value, model_reasoning_effort: value } }, prepared: request => { seen = request; } });
    const session = await openCodexSession({ repoRoot: "/project" }, f.deps); await session.submit([{ type: "text", text: "Prompt" }]);
    expect(seen.manual).toEqual({ model: { source: "inherited" }, reasoning: { source: "inherited" } }); session.close();
  });
  it("retains complete as-run provenance for the next resolver call", async () => {
    const loaded = [], f = fixture({ load: true, loaded });
    f.deps.loadResolverInput = vi.fn(async () => ({}));
    const session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    await session.submit([{ type: "text", text: "First" }]); const result = await session.submit([{ type: "text", text: "Second" }]);
    expect(loaded[1].observed).toMatchObject({ runtimeId: "codex", turnExecuted: true, configurationBasis: "as-run", provider: "codex.native-provider", axes: { model: "selected", reasoning: "high" }, fieldSources: { "axes.model": "thread/read:model", "axes.reasoning": "thread/read:reasoningEffort", provider: "thread/read:modelProvider" } });
    expect(result.effective.source).toBe("thread/read after turn/completed"); session.close();
  });
  it.each(["user", "project", "sessionFlags"])("keeps manual native axes with the real resolver when their origin is %s", async origin => {
    const f = fixture({ config: { config: { model: "z-deep", model_reasoning_effort: "focused" }, origins: { model: { name: { type: origin } }, model_reasoning_effort: { name: { type: origin } } } } });
    f.deps.prepare = prepareRoute; f.deps.loadResolverInput = async () => resolverInput({ catalog: { runtimes: [{ runtimeId: "codex", models: [native("a-deep"), native("z-deep")] }] } });
    const session = await openCodexSession({ repoRoot: "/project" }, f.deps);
    const result = await session.submit([{ type: "text", text: "Implement integration tests for the payment gateway." }]);
    expect(result.decision.status).toBe("preserved"); expect(f.calls.find(([m]) => m === "turn/start")[1]).toMatchObject({ model: "z-deep", effort: "focused" }); session.close();
  });
  it.each([{}, { model: "auto", effort: "auto" }])("uses independently inherited axes with the real preparation path: %s", async options => {
    const f = fixture(); f.deps.prepare = prepareRoute;
    f.deps.loadResolverInput = async () => resolverInput({ catalog: { runtimes: [{ runtimeId: "codex", models: [native("a-deep"), native("z-deep")] }] } });
    const session = await openCodexSession({ repoRoot: "/project", ...options }, f.deps);
    const result = await session.submit([{ type: "text", text: "Implement integration tests for the payment gateway." }]);
    expect(result.decision.status).toBe("proposed"); expect(f.calls.find(([m]) => m === "turn/start")[1]).toMatchObject({ model: "a-deep", effort: "calm" }); session.close();
  });
});
