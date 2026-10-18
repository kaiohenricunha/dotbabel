import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { startAntigravityPeer, antigravityHook } from "../../src/peer/integrations/antigravity.mjs";
import { createNativeIntegration } from "../../src/peer/integration.mjs";
import { deliver } from "../../src/peer/transport.mjs";
import { setupHooks } from "../../src/peer/setup.mjs";
import { PeerStore } from "../../src/peer/store.mjs";
import { repository } from "../../src/peer/identity.mjs";
import { readNativeRegistration } from "../../src/peer/native-registry.mjs";
import { invokePeer } from "../../src/peer/cli.mjs";
const closers = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
function fixture() {
  const root = makeTempDir("peer-agy-"),
    worktree = path.join(root, "repo");
  fs.mkdirSync(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  setupHooks("antigravity", {}, worktree);
  const env = {
    ...process.env,
    DOTBABEL_PEER_STATE_DIR: path.join(root, "state"),
    DOTBABEL_PEER_NO_RELAY: "1",
  };
  return { worktree, env };
}
const id = "00000000-0000-4000-8000-000000000021";
it("refuses to start a managed actor with missing or disabled native guards", () => {
  const { worktree, env } = fixture();
  fs.unlinkSync(path.join(worktree, ".agents/hooks.json"));
  expect(() => startAntigravityPeer({ worktree, env, role: "main" })).toThrow(/hooks|setup/);
});
it("binds the emitted native ID, preserves default flags, and admits prompts without claiming processing", async () => {
  const { worktree, env } = fixture();
  const events = [];
  let launch;
  const bridge = startAntigravityPeer({
    worktree,
    env,
    role: "main",
    onEvent: (event) => events.push(event),
    spawnChild: (file, args, opts) => {
      launch = { file, args, opts };
      return spawn(
        process.execPath,
        [
          "-e",
          `console.log(JSON.stringify({event:'init',conversation_id:'${id}',init:{permission_mode:'request-review'}}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({event:'result',result:{conversation_id:'${id}',status:'SUCCESS',response:m.message.content}}))})`,
        ],
        opts,
      );
    },
  });
  closers.push(bridge.close);
  const pair = await bridge.ready;
  expect(pair.main).toMatchObject({ harness: "antigravity", sessionId: id });
  expect(launch.args).toEqual(["--input-format", "stream-json", "--output-format", "stream-json"]);
  expect(launch.opts.env.CODEX_THREAD_ID).toBeUndefined();
  expect(launch.opts.env.DOTBABEL_PEER_MANAGED).toBe("antigravity");
  expect((await deliver(pair.main, "owned notification")).state).toBe("transport_accepted");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events.some((e) => e.result?.response === "owned notification")).toBe(true);
  expect(pair.messages).toEqual([]);
});
it("maps the native guard and context contract without approving ordinary tools", async () => {
  const { worktree, env } = fixture();
  const host = createNativeIntegration({
    harness: "antigravity",
    worktree,
    env,
    notify: async () => {},
  });
  closers.push(() => host.close());
  const main = "00000000-0000-4000-8000-000000000022";
  const pair = await host.invoke(main, ["main"]);
  await host.invoke(id, ["advisor", pair.code]);
  const input = { conversationId: id, workspacePaths: [worktree] };
  const opts = { env, startPid: process.pid };
  const hook = (name, args) =>
    antigravityHook("PreToolUse", { ...input, toolCall: { name, args } }, opts);
  expect(await hook("view_file", { AbsolutePath: path.join(worktree, "file") })).toEqual({
    decision: "allow",
  });
  expect(await hook("run_command", { CommandLine: "git diff", Cwd: worktree })).toEqual({
    decision: "allow",
  });
  for (const name of [
    "write_to_file",
    "invoke_subagent",
    "send_command_input",
    "call_mcp_tool",
    "ask_permission",
  ])
    expect((await hook(name, {})).decision).toBe("deny");
  expect(
    (await hook("run_command", { CommandLine: "git diff; touch stolen", Cwd: worktree })).decision,
  ).toBe("deny");
  const coordinated = await hook("run_command", {
    CommandLine: "dotbabel peer status",
    Cwd: worktree,
  });
  expect(coordinated.overwrite.CommandLine).toMatch(/^printf/);
  expect(coordinated.decision).toBe("auto_approve");
  expect(coordinated.permissionOverrides).toBeUndefined();
  expect(
    (await antigravityHook("PreInvocation", input, opts)).injectSteps[0].ephemeralMessage,
  ).toContain("Advisor");
  await host.invoke(main, ["ask", "Inspect"]);
  const task = await host.invoke(id, ["next"]);
  expect((await antigravityHook("Stop", { ...input, fullyIdle: true }, opts)).reason).toContain(
    task.id,
  );
  expect(await antigravityHook("Stop", { ...input, fullyIdle: true }, opts)).toEqual({});
  expect((await host.invoke(id, ["status"])).paused).toBe(true);
});
it("leaves unmanaged sessions untouched and refuses a managed actor without registration", async () => {
  const { worktree, env } = fixture();
  const input = {
    conversationId: id,
    workspacePaths: [worktree],
    toolCall: { name: "write_to_file", args: {} },
  };
  expect(await antigravityHook("PreToolUse", input, { env })).toEqual({});
  await expect(
    antigravityHook("PreToolUse", input, { env: { ...env, DOTBABEL_PEER_MANAGED: "antigravity" } }),
  ).rejects.toThrow(/registration/);
});
it("rejects unsupported roles and malformed native IDs before creating an actor", async () => {
  const { worktree, env } = fixture();
  expect(() => startAntigravityPeer({ worktree, env, role: "other" })).toThrow(/role/);
  expect(() => startAntigravityPeer({ worktree, env, role: "main", conversation: id })).toThrow(
    /pair/,
  );
  const bridge = startAntigravityPeer({
    worktree,
    env,
    role: "main",
    spawnChild: (_file, _args, opts) =>
      spawn(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify({event:'init',conversation_id:'invented'}));setInterval(()=>{},1000)",
        ],
        opts,
      ),
  });
  closers.push(bridge.close);
  await expect(bridge.ready).rejects.toThrow(/session id/);
});
it("refuses a resumed process that emits a different conversation ID", async () => {
  const { worktree, env } = fixture(),
    other = "00000000-0000-4000-8000-000000000099";
  const bridge = startAntigravityPeer({
    worktree,
    env,
    role: "advisor",
    pair: "pair-unavailable",
    conversation: id,
    spawnChild: (_file, _args, opts) =>
      spawn(
        process.execPath,
        [
          "-e",
          `console.log(JSON.stringify({event:'init',conversation_id:'${other}'}));process.stdin.resume();`,
        ],
        opts,
      ),
  });
  closers.push(bridge.close);
  await expect(bridge.ready).rejects.toThrow(/different native conversation/);
  await expect(bridge.done).rejects.toThrow(/different native conversation/);
  expect(readNativeRegistration(env.DOTBABEL_PEER_STATE_DIR, `antigravity:${other}`)).toBeNull();
});
it("reports a failed lifecycle write while still removing its socket and registration", async () => {
  const { worktree, env } = fixture();
  const bridge = startAntigravityPeer({
    worktree,
    env,
    role: "main",
    spawnChild: (_file, _args, opts) =>
      spawn(
        process.execPath,
        [
          "-e",
          `console.log(JSON.stringify({event:'init',conversation_id:'${id}'}));process.stdin.resume();`,
        ],
        opts,
      ),
  });
  closers.push(bridge.close);
  await bridge.ready;
  fs.writeFileSync(
    new PeerStore(env.DOTBABEL_PEER_STATE_DIR, repository(worktree).key).file,
    "broken",
  );
  bridge.end();
  await expect(bridge.done).rejects.toThrow();
  expect(readNativeRegistration(env.DOTBABEL_PEER_STATE_DIR, `antigravity:${id}`)).toBeNull();
});
it("pauses for a new native denial but permits explicit recovery when later results repeat its cumulative history", async () => {
  const { worktree, env } = fixture(),
    events = [];
  const main = createNativeIntegration({
    harness: "opencode",
    worktree,
    env,
    notify: async () => {},
  });
  closers.push(() => main.close());
  const opening = await main.invoke("ses_recovery", ["main"]);
  const bridge = startAntigravityPeer({
    worktree,
    env,
    role: "advisor",
    code: opening.code,
    onEvent: (event) => events.push(event),
    spawnChild: (_file, _args, opts) =>
      spawn(
        process.execPath,
        [
          "-e",
          `let denied=[];console.log(JSON.stringify({event:'init',conversation_id:'${id}'}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const text=JSON.parse(line).message.content;if(text==='deny')denied.push({action:'command',display_name:'RunCommand'});console.log(JSON.stringify({event:'result',result:{conversation_id:'${id}',status:'SUCCESS',response:text,denied_actions:denied}}))});`,
        ],
        opts,
      ),
  });
  closers.push(bridge.close);
  const pair = await bridge.ready;
  await main.invoke("ses_recovery", ["ask", "Inspect native permission recovery"]);
  await invokePeer(pair.advisor, ["next"], env);
  await bridge.send("deny");
  await vi.waitFor(async () =>
    expect((await main.invoke("ses_recovery", ["status"])).paused).toBe(true),
  );
  expect((await main.invoke("ses_recovery", ["queue"]))[0]).toMatchObject({
    state: "queued",
    lease: null,
    result: null,
  });
  await main.invoke("ses_recovery", ["resume"]);
  const current = await invokePeer(pair.advisor, ["next"], env);
  await bridge.send("recovered");
  await vi.waitFor(() =>
    expect(events.some((event) => event.result?.response === "recovered")).toBe(true),
  );
  expect((await main.invoke("ses_recovery", ["status"])).paused).toBe(false);
  expect((await main.invoke("ses_recovery", ["queue"]))[0]).toMatchObject({
    state: "running",
    lease: current.lease,
    result: null,
  });
  await bridge.send("deny");
  await vi.waitFor(async () =>
    expect((await main.invoke("ses_recovery", ["status"])).paused).toBe(true),
  );
});
it("resumes the real native conversation and reconnects the same durable pairing", async () => {
  const { worktree, env } = fixture();
  const main = createNativeIntegration({
    harness: "opencode",
    worktree,
    env,
    notify: async () => {},
  });
  closers.push(() => main.close());
  const opening = await main.invoke("ses_resume", ["main"]);
  const spawnNative = (_file, _args, opts) =>
    spawn(
      process.execPath,
      [
        "-e",
        `console.log(JSON.stringify({event:'init',conversation_id:'${id}'}));process.stdin.resume();`,
      ],
      opts,
    );
  const old = startAntigravityPeer({
    worktree,
    env,
    role: "advisor",
    code: opening.code,
    spawnChild: spawnNative,
  });
  closers.push(old.close);
  const pair = await old.ready;
  const request = await main.invoke("ses_resume", ["ask", "Retain this investigation"]);
  const claimed = await invokePeer(pair.advisor, ["next"], env);
  await old.close();
  let args;
  const resumed = startAntigravityPeer({
    worktree,
    env,
    role: "advisor",
    pair: pair.id,
    conversation: id,
    spawnChild: (file, argv, opts) => {
      args = argv;
      return spawnNative(file, argv, opts);
    },
  });
  closers.push(resumed.close);
  const current = await resumed.ready;
  expect(args.slice(-2)).toEqual(["--conversation", id]);
  expect(current.id).toBe(pair.id);
  expect(current.advisor.sessionId).toBe(id);
  expect((await main.invoke("ses_resume", ["queue"]))[0]).toMatchObject({
    id: request.id,
    state: "queued",
    lease: null,
  });
  await expect(
    invokePeer(
      current.advisor,
      ["complete", request.id, "--lease", claimed.lease, "--result", "stale"],
      env,
    ),
  ).rejects.toThrow(/lease|running/);
});
