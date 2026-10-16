import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
import { runPeer } from "../../src/peer/cli.mjs";
import { repository } from "../../src/peer/identity.mjs";
import { PeerStore } from "../../src/peer/store.mjs";
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
