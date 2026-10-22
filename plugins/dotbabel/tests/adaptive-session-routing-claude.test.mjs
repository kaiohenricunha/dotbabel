import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { runClaudeTerminal } from "../src/adaptive-session-routing/claude-launcher.mjs";

it("never changes a subagent configuration", async () => {
  const files = ["agents/security-auditor.md", "agents/data-scientist.md", "plugins/dotbabel/templates/claude/agents/security-auditor.md"];
  const before = files.map(file => readFileSync(file, "utf8"));
  const requests = [
    { turnId: "worker-one", index: 0, agentId: "security-worker", model: "worker-strong", effort: "max", messageCount: 9 },
    { turnId: "worker-two", index: 1, agentId: "data-worker", model: "worker-analysis", effort: "medium", messageCount: 17 },
  ];
  await runClaudeTerminal({ repoRoot: process.cwd(), model: "auto", effort: "auto" }, { readActivation: async () => ({ enabled: true, routingEnabled: true }), runtimeVersion: async () => "2.1.302", startNative: async ({ args }) => {
    const module = await import(pathToFileURL(join(args[1], "hooks/claude-mod.mjs")).href);
    const hooks = new Map(); const prepare = vi.fn();
    module.registerClaudeRouting((name, handler) => { hooks.set(name, handler); return { catch() {} }; }, { prepare });
    const native = vi.fn(async function* (request) { return { turnId: request.turnId, index: request.index, toolUses: [], answer: "worker response", usage: null, stopReason: "end_turn" }; });
    for (const request of requests) {
      const stream = hooks.get("turn.step")({}, request, native); const result = await stream.next(); expect(result.done).toBe(true);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(native.mock.calls.map(call => call[0])).toEqual(requests);
    expect(native.mock.calls.every((call, index) => call[0] === requests[index])).toBe(true);
    return 0;
  } });
  expect(files.map(file => readFileSync(file, "utf8"))).toEqual(before);
});
