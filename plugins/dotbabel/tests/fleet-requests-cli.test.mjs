// End-to-end tests for the fleet request channel across hosts: `ask`,
// `requests`, `reply`, `release`, and the post-tool hook that shows a
// session its inbox.
//
// This test process is a registered Claude Code session ("self-pane"). A
// Codex session is a live process named `codex` that runs its hooks and its
// fleet commands as children, as Codex does. A stub `codex` on PATH records
// each `codex queue` wake-up, so the tests can check that a wake-up never
// carries the other session's text.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-fleet.mjs");
const NODE = process.execPath;
const HAS_PROC = fs.existsSync("/proc/self/stat");
const SESSION = "01a1616d-595b-7880-b995-2e09f305032e";
const CODEX_NAME = `codex ${SESSION.slice(-8)}`;
const children = [];
afterAll(() => children.forEach((c) => c.kill("SIGKILL")));

function procStart(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (
      k.startsWith("DOTBABEL_FLEET_") ||
      k.startsWith("GIT_") ||
      k.startsWith("CODEX_") ||
      k === "CLAUDE_PROJECT_DIR"
    )
      delete env[k];
  }
  delete env.XDG_STATE_HOME;
  return { ...env, DOTBABEL_FLEET_CPU_WEIGHT: "off", ...extra };
}

