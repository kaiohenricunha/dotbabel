import { describe, it, expect, vi, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { createCodexRpcTransport } from "../src/adaptive-session-routing/codex-rpc.mjs";

const instances = [];
afterEach(() => instances.splice(0).forEach(instance => instance.close()));
function connect(options = {}) {
  const instance = createCodexRpcTransport({ timeoutMs: 500, command: process.execPath, args: [fileURLToPath(new URL("./fixtures/adaptive-session-routing/rpc-server.mjs", import.meta.url))], ...options });
  instances.push(instance); return instance;
}
describe("Codex App Server subprocess protocol", () => {
  it("sends the initialized notification without waiting for an acknowledgement", async () => {
    const rpc = connect();
    expect(rpc.sendNotification("initialized", {})).toBe(true);
    expect(await rpc.request("initializationCount", {})).toBe(1);
  });
  it("preserves Unicode parameters and sends each request once", async () => {
    const rpc = connect();
    const params = { input: [{ type: "text", text: "Ação 日本語 🔍" }], approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } };
    expect(await rpc.request("echo", params)).toEqual(params);
    expect(params.input[0].text).toBe("Ação 日本語 🔍");
  });
  it("passes native approval requests to the caller without changing the decision", async () => {
    const params = { command: "user-requested command", threadId: "thread-1", turnId: "turn-1" };
    const handler = vi.fn(async () => ({ decision: "decline" }));
    const rpc = connect({ onServerRequest: handler });
    expect(await rpc.request("approval", params)).toEqual({ decision: "decline" });
    expect(handler).toHaveBeenCalledExactlyOnceWith("item/commandExecution/requestApproval", params);
  });
  it("never approves native permissions when no handler exists", async () => {
    const rpc = connect();
    expect(await rpc.request("approval", {})).toEqual({ errorCode: -32601 });
    expect(rpc.diagnostics).toContainEqual({ code: "native_handler_unavailable", method: "item/commandExecution/requestApproval" });
  });
  it("reports a failing approval handler without exposing its exception", async () => {
    const rpc = connect({ onServerRequest: async () => { throw new Error("private failure detail"); } });
    expect(await rpc.request("approval", {})).toEqual({ errorCode: -32603 });
    expect(rpc.diagnostics).toContainEqual({ code: "native_handler_failed", method: "item/commandExecution/requestApproval" });
    expect(JSON.stringify(rpc.diagnostics)).not.toContain("private failure detail");
  });
  it("reports both synchronous and asynchronous observer failures", async () => {
    const rpc = connect();
    rpc.onNotification(() => { throw new Error("private observer detail"); });
    rpc.onNotification(async () => { throw new Error("private async detail"); });
    await rpc.request("notify", {});
    expect(rpc.diagnostics.filter(item => item.code === "native_observer_failed")).toHaveLength(2);
    expect(JSON.stringify(rpc.diagnostics)).not.toContain("private");
  });
  it("forwards completion notifications independently of request acknowledgements", async () => {
    const rpc = connect(); const notify = vi.fn(); const unsubscribe = rpc.onNotification(notify);
    const params = { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } };
    expect(await rpc.request("notify", params)).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith({ method: "turn/completed", params });
    unsubscribe(); await rpc.request("notify", params); expect(notify).toHaveBeenCalledOnce();
  });
  it("reports native rejection without echoing native error text", async () => {
    const rpc = connect();
    await expect(rpc.request("reject", {})).rejects.toMatchObject({ code: "native_rpc_rejected", nativeCode: -32602 });
    try { await rpc.request("reject", {}); } catch (error) { expect(error.message).not.toContain("private native error"); }
  });
  it("bounds waiting and does not retry a timed-out write", async () => {
    const rpc = connect({ timeoutMs: 100 });
    await expect(rpc.request("hold", {})).rejects.toMatchObject({ code: "native_rpc_timeout" });
    expect(await rpc.request("echo", { next: true })).toEqual({ next: true });
  });
  it.each(["exit", "malformed", "oversized"])("fails pending requests when the native stream is %s", async method => {
    const rpc = connect({ maxLineBytes: 1024 });
    await expect(rpc.request(method, {})).rejects.toMatchObject({ code: expect.stringMatching(/^native_(transport_closed|protocol_invalid|protocol_too_large)$/) });
    await expect(rpc.request("echo", {})).rejects.toMatchObject({ code: "native_transport_closed" });
  });
  it.each([{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: 600001 }, { maxLineBytes: 127 }, { maxLineBytes: 1.5 }, { maxLineBytes: 67108865 }])("rejects invalid native resource bounds before spawning", bounds => {
    expect(() => connect(bounds)).toThrow("invalid native transport bounds");
  });
  it("accepts inclusive transport resource boundaries", () => {
    expect(() => connect({ timeoutMs: 1, maxLineBytes: 128 })).not.toThrow();
    expect(() => connect({ timeoutMs: 600000, maxLineBytes: 67108864 })).not.toThrow();
  });
  it.each([null, 12, "", {}])("rejects invalid outbound methods without writing", async method => {
    const rpc = connect();
    await expect(rpc.request(method, {})).rejects.toMatchObject({ code: "native_rpc_limit" });
    expect(rpc.sendNotification(method, {})).toBe(false);
    expect(await rpc.request("echo", { stillUsable: true })).toEqual({ stillUsable: true });
  });
  it("closes pending requests and rejects later requests and notifications", async () => {
    const rpc = connect(); await rpc.request("echo", {});
    const waiting = expect(rpc.request("hold", {})).rejects.toMatchObject({ code: "native_transport_closed" });
    rpc.close(); rpc.close(); await waiting;
    await expect(rpc.request("echo", {})).rejects.toMatchObject({ code: "native_transport_closed" });
    expect(rpc.sendNotification("initialized", {})).toBe(false);
  });
  it("limits pending requests without silently evicting an earlier request", async () => {
    const rpc = connect(); await rpc.request("echo", {});
    const pending = Array.from({ length: 128 }, () => expect(rpc.request("hold", {})).rejects.toMatchObject({ code: "native_transport_closed" }));
    await expect(rpc.request("echo", {})).rejects.toMatchObject({ code: "native_rpc_limit" });
    rpc.close(); await Promise.all(pending);
  });
  it("bounds observers and releases a slot on unsubscribe", async () => {
    const rpc = connect(); const observers = Array.from({ length: 32 }, () => vi.fn());
    const remove = observers.map(observer => rpc.onNotification(observer));
    expect(() => rpc.onNotification(() => {})).toThrow("invalid native observer");
    expect(() => rpc.onNotification(null)).toThrow("invalid native observer");
    remove[0](); const replacement = vi.fn(); rpc.onNotification(replacement);
    await rpc.request("notify", { test: true });
    expect(observers[0]).not.toHaveBeenCalled(); expect(replacement).toHaveBeenCalledOnce();
    expect(observers.slice(1).every(observer => observer.mock.calls.length === 1)).toBe(true);
  });
  it("bounds diagnostic retention and returns independent diagnostic records", async () => {
    const rpc = connect(); expect(rpc.diagnostics).toEqual([]);
    rpc.onNotification(() => { throw new Error("private observer detail"); });
    for (let index = 0; index < 35; index++) await rpc.request("notify", { index });
    expect(rpc.diagnostics).toHaveLength(32);
    const copy = rpc.diagnostics; copy[0].code = "tampered"; copy.push({ code: "extra" });
    expect(rpc.diagnostics).toHaveLength(32);
    expect(rpc.diagnostics.every(item => item.code === "native_observer_failed")).toBe(true);
  });
  it.each([null, [], "untrusted-string", 5])("rejects non-object JSON protocol values", async value => {
    const rpc = connect();
    await expect(rpc.request("raw", value)).rejects.toMatchObject({ code: "native_protocol_invalid" });
  });
  it("rejects a response that contains neither a result nor an error", async () => {
    const rpc = connect();
    await expect(rpc.request("missingResult", {})).rejects.toMatchObject({ code: "native_protocol_invalid" });
    await expect(rpc.request("echo", {})).rejects.toMatchObject({ code: "native_transport_closed" });
  });
  it("retains Unicode when a native response splits a character between chunks", async () => {
    const rpc = connect();
    expect(await rpc.request("chunked", { text: "Ação 🔍" })).toEqual({ text: "Ação 🔍" });
  });
  it("accepts a line exactly at the configured byte limit", async () => {
    const rpc = connect({ maxLineBytes: 128 });
    const value = await rpc.request("sized", { size: 128 });
    expect(value).toBe("x".repeat(108));
  });
  it("rejects an oversized newline-terminated native message", async () => {
    const rpc = connect({ maxLineBytes: 128 });
    await expect(rpc.request("sized", { size: 129 })).rejects.toMatchObject({ code: "native_protocol_too_large" });
  });
  it("does not expose a nonnumeric native error code or native error message", async () => {
    const rpc = connect();
    await expect(rpc.request("rejectUnknownCode", {})).rejects.toMatchObject({ code: "native_rpc_rejected", message: "native_rpc_rejected" });
    try { await rpc.request("rejectUnknownCode", {}); } catch (error) { expect(error.nativeCode).toBeUndefined(); }
  });
  it("ignores an unmatched response without consuming the next pending request", async () => {
    const rpc = connect(); expect(await rpc.request("unmatched", { retained: true })).toEqual({ retained: true });
    expect(await rpc.request("echo", { next: true })).toEqual({ next: true });
  });
  it("closes on an unserializable write without exposing private content", async () => {
    const rpc = connect(); const params = {}; params.self = params;
    await expect(rpc.request("echo", params)).rejects.toMatchObject({ code: "native_transport_closed" });
    expect(rpc.sendNotification("initialized", {})).toBe(false);
  });

});
