import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { beforeEach, afterEach, vi, it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
const ctx = vi.hoisted(() => ({ who: null, live: true, input: [], spawned: 0 }));
vi.mock("../../src/peer/identity.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  currentSession: () => {
    if (!ctx.who) throw new Error("no session");
    return ctx.who;
  },
  endpointAlive: (who) => Boolean(who && !who.ended && ctx.live),
}));
vi.mock("../../src/peer/relay.mjs", () => ({ tick: async () => false }));
vi.mock("node:readline", () => ({
  createInterface: () => ({
    async *[Symbol.asyncIterator]() {
      for (const x of ctx.input) yield x;
    },
  }),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: () => {
    ctx.spawned++;
    return { on() {}, unref() {} };
  },
}));
import { runPeer, invokePeer, peerCommand } from "../../src/peer/cli.mjs";
import { repository } from "../../src/peer/identity.mjs";
import { PeerStore } from "../../src/peer/store.mjs";
import { registerMain, pairAdvisor } from "../../src/peer/state.mjs";
let repo, env, out, err, store, main, advisor;
beforeEach(() => {
  repo = makeTempDir("peer-commands-");
  execFileSync("git", ["init", "-q", repo]);
  env = { DOTBABEL_PEER_STATE_DIR: makeTempDir("peer-state-"), DOTBABEL_PEER_NO_RELAY: "1" };
  main = {
    key: "claude:main",
    harness: "claude",
    sessionId: "main",
    repo: repository(repo).key,
    worktree: repo,
    pid: process.pid,
    procStart: "x",
  };
  advisor = { ...main, key: "codex:advisor", harness: "codex", sessionId: "advisor" };
  store = new PeerStore(env.DOTBABEL_PEER_STATE_DIR, main.repo);
  ctx.who = main;
  ctx.live = true;
  ctx.input = [];
  ctx.spawned = 0;
  out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());
async function run(...args) {
  out.mockClear();
  err.mockClear();
  const code = await runPeer([...args, "--repo-root", repo, "--json"], env);
  const text = out.mock.calls.map((x) => x[0]).join("");
  return {
    code,
    value: text ? JSON.parse(text) : null,
    err: err.mock.calls.map((x) => x[0]).join(""),
  };
}
async function pair() {
  const p = (await run("main")).value;
  ctx.who = advisor;
  expect((await run("advisor", p.code)).code).toBe(0);
  return p;
}
it("returns native mirror fields with a send between Claude sessions, never storing them", async () => {
  main.socket = "/run/user/1/cc-socks/10.sock";
  advisor = {
    ...advisor,
    key: "claude:advisor",
    harness: "claude",
    socket: "/run/user/1/cc-socks/20.sock",
  };
  await pair();
  const sent = (await run("send", "main", "race in save()", "--kind", "finding")).value;
  expect(sent.native.to).toBe("uds:/run/user/1/cc-socks/10.sock");
  expect(sent.native.message.startsWith(`[peer ${sent.id} seq ${sent.seq} finding]`)).toBe(true);
  expect((await store.read()).pairs[0].messages[0].native).toBeUndefined();
  ctx.who = main;
  const received = (await run("receive")).value;
  expect(received[0].id).toBe(sent.id);
  expect(received[0].native).toBeUndefined();
});
it("returns no native mirror when the recipient is not a Claude session", async () => {
  await pair();
  ctx.who = main;
  expect((await run("send", "advisor", "note")).value.native).toBe(null);
});
it("runs registration, queue management, results, history and member messages in process", async () => {
  const p = await pair();
  const a = (await run("ask", "one", "--dedupe", "one", "--forward", "explicit")).value;
  const b = (await run("ask", "two", "--parent", a.id)).value;
  await run("priority", b.id, "--priority", "8");
  const r = (await run("next")).value;
  expect(r.id).toBe(b.id);
  const m = (await run("send", "main", "why", "--kind", "question", "--request", b.id)).value;
  await run("wait", b.id, "--lease", r.lease, "--result", "awaiting", "--reply-to", m.id);
  const aRun = (await run("next")).value;
  expect(aRun.id).toBe(a.id);
  await run("complete", a.id, "--lease", aRun.lease, "--result", "done");
  ctx.who = main;
  expect((await run("receive")).value).toHaveLength(1);
  await run("ack", m.id, "--processed");
  await run("ack", m.id);
  await run("send", "advisor", "because", "--reply-to", m.id, "--kind", "reply");
  ctx.who = advisor;
  const resumed = (await run("next")).value;
  await run("fail", b.id, "--lease", resumed.lease, "--result", "failed");
  await run("retry", b.id);
  await run("cancel", b.id);
  expect((await run("next")).value).toBe(null);
  expect((await run("queue")).value.map((x) => x.state)).toEqual(["completed", "cancelled"]);
  expect((await run("history")).value.messages).toHaveLength(2);
  expect((await run("inspect")).value.main_worktree).toBe(repo);
  await run("pause");
  expect((await run("status")).value.paused).toBe(true);
  await run("resume");
  expect((await run("unpair")).code).toBe(0);
  expect((await run("history", "--pair", p.id)).code).toBe(0);
});
it("recovers an endpoint and explicitly retries uncertain delivery with a bound", async () => {
  const p = await pair(),
    m = (await run("send", "main", "finding")).value;
  await store.transaction((s) => {
    s.pairs[0].messages[0].delivery = { state: "uncertain", attempts: 1 };
  });
  expect((await run("retry-delivery", m.id)).value.state).toBe("persisted");
  expect((await run("retry-delivery", m.id)).code).toBe(1);
  ctx.who = { ...advisor, key: "codex:new", sessionId: "new" };
  ctx.live = false;
  expect((await run("reconnect", "advisor", "--pair", p.id)).value.advisor.sessionId).toBe("new");
});
it("uses the independent input channel while preserving an active investigation", async () => {
  const p = await pair();
  await run("ask", "running");
  await run("next");
  ctx.who = null;
  ctx.input = [
    "",
    "second",
    ".queue",
    ".pause",
    ".resume",
    "x".repeat(16385),
    "third",
    ".quit",
    "ignored",
  ];
  out.mockClear();
  const code = await runPeer(["input", "--pair", p.id, "--repo-root", repo], env);
  expect(code).toBe(0);
  const state = await store.read();
  expect(state.pairs[0].requests.map((r) => r.body)).toEqual(["running", "second", "third"]);
  expect(state.pairs[0].requests[0].state).toBe("running");
  expect(err).toHaveBeenCalled();
});
it("starts only a missing relay and releases foreground relay ownership", async () => {
  const p = await pair();
  delete env.DOTBABEL_PEER_NO_RELAY;
  expect((await run("status")).code).toBe(0);
  expect(ctx.spawned).toBe(1);
  expect((await run("relay", "--pair", p.id)).code).toBe(0);
  expect((await store.read()).pairs[0].relay).toBe(null);
  await store.transaction((s) => {
    s.pairs[0].relay = { pid: process.pid, procStart: null };
  });
  await run("status");
  expect(ctx.spawned).toBe(1);
});
it("supports help/version, validates usage, and returns structured errors", async () => {
  expect(await runPeer(["--version"], env)).toBe(0);
  expect(out.mock.calls.at(-1)[0]).toBe("1.0.0\n");
  expect(await runPeer(["--help"], env)).toBe(0);
  expect(await runPeer([], env)).toBe(0);
  expect(await runPeer(["--unknown"], env)).toBe(64);
  for (const args of [
    ["nope"],
    ["send", "main"],
    ["complete", "x"],
    ["reconnect", "advisor"],
    ["input"],
    ["setup"],
  ])
    expect((await run(...args)).code).toBe(64);
  ctx.who = null;
  expect((await run("main")).code).toBe(2);
  expect((await run("ask", "x", "--pair", "missing")).code).toBe(1);
  expect(await runPeer(["main", "--repo-root", repo], env)).toBe(2);
  const home = makeTempDir("peer-setup-home-");
  env.CLAUDE_CONFIG_DIR = home;
  expect((await run("setup", "--harness", "claude")).code).toBe(0);
});
it("restores Advisor context through hooks and blocks mutation tools", async () => {
  const p = await pair();
  const original = fs.readFileSync;
  let input;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) =>
    file === 0 ? JSON.stringify(input) : original(file, ...args),
  );
  input = { cwd: repo, session_id: "advisor" };
  expect((await run("hook", "SessionStart")).value.hookSpecificOutput.additionalContext).toContain(
    p.id,
  );
  input = { cwd: repo, session_id: "advisor", tool_name: "Edit", tool_input: {} };
  expect((await run("hook", "PreToolUse")).value.hookSpecificOutput.permissionDecision).toBe(
    "deny",
  );
  input = { cwd: repo, session_id: "advisor" };
  await run("hook", "Interrupt");
  expect((await run("status")).value.paused).toBe(true);
  await run("hook", "SessionEnd");
  expect((await store.read()).pairs[0].advisor.ended).toBe(true);
});

