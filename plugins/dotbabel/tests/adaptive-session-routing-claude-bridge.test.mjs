import { afterEach, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import { openClaudeRoutingBridge } from "../src/adaptive-session-routing/claude-bridge.mjs";

const sessions = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); });
const request = (socketPath, body, url = "/prepare") => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, path: url, method: "POST", agent: false, headers: { "content-type": "application/json" } }, response => {
    let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
  });
  req.on("error", reject); req.end(typeof body === "string" ? body : JSON.stringify(body));
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
