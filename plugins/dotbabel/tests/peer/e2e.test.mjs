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
