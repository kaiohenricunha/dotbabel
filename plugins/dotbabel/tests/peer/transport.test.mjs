import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { deliver } from "../../src/peer/transport.mjs";
it("delivers a protocol-1 Claude notification through a real private socket", async () => {
  const root = makeTempDir("peer-socket-"),
    socket = path.join(root, "c.sock");
  let bytes = "",
    received;
  const read = new Promise((r) => (received = r));
  const server = net.createServer((s) =>
    s.on("data", (x) => {
      bytes += x;
      received();
    }),
  );
  await new Promise((r) => server.listen(socket, r));
  fs.chmodSync(socket, 0o600);
  try {
    const result = await deliver({ harness: "claude", socket, peerProtocol: 1 }, "wake");
    expect(result.state).toBe("transport_accepted");
    await read;
    expect(bytes).toBe("wake\n");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
it("refuses unknown framing, symlink sockets and unsafe payloads", async () => {
  const root = makeTempDir("peer-symlink-"),
    link = path.join(root, "link");
  fs.symlinkSync("/tmp/missing", link);
  expect((await deliver({ harness: "claude", socket: link, peerProtocol: 1 }, "wake")).state).toBe(
    "failed",
  );
  expect(
    (await deliver({ harness: "claude", socket: link, peerProtocol: 2 }, "wake")).error,
  ).toMatch(/protocol/);
  await expect(deliver({ harness: "codex" }, "a\nb")).rejects.toThrow(/line/);
});
it("uses stable Codex queue argv without a shell and separates acceptance from processing", async () => {
  const root = makeTempDir("peer-queue-"),
    bin = path.join(root, "codex"),
    output = path.join(root, "argv.json");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)));\n`,
  );
  fs.chmodSync(bin, 0o700);
  const r = await deliver({ harness: "codex", sessionId: "thread" }, "$(bad); literal", {
    codexBin: bin,
  });
  expect(r.state).toBe("transport_accepted");
  expect(JSON.parse(fs.readFileSync(output))).toEqual([
    "queue",
    "--thread",
    "thread",
    "--message",
    "$(bad); literal",
  ]);
  expect(
    (await deliver({ harness: "codex", sessionId: "x" }, "wake", { codexBin: "/missing/codex" }))
      .state,
  ).toBe("failed");
});
it("treats a process timeout as uncertain rather than retrying a possibly delivered message", async () => {
  const root = makeTempDir("peer-timeout-"),
    bin = path.join(root, "codex");
  fs.writeFileSync(bin, "#!/usr/bin/env node\nsetTimeout(()=>{},10000)\n");
  fs.chmodSync(bin, 0o700);
  const r = await deliver({ harness: "codex", sessionId: "x" }, "wake", {
    codexBin: bin,
    timeout: 100,
  });
  expect(r.state).toBe("uncertain");
  expect(r.retryable).toBe(false);
});
