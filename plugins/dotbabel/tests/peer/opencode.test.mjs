import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { setupOpenCodePeer } from "../../src/peer/integrations/opencode.mjs";
import { deliver } from "../../src/peer/transport.mjs";
import { PeerStore } from "../../src/peer/store.mjs";
import { repository } from "../../src/peer/identity.mjs";
const cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const root = makeTempDir("peer-oc-"),
    directory = path.join(root, "repo");
  fs.mkdirSync(directory);
  execFileSync("git", ["init", "-q", directory]);
  const hooks = {},
    tools = {},
    queued = [];
  const ctx = {
    app: { version: "2.0.5" },
    location: { directory },
    tool: {
      transform: async (f) =>
        f({
          add: (t) => {
            tools[t.name] = t;
          },
        }),
      hook: async (name, f) => {
        hooks[`tool.${name}`] = f;
      },
    },
    permission: {
      hook: async (name, f) => {
        hooks[`permission.${name}`] = f;
      },
    },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, location: { directory } }),
      prompt: async (input) => {
        queued.push(input);
        return { id: "msg_native", sessionID: input.sessionID };
      },
      hook: async (name, f) => {
        hooks[`session.${name}`] = f;
      },
    },
    event: { subscribe: async function* () {} },
  };
  const env = { DOTBABEL_PEER_STATE_DIR: path.join(root, "state"), DOTBABEL_PEER_NO_RELAY: "1" };
  cleanups.push(await setupOpenCodePeer(ctx, { env }));
  const invoke = async (sessionID, argv) =>
    JSON.parse((await tools.dotbabel_peer.execute({ argv }, { sessionID })).content);
  const pair = await invoke("ses_main", ["main"]);
  await invoke("ses_advisor", ["advisor", pair.code]);
  return { ctx, hooks, tools, queued, invoke, pair, directory, env };
}
it("registers a native scoped tool and queues transport into the exact existing session", async () => {
  const { pair, queued } = await fixture();
  expect((await deliver(pair.main, "Native peer notification")).state).toBe("transport_accepted");
  expect(queued).toEqual([
    { sessionID: "ses_main", text: "Native peer notification", delivery: "queue" },
  ]);
});
it("restores paired SDK sessions after plugin reload without requiring another model turn", async () => {
  const { ctx, pair, directory, env, queued } = await fixture();
  await cleanups.at(-1)();
  cleanups.push(await setupOpenCodePeer(ctx, { env }));
  const current = (
    await new PeerStore(env.DOTBABEL_PEER_STATE_DIR, repository(directory).key).read()
  ).pairs.find((p) => p.id === pair.id);
  expect((await deliver(current.main, "wake after reload")).state).toBe("transport_accepted");
  expect(queued.at(-1)).toEqual({
    sessionID: "ses_main",
    text: "wake after reload",
    delivery: "queue",
  });
});
it("uses the actual v2 event data to continue work once without inventing completion", async () => {
  const { ctx, env, invoke, queued } = await fixture();
  const request = await invoke("ses_main", ["ask", "Inspect the real native event"]);
  await cleanups.at(-1)();
  ctx.event.subscribe = async function* () {
    yield { type: "session.execution.succeeded", data: { sessionID: "ses_advisor" } };
    yield { type: "session.execution.succeeded", data: { sessionID: "ses_advisor" } };
  };
  cleanups.push(await setupOpenCodePeer(ctx, { env }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(queued.filter((x) => x.sessionID === "ses_advisor")).toHaveLength(1);
  expect(queued.at(-1).text).toContain(request.id);
  expect((await invoke("ses_advisor", ["status"])).paused).toBe(true);
  expect((await invoke("ses_advisor", ["queue"]))[0]).toMatchObject({
    state: "running",
    result: null,
  });
});
it("routes literal peer shell commands through the native SDK identity before any inherited CLI identity", async () => {
  const { hooks } = await fixture();
  const event = {
    sessionID: "ses_main",
    tool: "shell",
    input: { command: "dotbabel peer status", timeout: 1200 },
  };
  await hooks["tool.execute.before"](event);
  expect(event.input.command).toMatch(/^printf /);
  expect(event.input.command).toContain('"harness":"opencode"');
  expect(event.input.timeout).toBe(1200);
});
it("denies Advisor mutation and unsafe shell actions while preserving Main and native read decisions", async () => {
  const { hooks } = await fixture();
  for (const [action, resources] of [
    ["edit", ["a.txt"]],
    ["shell", ["git status; touch stolen"]],
    ["mcp", ["unknown"]],
    ["subagent", ["build"]],
  ]) {
    const input = { sessionID: "ses_advisor", action, resources, effect: "allow" };
    await hooks["permission.evaluate"](input);
    expect(input.effect).toBe("deny");
  }
  const read = { sessionID: "ses_advisor", action: "read", resources: ["a.txt"], effect: "ask" };
  await hooks["permission.evaluate"](read);
  expect(read.effect).toBe("ask");
  const main = { sessionID: "ses_main", action: "edit", resources: ["a.txt"], effect: "ask" };
  await hooks["permission.evaluate"](main);
  expect(main.effect).toBe("ask");
  const safe = {
    sessionID: "ses_advisor",
    action: "shell",
    resources: ["git status"],
    effect: "ask",
  };
  await hooks["permission.evaluate"](safe);
  expect(safe.effect).toBe("ask");
});
it("covers direct tool writes and adds persistent role context without editing the user prompt", async () => {
  const { hooks } = await fixture();
  await expect(
    hooks["tool.execute.before"]({
      sessionID: "ses_advisor",
      tool: "write",
      input: { path: "a.txt", content: "changed" },
    }),
  ).rejects.toThrow(/read-only/);
  await expect(
    hooks["tool.execute.before"]({
      sessionID: "ses_main",
      tool: "write",
      input: { path: "a.txt", content: "allowed by native policy" },
    }),
  ).resolves.toBeUndefined();
  const context = { sessionID: "ses_advisor", system: [], tools: {} };
  await hooks["session.context"](context);
  expect(context.system.some((p) => p.text.includes("Advisor"))).toBe(true);
  expect(context.system.some((p) => p.text.includes("dotbabel_peer"))).toBe(true);
});
it("refuses a session that belongs to a different plugin location", async () => {
  const { ctx, tools } = await fixture();
  ctx.session.get = async ({ sessionID }) => ({
    id: sessionID,
    location: { directory: "/tmp/another-project" },
  });
  await expect(
    tools.dotbabel_peer.execute({ argv: ["main"] }, { sessionID: "ses_foreign" }),
  ).rejects.toThrow(/location|worktree/);
});
it("permits a bounded literal execute wrapper but refuses arbitrary JavaScript and mutation", async () => {
  const { hooks } = await fixture();
  const before = (code) =>
    hooks["tool.execute.before"]({ sessionID: "ses_advisor", tool: "execute", input: { code } });
  await expect(
    before('return await tools["dotbabel_peer"]({"argv":["status"]});'),
  ).resolves.toBeUndefined();
  await expect(
    before('const result = await tools.read({"filePath":"a.txt"}); return result;'),
  ).resolves.toBeUndefined();
  for (const code of [
    "return process.env;",
    'return await fetch("https://example.com");',
    'return await tools.write({"path":"stolen","content":"x"});',
    'return await tools.shell({"command":"git status; touch stolen"});',
    "return await tools.read((()=>{throw Error()})());",
    'return await tools.read({"filePath":"a"}); await tools.write({});',
  ]) {
    await expect(before(code)).rejects.toThrow(/read-only/);
  }
});