it("skips unpaired sessions and keeps only the Advisor guard when a member cannot be resolved", async () => {
  const original = fs.readFileSync,
    gone = path.join(makeTempDir("peer-gone-"), "removed-worktree");
  let input;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) =>
    file === 0 ? JSON.stringify(input) : original(file, ...args),
  );
  async function hook(event, payload) {
    input = payload;
    out.mockClear();
    const code = await runPeer(["hook", event, "--json"], env);
    const text = out.mock.calls.map((x) => x[0]).join("");
    return { code, value: text ? JSON.parse(text) : null };
  }
  const silent = { code: 0, value: null };
  const write = { tool_name: "Write", tool_input: { file_path: "a" } };
  const state = env.DOTBABEL_PEER_STATE_DIR;
  env.DOTBABEL_PEER_STATE_DIR = path.join(state, "not-created");
  expect(await hook("PreToolUse", { session_id: "stranger", cwd: gone, ...write })).toEqual(silent);
  env.DOTBABEL_PEER_STATE_DIR = state;
  expect(await hook("Stop", { session_id: "stranger", cwd: gone })).toEqual(silent);
  await pair();
  fs.writeFileSync(path.join(state, "notes.txt"), "not a ledger");
  expect(await hook("Stop", { session_id: "stranger", cwd: gone })).toEqual(silent);
  expect(await hook("PreToolUse", { session_id: "main", cwd: gone, ...write })).toEqual(silent);
  expect(await hook("Stop", { session_id: "advisor", cwd: gone })).toEqual(silent);
  expect(await hook("PreToolUse", { session_id: "advisor", cwd: gone, tool_name: "Read" })).toEqual(
    silent,
  );
  const denied = await hook("PreToolUse", { session_id: "advisor", cwd: gone, ...write });
  expect(denied.value.hookSpecificOutput.permissionDecision).toBe("deny");
  ctx.who = null;
  const unresolved = await hook("PreToolUse", { session_id: "advisor", cwd: repo, ...write });
  expect(unresolved.value.hookSpecificOutput.permissionDecision).toBe("deny");
  ctx.who = main;
  const literal = await hook("PreToolUse", {
    session_id: "main",
    cwd: repo,
    tool_name: "Bash",
    tool_input: { command: "dotbabel peer status --json" },
  });
  expect(literal.value.hookSpecificOutput.permissionDecision).toBe("allow");
  expect((await hook("PreToolUse", { cwd: gone, tool_name: "Read" })).code).toBe(2);
  const other = new PeerStore(state, "local:/other-repository");
  await other.transaction((s) => {
    const q = registerMain(
      s,
      { ...advisor, key: "codex:advisor", repo: "local:/other-repository" },
      { alive: () => true },
    );
    pairAdvisor(
      s,
      { ...main, key: "claude:x", sessionId: "x", repo: "local:/other-repository" },
      q.code,
      {
        alive: () => true,
      },
    );
  });
  const preferred = await hook("PreToolUse", { session_id: "advisor", cwd: gone, ...write });
  expect(preferred.value.hookSpecificOutput.permissionDecision).toBe("deny");
  fs.writeFileSync(
    path.join(state, `${"0".repeat(64)}.json`),
    JSON.stringify({ repo: "elsewhere" }),
  );
  expect((await hook("PreToolUse", { session_id: "stranger", cwd: gone, ...write })).code).toBe(2);
});

