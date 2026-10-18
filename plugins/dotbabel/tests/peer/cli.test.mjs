import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { afterEach, it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { processState } from "../../src/fleet/registry.mjs";
import { setupHooks } from "../../src/peer/setup.mjs";
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
it("launches an owned Antigravity stream from the public CLI without changing native defaults", () => {
  const w = world(),
    dir = path.join(w.root, "bin");
  fs.mkdirSync(dir);
  setupHooks("antigravity", {}, w.repo);
  fs.writeFileSync(
    path.join(dir, "agy"),
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({event:'init',conversation_id:'00000000-0000-4000-8000-000000000031',init:{permission_mode:'request-review'}}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({event:'result',result:{conversation_id:'00000000-0000-4000-8000-000000000031',status:'SUCCESS',response:JSON.parse(line).message.content}})));\n`,
    { mode: 0o700 },
  );
  const result = spawnSync(process.execPath, [bin, "launch", "main", "--harness", "antigravity"], {
    cwd: w.repo,
    env: { ...w.env, PATH: `${dir}:${process.env.PATH}` },
    input: "owned prompt\n",
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.find((e) => e.event === "dotbabel_peer").pair.main.harness).toBe("antigravity");
  expect(events.some((e) => e.result?.response === "owned prompt")).toBe(true);
  const pair = events.find((e) => e.event === "dotbabel_peer").pair;
  const resumed = spawnSync(
    process.execPath,
    [
      bin,
      "launch",
      "main",
      "--harness",
      "antigravity",
      "--pair",
      pair.id,
      "--conversation",
      pair.main.sessionId,
    ],
    {
      cwd: w.repo,
      env: { ...w.env, PATH: `${dir}:${process.env.PATH}` },
      input: "resume owned prompt\n",
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(
    resumed.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((e) => e.event === "dotbabel_peer").pair.id,
  ).toBe(pair.id);
  expect(w.cli(["launch", "main", "--harness", "copilot"]).status).toBe(64);
  expect(w.cli(["launch", "advisor", "--harness", "antigravity"]).status).toBe(64);
});
it("routes native camelCase hook input without applying legacy session identity", () => {
  const w = world();
  const result = w.cli(
    ["hook", "PreToolUse", "--harness", "antigravity"],
    0,
    JSON.stringify({
      conversationId: "00000000-0000-4000-8000-000000000041",
      workspacePaths: [w.repo],
      toolCall: { name: "write_to_file", args: {} },
    }),
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({});
});
it("returns a native deny decision when a managed hook cannot authenticate its actor", () => {
  const w = world();
  const r = spawnSync(process.execPath, [bin, "hook", "PreToolUse", "--harness", "antigravity"], {
    cwd: w.repo,
    env: { ...w.env, DOTBABEL_PEER_MANAGED: "antigravity" },
    input: JSON.stringify({
      conversationId: "00000000-0000-4000-8000-000000000041",
      workspacePaths: [w.repo],
      toolCall: { name: "write_to_file", args: {} },
    }),
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ decision: "deny" });
});
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
it("persists an early Main reply across processes and resumes Advisor after wait", () => {
  const w = world(),
    p = json(w.cli(["main", "--json"]));
  json(w.cli(["advisor", p.code, "--json"], 1));
  const a = json(w.cli(["ask", "discuss the race", "--json"]));
  const running = json(w.cli(["next", "--json"], 1));
  const q = json(
    w.cli(["send", "main", "why?", "--kind", "question", "--request", a.id, "--json"], 1),
  );
  json(w.cli(["send", "advisor", "because", "--kind", "reply", "--reply-to", q.id, "--json"]));
  const waited = json(
    w.cli(
      ["wait", a.id, "--lease", running.lease, "--result", "waiting", "--reply-to", q.id, "--json"],
      1,
    ),
  );
  expect(waited.state).toBe("queued");
  const resumed = json(w.cli(["next", "--json"], 1));
  expect(resumed.id).toBe(a.id);
  expect(resumed.lease).not.toBe(running.lease);
  expect(
    json(w.cli(["complete", a.id, "--lease", resumed.lease, "--result", "resolved", "--json"], 1))
      .state,
  ).toBe("completed");
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
  expect(w.cli(["main", "--harness", "opencode"]).status).toBe(64);
});

it("executes peer coordination in the trusted host hook before a namespaced shell runs", () => {
  const w = world();
  const hook = (command, n = 0) =>
    w.cli(
      ["hook", "PreToolUse"],
      n,
      JSON.stringify({
        cwd: w.repo,
        session_id: w.ids[n].sessionId,
        tool_name: "Bash",
        tool_input: { command },
      }),
    );
  const registered = json(hook("dotbabel peer main --json"));
  expect(registered.hookSpecificOutput.permissionDecision).toBe("allow");
  const output = spawnSync("bash", ["-c", registered.hookSpecificOutput.updatedInput.command], {
    encoding: "utf8",
  });
  const main = JSON.parse(output.stdout);
  expect(main.main.sessionId).toBe(w.ids[0].sessionId);
  const joined = json(hook(`dotbabel peer advisor ${main.code} --json`, 1));
  const advisor = JSON.parse(
    spawnSync("bash", ["-c", joined.hookSpecificOutput.updatedInput.command], { encoding: "utf8" })
      .stdout,
  );
  expect(advisor.advisor.sessionId).toBe(w.ids[1].sessionId);
  const injection = hook("dotbabel peer ask 'literal $(touch forbidden); text' --json", 1);
  expect(injection.status).toBe(0);
  expect(JSON.parse(injection.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  expect(fs.existsSync(path.join(w.repo, "forbidden"))).toBe(false);
  const queued = json(w.cli(["queue", "--json"]));
  expect(queued[0].body).toBe("literal $(touch forbidden); text");
  const quoted = json(hook('dotbabel peer ask "a single apostrophe: \'" --json', 1));
  const printed = spawnSync("bash", ["-c", quoted.hookSpecificOutput.updatedInput.command], {
    encoding: "utf8",
  });
  expect(printed.status).toBe(0);
  expect(JSON.parse(printed.stdout).body).toBe("a single apostrophe: '");
});

it("keeps chained commands, wrappers, setup, repository overrides, and Advisor role changes outside host coordination", () => {
  const w = world(),
    main = json(w.cli(["main", "--json"]));
  json(w.cli(["advisor", main.code, "--json"], 1));
  for (const command of [
    "dotbabel peer ask injected; touch forbidden",
    'dotbabel peer ask "$(touch forbidden)"',
    "env dotbabel peer ask injected",
    "X=1 dotbabel peer ask injected",
    "dotbabel peer ask *",
    "dotbabel peer setup --harness both",
    "dotbabel peer main",
  ]) {
    const result = json(
      w.cli(
        ["hook", "PreToolUse"],
        1,
        JSON.stringify({
          cwd: w.repo,
          session_id: w.ids[1].sessionId,
          tool_name: "Bash",
          tool_input: { command },
        }),
      ),
    );
    expect(result.hookSpecificOutput.permissionDecision, command).toBe("deny");
    expect(result.hookSpecificOutput.updatedInput).toBeUndefined();
  }
  const result = json(
    w.cli(
      ["hook", "PreToolUse"],
      1,
      JSON.stringify({
        cwd: w.repo,
        session_id: w.ids[1].sessionId,
        tool_name: "Bash",
        tool_input: { command: "dotbabel peer ask overridden --repo-root /tmp --json" },
      }),
    ),
  );
  const printed = spawnSync("bash", ["-c", result.hookSpecificOutput.updatedInput.command], {
    encoding: "utf8",
  });
  expect(printed.status).toBe(64);
  expect(JSON.parse(printed.stdout).error.code).toBe("PEER_USAGE");
  expect(json(w.cli(["queue", "--json"]))).toEqual([]);
  expect(fs.existsSync(path.join(w.repo, "forbidden"))).toBe(false);
});
it("returns scoped CLI help through the trusted Advisor hook instead of requiring package-source access", () => {
  const w = world(),
    pair = json(w.cli(["main", "--json"]));
  json(w.cli(["advisor", pair.code, "--json"], 1));
  const result = json(
    w.cli(
      ["hook", "PreToolUse"],
      1,
      JSON.stringify({
        cwd: w.repo,
        session_id: w.ids[1].sessionId,
        tool_name: "Bash",
        tool_input: { command: "dotbabel peer --help" },
      }),
    ),
  );
  expect(result.hookSpecificOutput.permissionDecision).toBe("allow");
  const printed = spawnSync("bash", ["-c", result.hookSpecificOutput.updatedInput.command], {
    encoding: "utf8",
  });
  expect(JSON.parse(printed.stdout).usage).toContain("--lease TOKEN --result TEXT");
  expect(json(w.cli(["queue", "--json"]))).toEqual([]);
});