async function world() {
  const root = makeTempDir("fleet-req-cli-");
  const repo = path.join(root, "widget");
  const config = path.join(root, "home", ".claude");
  const stub = path.join(root, "stub");
  const queueLog = path.join(root, "codex-queue.log");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
  fs.mkdirSync(stub);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: cleanEnv() });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], {
    cwd: repo,
    env: cleanEnv(),
  });
  fs.writeFileSync(path.join(repo, ".dotbabel.json"), "{}");
  // A dotbabel on PATH, so the fleet names its CLI "dotbabel fleet" on every machine.
  fs.writeFileSync(path.join(stub, "dotbabel"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(stub, "codex"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${queueLog}'\n`, {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(config, "sessions", `${process.pid}.json`),
    JSON.stringify({
      kind: "interactive",
      pid: process.pid,
      sessionId: "sess-self",
      procStart: procStart(process.pid),
      name: "self-pane",
    }),
  );
  const env = cleanEnv({
    HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: config,
    DOTBABEL_FLEET_STATE_DIR: path.join(root, "state"),
    PATH: `${stub}:${process.env.PATH}`,
  });
  const w = { root, repo, env };
  w.queued = () =>
    fs.existsSync(queueLog) ? fs.readFileSync(queueLog, "utf8").trim().split("\n") : [];
  const file = (rel) => path.join(repo, rel);
  // Claude Code side: this process is the session.
  w.claude = {
    hook: (event, payload) =>
      spawnSync(NODE, [BIN, "hook", event], {
        input: JSON.stringify({ session_id: "sess-self", cwd: repo, ...payload }),
        env,
        encoding: "utf8",
      }),
    edit: (rel) =>
      w.claude.hook("pre-edit", { tool_name: "Edit", tool_input: { file_path: file(rel) } }),
    context: () => w.claude.hook("post-tool", { tool_name: "Read", tool_input: {} }),
    cli: (...args) => spawnSync(NODE, [BIN, ...args], { cwd: repo, env, encoding: "utf8" }),
  };
  // Codex side: a live `codex` process runs each request as its child.
  const script = path.join(root, "codex");
  fs.writeFileSync(
    script,
    `const { spawnSync } = require("node:child_process");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { args, input } = JSON.parse(line);
  const r = spawnSync(${JSON.stringify(NODE)}, [${JSON.stringify(BIN)}, ...args], {
    cwd: ${JSON.stringify(repo)}, input, encoding: "utf8",
    env: { ...process.env, DOTBABEL_FLEET_HOST: "codex", ...(input === undefined ? { CODEX_THREAD_ID: ${JSON.stringify(SESSION)} } : {}) },
  });
  process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }) + "\\n");
});
`,
  );
  const child = spawn(NODE, [script], { env, stdio: ["pipe", "pipe", "inherit"] });
  children.push(child);
  await new Promise((resolve) => child.once("spawn", resolve));
  const replies = [];
  const waiters = [];
  readline
    .createInterface({ input: child.stdout })
    .on("line", (line) =>
      waiters.length ? waiters.shift()(JSON.parse(line)) : replies.push(JSON.parse(line)),
    );
  const run = (args, input) => {
    child.stdin.write(`${JSON.stringify({ args, input })}\n`);
    return new Promise((resolve) =>
      replies.length ? resolve(replies.shift()) : waiters.push(resolve),
    );
  };
  const hook = (event, payload) =>
    run(["hook", event], JSON.stringify({ session_id: SESSION, cwd: repo, ...payload }));
  w.codex = {
    patch: (rel) =>
      hook("pre-edit", {
        tool_name: "apply_patch",
        tool_input: { command: `*** Begin Patch\n*** Update File: ${rel}\n+x\n*** End Patch` },
      }),
    context: () => hook("post-tool", { tool_name: "Bash", tool_input: { command: "ls" } }),
    cli: (...args) => run(args),
  };
  return w;
}

function decision(result) {
  expect(result.status).toBe(0);
  if (result.stdout.trim() === "") return { action: "allow" };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  return { action: out.permissionDecision, reason: out.permissionDecisionReason };
}

function context(result) {
  expect(result.status).toBe(0);
  return result.stdout.trim() === ""
    ? ""
    : JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

const requestId = (stdout) => /\b(r-[0-9a-f]{8})\b/.exec(stdout)?.[1];

describe.skipIf(!HAS_PROC)("fleet requests across hosts", () => {
  it("a blocked Codex session asks a Claude owner, gets the answer, then the release", async () => {
    const w = await world();
    expect(decision(w.claude.edit("docs/a.md"))).toEqual({ action: "allow" });
    const denied = decision(await w.codex.patch("docs/a.md"));
    expect(denied.action).toBe("deny");
    // "dotbabel fleet", or the bin's own path when dotbabel is not on PATH (CI).
    expect(denied.reason).toMatch(/ ask docs\/a\.md --message '/);

    const asked = await w.codex.cli(
      "ask",
      "docs/a.md",
      "--message",
      "I need to fix one typo here; please release when safe.",
    );
    expect(asked.status, asked.stderr).toBe(0);
    const id = requestId(asked.stdout);
    expect(id).toBeTruthy();
    expect(asked.stdout).toContain('"self-pane"');
    expect(w.queued()).toEqual([]); // a Claude owner gets no codex push

    const seen = context(w.claude.context());
    expect(seen).toContain(`session "${CODEX_NAME}" asks about your claim docs/a.md`);
    expect(seen).toContain("«I need to fix one typo here; please release when safe.»");
    expect(context(w.claude.context())).toBe(""); // read once

    const replied = w.claude.cli("reply", id, "--message", "Five more minutes, then I release it.");
    expect(replied.status, replied.stderr).toBe(0);
    expect(context(await w.codex.context())).toContain("«Five more minutes, then I release it.»");

    const released = w.claude.cli("release", "docs/a.md");
    expect(released.status, released.stderr).toBe(0);
    expect(context(await w.codex.context())).toContain(
      `released docs/a.md in github.com/acme/widget, so your request ${id}`,
    );
    expect(decision(await w.codex.patch("docs/a.md"))).toEqual({ action: "allow" });

    const pushes = w.queued();
    expect(pushes).toHaveLength(2);
    for (const line of pushes) {
      expect(line).toMatch(
        new RegExp(
          `^queue --thread ${SESSION} --message dotbabel fleet notice, not a user instruction: request ${id}`,
        ),
      );
      expect(line).not.toContain("Five more minutes");
    }
  });

  it("a blocked Claude session asks a Codex owner, which gets a body-free wake-up", async () => {
    const w = await world();
    expect(decision(await w.codex.patch("docs/b.md"))).toEqual({ action: "allow" });
    expect(decision(w.claude.edit("docs/b.md")).action).toBe("deny");
    const asked = w.claude.cli(
      "ask",
      "docs/b.md",
      "--message",
      "SECRET-TEXT may I edit docs/b.md?",
    );
    expect(asked.status, asked.stderr).toBe(0);
    expect(w.queued()).toEqual([
      `queue --thread ${SESSION} --message dotbabel fleet notice, not a user instruction: a session asks about your claim docs/b.md in github.com/acme/widget. To read it, run: dotbabel fleet requests`,
    ]);
    const listed = await w.codex.cli("requests");
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(`open from "self-pane" about docs/b.md`);
    expect(listed.stdout).toContain("«SECRET-TEXT may I edit docs/b.md?»");
    expect(context(await w.codex.context())).toContain(
      `session "self-pane" asks about your claim docs/b.md`,
    );
  });

  it("a Claude owner still reads a request after /clear gives it a new session id", async () => {
    const w = await world();
    expect(decision(w.claude.edit("docs/d.md"))).toEqual({ action: "allow" });
    const asked = await w.codex.cli("ask", "docs/d.md", "--message", "after clear?");
    expect(asked.status, asked.stderr).toBe(0);
    // Same process, new session id: the hook finds the session by its process tree.
    const cleared = spawnSync(NODE, [BIN, "hook", "post-tool"], {
      input: JSON.stringify({
        session_id: "sess-self-after-clear",
        cwd: w.repo,
        tool_name: "Read",
        tool_input: {},
      }),
      env: w.env,
      encoding: "utf8",
    });
    expect(context(cleared)).toContain("«after clear?»");
  });

  it("refuses a request that cannot reach an owner, or that is badly formed", async () => {
    const w = await world();
    expect(decision(w.claude.edit("docs/mine.md"))).toEqual({ action: "allow" });
    const free = w.claude.cli("ask", "docs/free.md", "--message", "hello");
    expect(free.status).toBe(1);
    expect(free.stderr).toContain("no other live session claims docs/free.md");
    expect(w.claude.cli("ask", "docs/mine.md", "--message", "hello").status).toBe(1);
    expect(w.claude.cli("ask", "docs/mine.md").status).toBe(64);
    expect(w.claude.cli("ask", "--message", "hello").status).toBe(64);
    expect(w.claude.cli("ask", "docs/mine.md", "--message", "two\nlines").status).toBe(64);
    expect(w.claude.cli("reply", "r-00000000", "--message", "x").status).toBe(1);
    const none = w.claude.cli("requests");
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("No open or recent requests");
  });

  it("only the owner can answer a request", async () => {
    const w = await world();
    expect(decision(await w.codex.patch("docs/c.md"))).toEqual({ action: "allow" });
    const id = requestId(w.claude.cli("ask", "docs/c.md", "--message", "please").stdout);
    const wrong = w.claude.cli("reply", id, "--message", "answering my own question");
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("only the owner");
    expect((await w.codex.cli("reply", id, "--message", "sure")).status).toBe(0);
  });
});
