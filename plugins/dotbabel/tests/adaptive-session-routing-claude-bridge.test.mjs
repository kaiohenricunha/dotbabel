import { afterEach, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import { openClaudeRoutingBridge } from "../src/adaptive-session-routing/claude-bridge.mjs";

const sessions = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); });
const request = (socketPath, body, url = "/prepare", method = "POST") => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, path: url, method, agent: false, headers: { "content-type": "application/json" } }, response => {
    let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
  });
  req.on("error", reject); req.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
});
const input = repoRoot => ({ repoRoot, prompt: "Implement payment integration tests.", runtimeVersion: "2.1.302", current: { axes: { model: "native", reasoning: "medium" } }, manual: { model: { source: "inherited" }, reasoning: { source: "inherited" } } });
async function bridge(options = {}) { const server = await openClaudeRoutingBridge(options); sessions.push(server); return server; }

it("keeps concurrent enabled and disabled projects separate before classification or discovery", async () => {
  const readActivation = vi.fn(async root => ({ enabled: root === "/a", routingEnabled: root === "/a" }));
  const classify = vi.fn(() => ({ status: "uncertain" }));
  const loadResolverInput = vi.fn(); const server = await bridge({ readActivation, classify, loadResolverInput });
  const result = await Promise.all([request(server.socketPath, { request: input("/a") }), request(server.socketPath, { request: input("/b") })]);
  expect(classify).toHaveBeenCalledTimes(1); expect(loadResolverInput).not.toHaveBeenCalled();
  expect(result[1].body.decision.diagnostics[0].code).toBe("intelligence_disabled");
  expect(fs.statSync(server.socketPath).mode & 0o777).toBe(0o600);
});
it("asks for native evidence only after a usable local classification", async () => {
  const loadResolverInput = vi.fn(async () => { throw Object.assign(Error(), { code: "native_catalog_required" }); });
  const server = await bridge({ readActivation: async () => ({ enabled: true, routingEnabled: true }), loadResolverInput });
  const result = await request(server.socketPath, { request: input("/a") });
  expect(result.body).toEqual({ needsEvidence: true }); expect(loadResolverInput).toHaveBeenCalledTimes(1);
});
it("preserves unknown native versions without classification, inference or discovery", async () => {
  const classify = vi.fn(); const loadResolverInput = vi.fn();
  const server = await bridge({ readActivation: async () => ({ enabled: true, routingEnabled: true }), classify, loadResolverInput });
  const result = await request(server.socketPath, { request: { ...input("/a"), runtimeVersion: "future" } });
  expect(result.body.decision.diagnostics[0].code).toBe("routing_unverified"); expect(classify).not.toHaveBeenCalled(); expect(loadResolverInput).not.toHaveBeenCalled();
});
it("passes bounded native evidence to the shared input loader without accepting another operation", async () => {
  const native = { version: "2.1.302", providerPages: [] };
  const loadResolverInput = vi.fn(async () => { throw Object.assign(Error(), { code: "native_catalog_invalid" }); });
  const server = await bridge({ readActivation: async () => ({ enabled: true, routingEnabled: true }), loadResolverInput });
  const result = await request(server.socketPath, { request: input("/a"), native });
  expect(loadResolverInput).toHaveBeenCalledWith("/a", native);
  expect(result.body.decision.diagnostics).toContainEqual({ code: "native_catalog_invalid" });
  expect((await request(server.socketPath, { request: input("/a") }, "/run-command")).status).toBe(404);
});
it.each(["{", JSON.stringify({ request: { ...input("/a"), repoRoot: "relative" } }), "x".repeat(1048577)])("rejects malformed, relative or oversized IPC input", async body => {
  const loadResolverInput = vi.fn(); const server = await bridge({ loadResolverInput });
  expect((await request(server.socketPath, body)).status).toBe(400); expect(loadResolverInput).not.toHaveBeenCalled();
});
it("removes only its own socket and private directory when the session closes", async () => {
  const server = await bridge(); const socket = server.socketPath; expect(fs.existsSync(socket)).toBe(true);
  await server.close(); expect(fs.existsSync(socket)).toBe(false);
});

