/** Explicit two-primary-turn proof of the public managed terminal on Linux/WSL. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createCodexRpcTransport } from "../../plugins/dotbabel/src/adaptive-session-routing/codex-rpc.mjs";

if (!process.argv.includes("--live")) { console.error("Use --live to execute two controlled native model turns."); process.exit(64); }
const source = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const native = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
const cwd = mkdtempSync(join(tmpdir(), "dotbabel-managed-codex-proof-"));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
let rpc;
try {
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(join(cwd, ".dotbabel.json"), JSON.stringify({ model_intelligence: { enabled: true, adaptive_routing: { enabled: true } } }));
  mkdirSync(join(cwd, "bin"));
  // The proof explicitly chooses native permission settings without editing any native config file.
  writeFileSync(join(cwd, "bin", "codex"), `#!/bin/sh\nif [ "$1" = app-server ]; then\nshift\nexec ${quote(native)} app-server -c 'sandbox_mode="read-only"' -c 'approval_policy="on-request"' "$@"\nfi\nexec ${quote(native)} "$@"\n`, { mode: 0o700 });
  const prompts = ["Format the sample JSON as two-space indented text. Do not use tools. Return only JSON: {a:1}", "Debug why this integration test fails intermittently and give one sentence of verification guidance without using tools. The retry loop reads a stale cursor."];
  const pending = promisify(execFile)(process.execPath, [join(source, "plugins/dotbabel/bin/dotbabel-models.mjs"), "session", "--repo-root", cwd, "--runtime", "codex", "--model", "auto", "--effort", "auto", "--json"], { env: { ...process.env, PATH: join(cwd, "bin") + ":" + process.env.PATH }, timeout: 230000, maxBuffer: 4 * 1024 * 1024 });
  pending.child.stdin.end(prompts.join("\n") + "\n");
  const { stdout } = await pending;
  const records = stdout.trim().split("\n").map(JSON.parse);
  const session = records.find(record => record.type === "session");
  const turns = records.filter(record => record.type === "turn");
  assert.equal(turns.length, 2);
  assert.deepEqual(session.native, { approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false } });
  for (const turn of turns) {
    assert.equal(turn.status, "completed"); assert.equal(turn.effective.state, "observed");
    assert.deepEqual(turn.decision.configuration.axes, turn.effective.axes);
  }
  assert.notDeepEqual(turns[0].effective.axes, turns[1].effective.axes);
  rpc = createCodexRpcTransport({ command: native, cwd, timeoutMs: 15000 });
  await rpc.request("initialize", { clientInfo: { name: "dotbabel-managed-proof-read", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  rpc.sendNotification("initialized", {});
  const read = await rpc.request("thread/read", { threadId: session.threadId, includeTurns: true });
  const hash = text => createHash("sha256").update(text).digest("hex");
  assert.equal(read.thread.turns.length, 2);
  const inputs = read.thread.turns.map((turn, index) => {
    const messages = turn.items.filter(item => item.type === "userMessage");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].content.filter(item => item.type === "text").map(item => hash(item.text)), [hash(prompts[index])]);
    assert.equal(turn.id, turns[index].accepted.turnId);
    return { turnId: turn.id, messageCount: messages.length, textSha256: hash(prompts[index]) };
  });
  console.log(JSON.stringify({ runtime: execFileSync(native, ["--version"], { encoding: "utf8" }).trim(), mechanism: "managed-app-server", threadId: session.threadId, native: session.native,
    turns: turns.map(turn => ({ status: turn.status, accepted: turn.accepted, requested: turn.requested, selected: turn.decision.configuration.axes, effective: turn.effective })),
    inputs, configurationsDiffer: true, originalInputsExactlyOnce: true, extraClassifierInferenceCalls: 0, permissionSource: "explicit native invocation arguments in an isolated proof wrapper" }, null, 2));
} finally { rpc?.close(); rmSync(cwd, { recursive: true, force: true }); }
