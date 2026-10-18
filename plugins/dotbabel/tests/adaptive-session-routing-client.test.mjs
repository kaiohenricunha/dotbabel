import { describe, it, expect, vi } from "vitest";
import { openCodexSession } from "../src/adaptive-session-routing/client.mjs";
import { makeAdapterResult } from "../src/model-intelligence/sources/contract.mjs";
import { makeDiscoveryEvidence, makeModelFact } from "../src/model-intelligence/sources/evidence.mjs";
import { input as resolverInput, model } from "./fixtures/model-intelligence/resolver.mjs";
import { prepareRoute } from "../src/adaptive-session-routing/prepare.mjs";

function fixture(options = {}) {
  let notify;
  let number = 0;
  const calls = [];
  const rpc = {
    close: vi.fn(), sendNotification: vi.fn(), onNotification: fn => { notify = fn; return () => {}; },
    request: vi.fn(async (method, params) => {
      calls.push([method, structuredClone(params)]);
      if (method === "initialize") return { userAgent: options.userAgent ?? "dotbabel-managed-session/0.163.0 (fixture)" };
      if (method === "config/read") return options.config ?? { config: {}, origins: {} };
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
      if (method === "thread/read") return options.observation ?? { thread: { model: "selected", reasoningEffort: "high", modelProvider: "native-provider" } };
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
    for (const activation of [{ enabled: false }, { enabled: true, routingEnabled: false }]) {
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
    const loaded = [], f = fixture({ load: true, loaded }); delete f.deps.loadResolverInput;
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
    const loaded = [], f = fixture({ load: true, loaded }); delete f.deps.loadResolverInput;
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
