import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { openNativeEndpoint, deliverNative } from "../../src/peer/native.mjs";
import { nativePaths } from "../../src/peer/native-registry.mjs";
import { endpointAlive, currentSession, repository } from "../../src/peer/identity.mjs";

const opened = [];
afterEach(async () => {
  for (const endpoint of opened.splice(0)) await endpoint.close();
});
function world() {
  const root = makeTempDir("peer-native-"),
    worktree = path.join(root, "repo");
  fs.mkdirSync(worktree);
  execFileSync("git", ["init", "-q", worktree]);
  return { worktree, env: { DOTBABEL_PEER_STATE_DIR: path.join(root, "state") } };
}
async function open(w, extra = {}) {
  const endpoint = await openNativeEndpoint({
    harness: "opencode",
    sessionId: "ses_fixture_native",
    ...w,
    notify: async () => {},
    ...extra,
  });
  opened.push(endpoint);
  return endpoint;
}
it.each(["opencode", "copilot", "antigravity"])(
  "delivers to the registered %s callback through a private real socket",
  async (harness) => {
    const w = world(),
      received = [];
    const endpoint = await open(w, {
      harness,
      sessionId: harness === "opencode" ? "ses_fixture" : "00000000-0000-4000-8000-000000000001",
      notify: async (text) => received.push(text),
    });
    expect(endpoint.who.harness).toBe(harness);
    expect(endpointAlive(endpoint.who, { env: w.env })).toBe(true);
    expect(fs.statSync(endpoint.who.socket).mode & 0o777).toBe(0o600);
    const result = await deliverNative(endpoint.who, "untrusted $(text); stays text");
    expect(result).toEqual({ state: "transport_accepted", retryable: false });
    expect(received).toEqual(["untrusted $(text); stays text"]);
  },
);
it("does not report acceptance before the native queue accepts", async () => {
  const w = world();
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const endpoint = await open(w, { notify: () => waiting });
  let settled = false;
  const delivery = deliverNative(endpoint.who, "wake").then((r) => {
    settled = true;
    return r;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(settled).toBe(false);
  release();
  expect((await delivery).state).toBe("transport_accepted");
});
it("requires a registered native process ancestor rather than an arbitrary session variable", async () => {
  const w = world(),
    endpoint = await open(w);
  const env = { ...w.env, DOTBABEL_PEER_NATIVE_SESSION: endpoint.who.key };
  expect(currentSession(repository(w.worktree), { env, startPid: process.pid }).key).toBe(
    endpoint.who.key,
  );
  expect(() => currentSession(repository(w.worktree), { env, startPid: 1 })).toThrow(
    /native|session/,
  );
  expect(() =>
    currentSession(repository(w.worktree), {
      env: { ...env, DOTBABEL_PEER_NATIVE_SESSION: "opencode:ses_unknown" },
      startPid: process.pid,
    }),
  ).toThrow(/native|session/);
});
it("rejects another repository and stale, ended, or modified registrations", async () => {
  const w = world(),
    endpoint = await open(w),
    other = world();
  const env = { ...w.env, DOTBABEL_PEER_NATIVE_SESSION: endpoint.who.key };
  expect(() => currentSession(repository(other.worktree), { env, startPid: process.pid })).toThrow(
    /repository/,
  );
  expect(endpointAlive({ ...endpoint.who, procStart: "wrong" }, { env: w.env })).toBe(false);
  expect(endpointAlive({ ...endpoint.who, ended: true }, { env: w.env })).toBe(false);
  expect(endpointAlive({ ...endpoint.who, sessionId: "ses_replaced" }, { env: w.env })).toBe(false);
  expect(endpointAlive({ ...endpoint.who, socket: "/tmp/unregistered.sock" }, { env: w.env })).toBe(
    false,
  );
});
it("does not replace a live endpoint belonging to the same session", async () => {
  const w = world(),
    endpoint = await open(w);
  await expect(open(w)).rejects.toThrow(/registered|active|exists/);
  expect((await deliverNative(endpoint.who, "still original")).state).toBe("transport_accepted");
});
it("fences concurrent replacements of a stale native registration", async () => {
  const w = world(),
    old = await open(w);
  await old.close();
  const record = nativePaths(w.env.DOTBABEL_PEER_STATE_DIR, old.who.key).record;
  fs.writeFileSync(record, JSON.stringify({ ...old.who, procStart: "stale" }), { mode: 0o600 });
  const attempts = await Promise.allSettled([open(w), open(w)]);
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
  const winner = attempts.find((r) => r.status === "fulfilled").value;
  expect(endpointAlive(winner.who, { env: w.env })).toBe(true);
});
it("preserves an uncertain result when a native send rejects or times out after writing", async () => {
  const w = world();
  const rejected = await open(w, {
    notify: async () => {
      throw Error("private provider detail");
    },
  });
  const result = await deliverNative(rejected.who, "wake");
  expect(result.state).toBe("uncertain");
  expect(result.retryable).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private provider detail");
  const pending = await open(w, { sessionId: "ses_pending", notify: () => new Promise(() => {}) });
  expect(await deliverNative(pending.who, "wake", { timeout: 40 })).toMatchObject({
    state: "uncertain",
    retryable: false,
  });
});
it("refuses unsafe harnesses, session IDs, sockets, and payloads", async () => {
  const w = world();
  await expect(open(w, { harness: "unknown" })).rejects.toThrow(/harness/);
  await expect(open(w, { sessionId: "../escape" })).rejects.toThrow(/session/);
  const endpoint = await open(w);
  await expect(deliverNative(endpoint.who, "a\nb")).rejects.toThrow(/line|notification/);
  await expect(deliverNative(endpoint.who, "x".repeat(4097))).rejects.toThrow(
    /bounded|notification/,
  );
  const link = path.join(path.dirname(endpoint.who.socket), "link.sock");
  fs.symlinkSync(endpoint.who.socket, link);
  expect((await deliverNative({ ...endpoint.who, socket: link }, "wake")).state).toBe("failed");
  fs.chmodSync(endpoint.who.socket, 0o666);
  expect((await deliverNative(endpoint.who, "wake")).state).toBe("failed");
  fs.chmodSync(endpoint.who.socket, 0o600);
});
it("does not dispatch forged or oversized socket frames", async () => {
  const w = world(),
    received = [],
    endpoint = await open(w, { notify: async (s) => received.push(s) });
  for (const frame of [
    "{bad}\n",
    JSON.stringify({ version: 1, sessionId: "ses_other", text: "foreign" }) + "\n",
    "x".repeat(9000) + "\n",
  ]) {
    await new Promise((resolve) => {
      const s = net.createConnection(endpoint.who.socket);
      s.on("error", () => {});
      s.on("close", resolve);
      s.on("data", () => {});
      s.on("connect", () => s.end(frame));
    });
  }
  expect(received).toEqual([]);
});
it("preserves UTF-8 when a valid native frame crosses byte chunk boundaries", async () => {
  const w = world(),
    received = [],
    endpoint = await open(w, { notify: async (s) => received.push(s) });
  const text = "Ação e confirmação 🔍";
  const frame = Buffer.from(
    JSON.stringify({
      version: 1,
      key: endpoint.who.key,
      generation: endpoint.who.generation,
      repo: endpoint.who.repo,
      text,
    }) + "\n",
  );
  const split = frame.indexOf(Buffer.from("ç")) + 1;
  await new Promise((resolve) => {
    const socket = net.createConnection(endpoint.who.socket);
    socket.on("data", () => {});
    socket.on("close", resolve);
    socket.on("connect", () => {
      socket.write(frame.subarray(0, split));
      setTimeout(() => socket.end(frame.subarray(split)), 15);
    });
  });
  expect(received).toEqual([text]);
});
it("removes only its own registration and socket on idempotent cleanup", async () => {
  const w = world(),
    endpoint = await open(w),
    second = await open(w, { sessionId: "ses_second" });
  await endpoint.close();
  await endpoint.close();
  expect(endpointAlive(endpoint.who, { env: w.env })).toBe(false);
  expect(fs.existsSync(endpoint.who.socket)).toBe(false);
  expect((await deliverNative(second.who, "live")).state).toBe("transport_accepted");
});