it("coordinates literal peer operations in a trusted host hook with scoped results and usage failures", async () => {
  const original = fs.readFileSync;
  let input;
  vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) =>
    file === 0 ? JSON.stringify(input) : original(file, ...args),
  );
  async function hook(command, tool = "Bash") {
    input = {
      cwd: repo,
      session_id: ctx.who.sessionId,
      tool_name: tool,
      tool_input: tool === "Bash" ? { command } : { cmd: command },
    };
    const result = await run("hook", "PreToolUse");
    expect(result.code).toBe(0);
    return result.value;
  }
  function printed(result, expectedCode = 0) {
    expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
    const output = spawnSync("bash", ["-c", result.hookSpecificOutput.updatedInput.command], {
      encoding: "utf8",
    });
    expect(output.status).toBe(expectedCode);
    return JSON.parse(output.stdout);
  }
  const p = printed(await hook("dotbabel peer main --json"));
  expect(p.main.key).toBe(main.key);
  ctx.who = advisor;
  expect(printed(await hook(`dotbabel peer advisor ${p.code} --json`)).advisor.key).toBe(
    advisor.key,
  );
  const bin = new URL("../../bin/dotbabel-peer.mjs", import.meta.url).pathname;
  const umbrella = new URL("../../bin/dotbabel.mjs", import.meta.url).pathname;
  expect(
    printed(await hook(`node '${bin}' ask 'literal $(touch forbidden); text' --json`)).body,
  ).toBe("literal $(touch forbidden); text");
  expect(printed(await hook(`node '${umbrella}' peer queue --json`))).toHaveLength(1);
  const legacy = await hook("dotbabel peer queue --json", "exec_command");
  expect(legacy.hookSpecificOutput.updatedInput.cmd).toBe(
    legacy.hookSpecificOutput.updatedInput.command,
  );
  expect(printed(legacy)).toHaveLength(1);
  // A valid ledger can exceed the shell's per-argument limit. Keep the hook
  // response bounded without discarding the durable result or re-running it.
  for (let n = 0; n < 3; n++) await run("ask", "x".repeat(16384));
  const large = await hook("dotbabel peer history --json");
  expect(Buffer.byteLength(large.hookSpecificOutput.updatedInput.command)).toBeLessThan(32768);
  expect(printed(large)).toMatchObject({ output: "read_ledger", ledger: store.file, exit_code: 0 });
  expect((await store.read()).pairs[0].requests).toHaveLength(4);
  expect((await hook("dotbabel peer main")).hookSpecificOutput.permissionDecision).toBe("deny");
  for (const command of [
    "dotbabel peer next --unknown",
    "dotbabel peer ask",
    "dotbabel peer status --repo-root /tmp",
    "dotbabel peer status --help",
  ]) {
    const result = await hook(command);
    expect(printed(result, 64).error.code, command).toBe("PEER_USAGE");
  }
  expect(printed(await hook("dotbabel peer unpair")).closed).toBe(true);
  expect(printed(await hook("dotbabel peer status"), 1).error.code).toBe("PEER_OPERATION");
  expect(await hook("pwd")).toBe(null);
  expect(await hook("dotbabel peer setup --harness both")).toBe(null);
  expect(await hook("node /unrelated/script.mjs peer main")).toBe(null);
});

it("archives a closed pair as an operator and keeps its history accessible", async () => {
  const p = await pair();
  await run("ask", "retained investigation");
  await run("send", "main", "retained finding");
  expect((await run("archive", "--pair", p.id)).code).toBe(1);
  await run("unpair", "--pair", p.id);
  const before = (await run("history", "--pair", p.id)).value;
  ctx.who = null;
  const archived = await run("archive", "--pair", p.id);
  expect(archived.code).toBe(0);
  expect(fs.existsSync(archived.value.path)).toBe(true);
  expect((await store.read()).pairs).toEqual([]);
  expect((await run("history", "--pair", p.id)).value).toEqual(before);
  expect((await run("archive", "--pair", p.id)).value.path).toBe(archived.value.path);
  expect((await run("archive")).code).toBe(64);
  expect((await run("archive", "extra", "--pair", p.id)).code).toBe(64);
  expect(ctx.spawned).toBe(0);
  expect(
    peerCommand({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `dotbabel peer archive --pair ${p.id}` },
    }),
  ).toBe(null);
  await expect(invokePeer(main, ["archive", "--pair", p.id], env)).rejects.toThrow(/unavailable/);
});
