import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { startCopilotPeer } from "../../src/peer/integrations/copilot.mjs";
import { deliver } from "../../src/peer/transport.mjs";
const closers = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function fixture() {
  const root = makeTempDir("peer-copilot-"),
    directory = path.join(root, "repo");
  fs.mkdirSync(directory);
  execFileSync("git", ["init", "-q", directory]);
  const env = { DOTBABEL_PEER_STATE_DIR: path.join(root, "state"), DOTBABEL_PEER_NO_RELAY: "1" };
  const clients = [];
  for (const sessionId of [
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
  ]) {
    const handlers = {},
      sends = [];
    let config;
    const session = {
      sessionId,
      send: async (msg) => {
        sends.push(msg);
        return "native-message";
      },
      on: (type, f) => {
        handlers[type] = f;
        return () => delete handlers[type];
      },
      log: async () => {},
    };
    const extension = await startCopilotPeer(
      async (options) => {
        config = options;
        return session;
      },
      { directory, env },
    );
    closers.push(extension.close);
    const invoke = async (argv, id = sessionId) =>
      JSON.parse(await config.tools[0].handler({ argv }, { sessionId: id }));
    clients.push({ extension, config, handlers, sends, invoke, sessionId });
  }
  const pair = await clients[0].invoke(["main"]);
  await clients[1].invoke(["advisor", pair.code]);
  return { main: clients[0], advisor: clients[1], pair, directory };
}
it("joins the native foreground session and queues a message without a permission or model override", async () => {
  const { main, pair } = await fixture();
  expect(main.config.onPermissionRequest).toBeUndefined();
  expect(main.config.model).toBeUndefined();
  expect((await deliver(pair.main, "native finding")).state).toBe("transport_accepted");
  expect(main.sends).toEqual([{ prompt: "native finding", mode: "enqueue" }]);
});
it("translates native tool names while leaving allowed native permission prompts unchanged", async () => {
  const { main, advisor, directory } = await fixture();
  const pre = (client, name, args) =>
    client.config.hooks.onPreToolUse(
      { cwd: directory, toolName: name, toolArgs: args },
      { sessionId: client.sessionId },
    );
  for (const [name, args] of [
    ["edit", {}],
    ["bash", { command: "git status; touch stolen" }],
    ["write_bash", {}],
    ["task", {}],
    ["unknown_mcp", {}],
  ])
    expect((await pre(advisor, name, args)).permissionDecision).toBe("deny");
  expect(await pre(advisor, "view", { path: "a.txt" })).toBeUndefined();
  expect(await pre(advisor, "rg", { pattern: "race", paths: "." })).toBeUndefined();
  expect(await pre(advisor, "bash", { command: "git diff" })).toBeUndefined();
  expect(await pre(main, "edit", {})).toBeUndefined();
});
it("binds the native peer tool to SDK identity and rejects actor or setup substitution", async () => {
  const { main } = await fixture();
  await expect(main.invoke(["status"], "00000000-0000-4000-8000-000000000099")).rejects.toThrow(
    /session/,
  );
  const refused = await main.config.tools[0].handler(
    { argv: ["setup", "--harness", "both"] },
    { sessionId: main.sessionId },
  );
  expect(refused).toMatchObject({ resultType: "failure" });
  expect(refused.error).toMatch(/operation|integration/);
});
it("returns useful native failure details for a refused peer operation", async () => {
  const { main } = await fixture();
  const result = await main.config.tools[0].handler(
    { argv: ["advisor", "BADCODE"] },
    { sessionId: main.sessionId },
  );
  expect(result.resultType).toBe("failure");
  expect(JSON.parse(result.textResultForLlm).error.code).toBe("PEER_OPERATION");
  expect(result.error).toBeTruthy();
});
it("retains role context and uses native idle continuation without fabricating completion", async () => {
  const { main, advisor, directory } = await fixture();
  await main.invoke(["ask", "Inspect"]);
  const request = await advisor.invoke(["next"]);
  const context = await advisor.config.hooks.onUserPromptSubmitted(
    { cwd: directory, prompt: "Continue" },
    { sessionId: advisor.sessionId },
  );
  expect(context.additionalContext).toContain("Advisor");
  await advisor.handlers["session.idle"]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(advisor.sends.some((m) => m.prompt.includes(request.id))).toBe(true);
  expect((await advisor.invoke(["queue"]))[0].state).toBe("running");
});
it("uses native lifecycle errors to preserve unfinished work and closes only its endpoint", async () => {
  const { main, advisor, directory } = await fixture();
  await main.invoke(["ask", "Inspect interruption"]);
  const active = await advisor.invoke(["next"]),
    context = { sessionId: advisor.sessionId };
  expect(
    (await advisor.config.hooks.onSessionStart({ cwd: directory }, context)).additionalContext,
  ).toContain("Advisor");
  await advisor.config.hooks.onErrorOccurred({ recoverable: true }, context);
  expect((await advisor.invoke(["queue"]))[0].lease).toBe(active.lease);
  await advisor.config.hooks.onErrorOccurred({ recoverable: false }, context);
  expect((await advisor.invoke(["queue"]))[0]).toMatchObject({
    state: "queued",
    lease: null,
    result: null,
  });
  expect((await advisor.invoke(["status"])).paused).toBe(true);
  await advisor.config.hooks.onSessionEnd({ cwd: directory }, context);
  expect((await main.invoke(["status"])).advisor.ended).toBe(true);
});
it("coordinates literal native shell operations with SDK identity and refuses composed writes", async () => {
  const { main, advisor, directory } = await fixture(),
    hooks = main.config.hooks;
  const response = await hooks.onPreToolUse(
    { cwd: directory, toolName: "bash", toolArgs: { command: "dotbabel peer status" } },
    { sessionId: main.sessionId },
  );
  expect(response.modifiedArgs.command).toMatch(/^printf/);
  expect(response.modifiedArgs.command).toContain('"harness":"copilot"');
  const denied = await advisor.config.hooks.onPreToolUse(
    {
      cwd: directory,
      toolName: "bash",
      toolArgs: '{"command":"dotbabel peer status; touch forbidden"}',
    },
    { sessionId: advisor.sessionId },
  );
  expect(denied.permissionDecision).toBe("deny");
  expect(fs.existsSync(path.join(directory, "forbidden"))).toBe(false);
});