it.each([
  [true, true, "2.1.302", { ready: true }],
  [false, true, "2.1.302", "intelligence_disabled"],
  [true, false, "2.1.302", "routing_disabled"],
  [true, true, "2.1.304", { ready: true }],
  [true, true, "2.1.307", { ready: true }],
  [true, true, "2.1.303", "routing_unverified"],
  [true, true, "2.1.306", "routing_unverified"],
])("checks each activation axis before any native discovery: %s %s %s", async (enabled, routingEnabled, runtimeVersion, expected) => {
  const readActivation = vi.fn(async () => ({ enabled, routingEnabled }));
  const classify = vi.fn(); const loadResolverInput = vi.fn();
  const server = await bridge({ readActivation, classify, loadResolverInput });
  const result = await request(server.socketPath, { action: "activation", request: { ...input("/enabled"), runtimeVersion } });
  expect(readActivation).toHaveBeenCalledExactlyOnceWith("/enabled");
  if (typeof expected === "object") expect(result).toEqual({ status: 200, body: expected });
  else expect(result.body.decision.diagnostics).toContainEqual(expect.objectContaining({ code: expected }));
  expect(classify).not.toHaveBeenCalled(); expect(loadResolverInput).not.toHaveBeenCalled();
});

it("returns a bounded generic diagnostic if activation cannot be read", async () => {
  const server = await bridge({ readActivation: async () => { throw Error("private filesystem contents"); } });
  const result = await request(server.socketPath, { action: "activation", request: input("/a") });
  expect(result).toEqual({ status: 200, body: { decision: { status: "preserved", diagnostics: [{ code: "routing_preparation_failed" }] } } });
});

it.each([
  null, {}, { request: null }, { request: { ...input("/a"), repoRoot: 3 } },
  { request: input("/" + "a".repeat(4096)) }, { request: input("/a\u0000b") },
  { request: input("/a\u200db") }, { request: { ...input("/a"), prompt: 3 } },
  { request: { ...input("/a"), prompt: "x".repeat(16385) } },
  { request: { ...input("/a"), runtimeVersion: 302 } },
  { request: input("/a"), action: "execute" },
])("rejects invalid request fields before reading project state: %j", async body => {
  const readActivation = vi.fn(); const server = await bridge({ readActivation });
  expect((await request(server.socketPath, body)).status).toBe(400);
  expect(readActivation).not.toHaveBeenCalled();
});

it("enforces UTF-8 and the byte boundary even for otherwise valid JSON", async () => {
  const readActivation = vi.fn(async () => ({ enabled: false }));
  const server = await bridge({ readActivation });
  const base = JSON.stringify({ request: { ...input("/" + "a".repeat(4095)), prompt: "x".repeat(16384) } });
  const bounded = base + " ".repeat(1048576 - Buffer.byteLength(base));
  expect((await request(server.socketPath, bounded)).status).toBe(200);
  expect(readActivation).toHaveBeenCalledTimes(1);
  expect((await request(server.socketPath, bounded + " ")).status).toBe(400);
  const invalidUtf8 = Buffer.concat([Buffer.from('{"ignored":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","request":' + JSON.stringify(input("/a")) + '}')]);
  expect((await request(server.socketPath, invalidUtf8)).status).toBe(400);
  expect(readActivation).toHaveBeenCalledTimes(1);
  expect(fs.statSync(server.socketPath.slice(0, server.socketPath.lastIndexOf("/"))).mode & 0o777).toBe(0o700);
});

it.each(["GET", "PUT", "DELETE"])("rejects the %s method without reading activation", async method => {
  const readActivation = vi.fn(); const server = await bridge({ readActivation });
  expect((await request(server.socketPath, "", "/prepare", method)).status).toBe(404);
  expect(readActivation).not.toHaveBeenCalled();
});

it.each(["routing_unverified", "native_catalog_invalid", "native_catalog_unavailable", "session_project_limit"])("reports a bounded %s source failure", async code => {
  const server = await bridge({ readActivation: async () => ({ enabled: true, routingEnabled: true }), loadResolverInput: async () => { throw Object.assign(Error("private"), { code }); } });
  const result = await request(server.socketPath, { action: "prepare", request: input("/a") });
  expect(result.body.decision.status).toBe("preserved");
  expect(result.body.decision.diagnostics).toContainEqual({ code });
  expect(JSON.stringify(result)).not.toContain("private");
});
