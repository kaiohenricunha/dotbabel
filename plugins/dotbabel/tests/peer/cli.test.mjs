import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { afterEach, it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { processState } from "../../src/fleet/registry.mjs";
const bin = new URL("../../bin/dotbabel-peer.mjs", import.meta.url).pathname;
const children = [];
afterEach(() => {
  for (const p of children.splice(0)) p.kill();
});
function world() {
  const root = makeTempDir("peer-cli-"),
    repo = path.join(root, "repo"),
    registry = path.join(root, "claude", "sessions");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const peers = [0, 1].map(() => {
    const p = spawn("sleep", ["120"], { stdio: "ignore" });
    children.push(p);
    return p;
  });
  const ids = peers.map((p, n) => {
    const r = {
      pid: p.pid,
      procStart: processState(p.pid).startTime,
      sessionId: `s${n}`,
      cwd: repo,
    };
    fs.writeFileSync(path.join(registry, `${p.pid}.json`), JSON.stringify(r));
    return r;
  });
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.dirname(registry),
    DOTBABEL_PEER_STATE_DIR: path.join(root, "state"),
    DOTBABEL_PEER_NO_RELAY: "1",
  };
  function cli(args, n = 0, input) {
    return spawnSync(process.execPath, [bin, ...args], {
      cwd: repo,
      env: { ...env, DOTBABEL_PEER_HOOK_SESSION: ids[n].sessionId },
      input,
      encoding: "utf8",
    });
  }
  return { root, repo, ids, env, cli };
}
function json(r) {
  expect(r.status, r.stderr || r.stdout).toBe(0);
  return JSON.parse(r.stdout);
}
it("pairs in two commands and exposes the complete queue lifecycle through separate CLI processes", () => {
  const w = world(),
    p = json(w.cli(["main", "--json"]));
  expect(p.code).toMatch(/^[A-F0-9]{8}$/);
  json(w.cli(["advisor", p.code, "--json"], 1));
  const a = json(w.cli(["ask", "race condition", "--json"]));
  json(w.cli(["ask", "migration", "--json"]));
  const running = json(w.cli(["next", "--json"], 1));
  expect(running.id).toBe(a.id);
  json(w.cli(["ask", "while busy", "--pair", p.id, "--json"]));
  json(w.cli(["complete", a.id, "--lease", running.lease, "--result", "safe", "--json"], 1));
  expect(json(w.cli(["next", "--json"], 1)).body).toBe("migration");
  expect(json(w.cli(["queue", "--json"])).map((x) => x.state)).toEqual([
    "completed",
    "running",
    "queued",
  ]);
  json(w.cli(["pause", "--json"]));
  expect(json(w.cli(["status", "--json"])).paused).toBe(true);
  json(w.cli(["resume", "--json"]));
  json(w.cli(["unpair", "--json"]));
});
it("guards Advisor mutation tools and shell writes while allowing read-only inspection", () => {
  const w = world(),
    p = json(w.cli(["main", "--json"]));
  json(w.cli(["advisor", p.code, "--json"], 1));
  for (const payload of [
    { tool_name: "Edit", tool_input: { file_path: path.join(w.repo, "a") } },
    { tool_name: "Bash", tool_input: { command: "rm -rf src" } },
    { tool_name: "Bash", tool_input: { command: "git status; touch stolen" } },
  ]) {
    const r = json(
      w.cli(
        ["hook", "PreToolUse"],
        1,
        JSON.stringify({ ...payload, session_id: w.ids[1].sessionId, cwd: w.repo }),
      ),
    );
    expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
  }
  const r = w.cli(
    ["hook", "PreToolUse"],
    1,
    JSON.stringify({
      session_id: w.ids[1].sessionId,
      cwd: w.repo,
      tool_name: "Bash",
      tool_input: { command: "git diff --stat" },
    }),
  );
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("");
});
it("routes correlated messages and requires recipient acknowledgments", () => {
  const w = world(),
    p = json(w.cli(["main", "--json"]));
  json(w.cli(["advisor", p.code, "--json"], 1));
  const m = json(w.cli(["send", "main", "found a race", "--kind", "finding", "--json"], 1));
  expect(json(w.cli(["receive", "--json"]))[0].id).toBe(m.id);
  expect(w.cli(["ack", m.id, "--json"], 1).status).not.toBe(0);
  json(w.cli(["ack", m.id, "--json"]));
  const reply = json(w.cli(["send", "advisor", "investigate", "--reply-to", m.id, "--json"]));
  expect(json(w.cli(["receive", "--json"], 1))[0].id).toBe(reply.id);
});
it("supports independent submissions and rejects unknown operations and missing input", () => {
  const w = world(),
    p = json(w.cli(["main", "--json"]));
  json(w.cli(["advisor", p.code, "--json"], 1));
  expect(w.cli(["unknown"]).status).toBe(64);
  expect(w.cli(["ask"]).status).toBe(64);
  const r = spawnSync(
    process.execPath,
    [bin, "ask", "independent question", "--pair", p.id, "--json"],
    { cwd: w.repo, env: { ...w.env, CODEX_THREAD_ID: "", CODEX_SESSION_ID: "" }, encoding: "utf8" },
  );
  expect(json(r).body).toBe("independent question");
  expect(w.cli(["send", "main", "oops", "--urgent"], 1).status).toBe(64);
});
