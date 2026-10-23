import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { processState } from "../../src/fleet/registry.mjs";
const bin = new URL("../../bin/dotbabel-peer.mjs", import.meta.url).pathname;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (check()) return;
    await wait(30);
  }
  throw new Error("live relay condition timed out");
}
it("runs a real detached relay, three durable tasks and correlated replies with persistent isolated harness actors", async () => {
  const root = makeTempDir("peer-e2e-"),
    repo = path.join(root, "repo"),
    config = path.join(root, "claude"),
    registry = path.join(config, "sessions");
  fs.mkdirSync(repo);
  fs.mkdirSync(registry, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: config,
    DOTBABEL_PEER_STATE_DIR: path.join(root, "state"),
  };
  delete env.DOTBABEL_PEER_NO_RELAY;
  const peers = [
      spawn("sleep", ["120"], { stdio: "ignore" }),
      spawn("sleep", ["120"], { stdio: "ignore" }),
    ],
    servers = [],
    errors = [];
  let pair,
    started = false,
    release;
  const gate = new Promise((r) => (release = r));
  let completed = 0,
    replies = 0,
    busy = false;
  function cli(role, args) {
    const r = spawnSync(process.execPath, [bin, ...args, "--json"], {
      cwd: repo,
      env: { ...env, DOTBABEL_PEER_HOOK_SESSION: `e2e-${role}` },
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return r.stdout ? JSON.parse(r.stdout) : null;
  }
  for (let n = 0; n < 2; n++) {
    const role = n ? "advisor" : "main",
      socket = path.join(root, `${role}.sock`);
    fs.writeFileSync(
      path.join(registry, `${peers[n].pid}.json`),
      JSON.stringify({
        pid: peers[n].pid,
        procStart: processState(peers[n].pid).startTime,
        sessionId: `e2e-${role}`,
        cwd: repo,
        messagingSocketPath: socket,
        peerProtocol: 1,
      }),
    );
    const server = net.createServer((s) =>
      s.on("data", () => {
        if (role === "main") {
          try {
            for (const m of cli("main", ["receive"])) {
              cli("main", ["ack", m.id]);
              cli("main", ["send", "advisor", "checked", "--kind", "reply", "--reply-to", m.id]);
            }
          } catch (e) {
            errors.push(e);
          }
        } else {
          (async () => {
            for (const m of cli("advisor", ["receive"])) {
              replies++;
              cli("advisor", ["ack", m.id]);
            }
            if (busy) return;
            busy = true;
            try {
              let r;
              while ((r = cli("advisor", ["next"]))) {
                if (!started) {
                  started = true;
                  await gate;
                }
                cli("advisor", [
                  "send",
                  "main",
                  `finding ${r.id}`,
                  "--kind",
                  "finding",
                  "--request",
                  r.id,
                ]);
                cli("advisor", [
                  "complete",
                  r.id,
                  "--lease",
                  r.lease,
                  "--result",
                  "investigation done",
                ]);
                completed++;
              }
            } finally {
              busy = false;
            }
          })().catch((e) => errors.push(e));
        }
      }),
    );
    await new Promise((r) => server.listen(socket, r));
    fs.chmodSync(socket, 0o600);
    servers.push(server);
  }
  try {
    pair = cli("main", ["main"]);
    cli("advisor", ["advisor", pair.code]);
    cli("main", ["ask", "first"]);
    await until(() => started || errors.length);
    expect(errors).toEqual([]);
    cli("main", ["ask", "second"]);
    cli("main", ["ask", "third"]);
    expect(cli("main", ["queue"]).map((r) => r.state)).toEqual(["running", "queued", "queued"]);
    release();
    await until(() => (completed === 3 && replies === 3) || errors.length);
    expect(errors).toEqual([]);
    const history = cli("main", ["history"]);
    expect(history.requests.map((r) => r.state)).toEqual(["completed", "completed", "completed"]);
    expect(history.messages).toHaveLength(6);
    expect(history.messages.every((m) => m.delivery.state === "acknowledged")).toBe(true);
  } finally {
    release();
    let relay;
    try {
      relay = cli("main", ["status"]).relay;
      cli("main", ["unpair"]);
    } catch {}
    if (relay) {
      try {
        process.kill(relay.pid, "SIGTERM");
        await until(() => !processState(relay.pid).exists);
      } catch {}
    }
    for (const p of peers) p.kill();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }
}, 30000);

it("forwards a Main Heads Up note once through a real relay process", async () => {
  const root = makeTempDir("peer-e2e-hu-"),
    repo = path.join(root, "repo"),
    config = path.join(root, "claude"),
    registry = path.join(config, "sessions"),
    tools = path.join(root, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(tools);
  execFileSync("git", ["init", "-q", repo]);
  fs.writeFileSync(
    path.join(repo, ".dotbabel.json"),
    JSON.stringify({ peer: { heads_up: { mode: "enqueue" } } }),
  );
  // The relay reads the version from the claude on its PATH.
  fs.writeFileSync(path.join(tools, "claude"), "#!/bin/sh\necho '2.1.309 (Claude Code)'\n", {
    mode: 0o755,
  });
  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    CLAUDE_CONFIG_DIR: config,
    DOTBABEL_PEER_STATE_DIR: path.join(root, "state"),
  };
  delete env.DOTBABEL_PEER_NO_RELAY;
  const ids = {
    main: "44444444-4444-4444-8444-444444444444",
    advisor: "55555555-5555-4555-8555-555555555555",
  };
  const peers = [],
    servers = [];
  const cli = (role, args) => {
    const r = spawnSync(process.execPath, [bin, ...args, "--json"], {
      cwd: repo,
      env: { ...env, DOTBABEL_PEER_HOOK_SESSION: ids[role] },
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  for (const role of ["main", "advisor"]) {
    const peer = spawn("sleep", ["120"], { stdio: "ignore" }),
      socket = path.join(root, `${role}.sock`);
    peers.push(peer);
    fs.writeFileSync(
      path.join(registry, `${peer.pid}.json`),
      JSON.stringify({
        pid: peer.pid,
        procStart: processState(peer.pid).startTime,
        sessionId: ids[role],
        cwd: repo,
        version: "2.1.309",
        messagingSocketPath: socket,
        peerProtocol: 1,
      }),
    );
    const server = net.createServer((s) => s.resume());
    await new Promise((r) => server.listen(socket, r));
    fs.chmodSync(socket, 0o600);
    servers.push(server);
  }
  const store = path.join(config, "plugins", "store");
  const file = path.join(store, "cc-plugin-you-should-know_builtin-19776595df2c.json");
  const line = "The retry loop may charge twice.";
  const record = {
    id: ids.main,
    askedTurn: ids.advisor,
    offeredTurn: ids.advisor,
    tag: "Heads up",
  };
  const write = (document) => fs.writeFileSync(file, JSON.stringify(document));
  fs.mkdirSync(store, { recursive: true });
  // A note shown before the relay started and already closed is never replayed.
  write({ sessions: [{ ...record, offeredTurn: ids.main }], seen: ["An old note."] });
  let relay;
  try {
    const pair = cli("main", ["main"]);
    cli("advisor", ["advisor", pair.code]);
    await until(() => cli("main", ["status"]).heads_up.state === "watching");
    // The add-on's two writes, in its order: the seen line, then the session record.
    write({ sessions: [{ ...record, offeredTurn: ids.main }], seen: ["An old note.", line] });
    await wait(1500);
    expect(cli("main", ["queue"])).toEqual([]);
    write({
      sessions: [{ ...record, view: { kind: "offer", line, explanation: "Why.", shownAt: 1 } }],
      seen: ["An old note.", line],
    });
    await until(() => cli("main", ["queue"]).length > 0);
    await wait(2500);
    const queue = cli("main", ["queue"]);
    expect(queue).toHaveLength(1);
    expect(queue[0].body).toContain(`Forwarded by: the relay watcher`);
    expect(queue[0].body).toMatch(/\nNote:\nThe retry loop may charge twice\.\nWhy\.$/);
    const status = cli("main", ["status"]);
    relay = status.relay;
    expect(status.heads_up).toEqual({
      mode: "enqueue",
      state: "watching",
      claudeVersion: "2.1.309",
      forwarded: 1,
      ambiguous: 0,
    });
    expect(JSON.stringify(status)).not.toContain(line);
  } finally {
    try {
      relay ??= cli("main", ["status"]).relay;
      cli("main", ["unpair"]);
    } catch {}
    if (relay) {
      try {
        process.kill(relay.pid, "SIGTERM");
        await until(() => !processState(relay.pid).exists);
      } catch {}
    }
    for (const p of peers) p.kill();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  }
}, 40000);
