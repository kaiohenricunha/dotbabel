// End-to-end tests for the Codex host adapter of bin/dotbabel-fleet.mjs: the
// hooks that Codex runs with DOTBABEL_FLEET_HOST=codex, and `fleet setup
// --harness codex`.
//
// A Codex session is a real long-lived process named `codex`, and each hook
// runs as its child, as in Codex CLI 0.163.0 (see
// fixtures/codex-hooks/codex-0.163.0.json). A Claude Code session is a
// `sleep` child in an isolated Claude registry. The ledger, the registry, and
// CODEX_HOME are temp dirs.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { readOwnerRecords, repoDir } from "../src/fleet/ledger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../bin/dotbabel-fleet.mjs");
const HOOKS = path.resolve(__dirname, "../hooks");
const NODE = process.execPath;
const REPO_KEY = "github.com/acme/widget";
const HAS_PROC = fs.existsSync("/proc/self/stat");
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/codex-hooks/codex-0.163.0.json"), "utf8"),
);
const SESSION = FIXTURE.preToolUseApplyPatch.session_id;

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

let claudePeer;
beforeAll(() => {
  if (!HAS_PROC) return;
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  claudePeer = { child, pid: child.pid, procStart: procStart(child.pid) };
});
afterAll(() => claudePeer?.child.kill("SIGKILL"));

/** A governed repo, a Claude registry with one live peer, and an isolated ledger. */
function world() {
  const root = makeTempDir("fleet-codex-");
  const repo = path.join(root, "widget");
  const config = path.join(root, "home", ".claude");
  const state = path.join(root, "state");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: cleanEnv() });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], {
    cwd: repo,
    env: cleanEnv(),
  });
  fs.writeFileSync(path.join(repo, ".dotbabel.json"), "{}");
  fs.writeFileSync(path.join(repo, "docs", "a.md"), "a\n");
  fs.writeFileSync(path.join(repo, "docs", "b.md"), "b\n");
  fs.writeFileSync(
    path.join(config, "sessions", `${claudePeer.pid}.json`),
    JSON.stringify({
      kind: "interactive",
      pid: claudePeer.pid,
      sessionId: "sess-peer",
      procStart: claudePeer.procStart,
      name: "peer-pane",
    }),
  );
  const env = cleanEnv({
    HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: config,
    DOTBABEL_FLEET_STATE_DIR: state,
  });
  const w = { root, repo, env };
  /** A Claude Code hook call, from the registered peer session. */
  w.claude = (event, payload) =>
    spawnSync(NODE, [BIN, "hook", event], {
      input: JSON.stringify({ session_id: "sess-peer", cwd: repo, ...payload }),
      env,
      encoding: "utf8",
    });
  w.records = () => readOwnerRecords(repoDir(state, REPO_KEY));
  w.claimsOf = (prefix) =>
    w
      .records()
      .filter((r) => r.owner.name?.startsWith(prefix))
      .flatMap((r) => r.claims.map((c) => c.pattern));
  return w;
}

/**
 * A live process named `codex` that runs each requested hook as its child,
 * with DOTBABEL_FLEET_HOST=codex, the way Codex runs installed hooks.
 */
async function startCodex(w) {
  const script = path.join(w.root, "codex");
  fs.writeFileSync(
    script,
    `const { spawnSync } = require("node:child_process");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const { event, payload } = JSON.parse(line);
  const r = spawnSync(${JSON.stringify(NODE)}, [${JSON.stringify(BIN)}, "hook", event], {
    input: JSON.stringify(payload), env: { ...process.env, DOTBABEL_FLEET_HOST: "codex" }, encoding: "utf8",
  });
  process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }) + "\\n");
});
`,
  );
  const child = spawn(NODE, [script], { env: w.env, stdio: ["pipe", "pipe", "inherit"] });
  const lines = readline.createInterface({ input: child.stdout });
  const replies = [];
  const waiters = [];
  lines.on("line", (line) =>
    waiters.length ? waiters.shift()(JSON.parse(line)) : replies.push(JSON.parse(line)),
  );
  await new Promise((resolve) => child.once("spawn", resolve));
  return {
    pid: child.pid,
    key: `${child.pid}-${procStart(child.pid)}`,
    hook(event, payload) {
      child.stdin.write(
        `${JSON.stringify({ event, payload: { ...FIXTURE.preToolUseApplyPatch, cwd: w.repo, ...payload } })}\n`,
      );
      return new Promise((resolve) =>
        replies.length ? resolve(replies.shift()) : waiters.push(resolve),
      );
    },
    patch(...headers) {
      return this.hook("pre-edit", {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: {
          command: ["*** Begin Patch", ...headers.flatMap((h) => [h, "+x"]), "*** End Patch"].join(
            "\n",
          ),
        },
      });
    },
    stop: () => child.kill("SIGKILL"),
  };
}

function decision(result) {
  expect(result.status).toBe(0);
  if (result.stdout.trim() === "") return { action: "allow" };
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe("PreToolUse");
  return { action: out.permissionDecision, reason: out.permissionDecisionReason };
}

describe.skipIf(!HAS_PROC)("Codex hooks", () => {
  it("an apply_patch edit claims every file in the patch for the codex process", async () => {
    const w = world();
    const codex = await startCodex(w);
    try {
      const out = await codex.patch(
        "*** Update File: docs/a.md",
        `*** Add File: ${path.join(w.repo, "docs/new.md")}`,
      );
      expect(decision(out)).toEqual({ action: "allow" });
      const [record] = w.records();
      expect(record.owner).toMatchObject({
        key: codex.key,
        sessionId: SESSION,
        name: `codex ${SESSION.slice(-8)}`,
      });
      expect(record.claims.map((c) => c.pattern)).toEqual(["docs/a.md", "docs/new.md"]);
    } finally {
      codex.stop();
    }
  });

  it("denies a patch that touches a live Claude session's claim, and keeps no claim from it", async () => {
    const w = world();
    expect(
      decision(
        w.claude("pre-edit", {
          tool_name: "Edit",
          tool_input: { file_path: path.join(w.repo, "docs/a.md") },
        }),
      ),
    ).toEqual({ action: "allow" });
    const codex = await startCodex(w);
    try {
      const d = decision(
        await codex.patch("*** Update File: docs/b.md", "*** Update File: docs/a.md"),
      );
      expect(d.action).toBe("deny");
      expect(d.reason).toContain('the live session "peer-pane" claims docs/a.md');
      expect(w.claimsOf("codex")).toEqual([]);
      expect(w.claimsOf("peer-pane")).toEqual(["docs/a.md"]);
    } finally {
      codex.stop();
    }
  });

  it("denies a Claude edit to a file that a live Codex session claims", async () => {
    const w = world();
    const codex = await startCodex(w);
    try {
      expect(decision(await codex.patch("*** Update File: docs/a.md"))).toEqual({
        action: "allow",
      });
      const d = decision(
        w.claude("pre-edit", {
          tool_name: "Edit",
          tool_input: { file_path: path.join(w.repo, "docs/a.md") },
        }),
      );
      expect(d.action).toBe("deny");
      expect(d.reason).toContain(`"codex ${SESSION.slice(-8)}" claims docs/a.md`);
    } finally {
      codex.stop();
    }
  });

  it("frees a Codex claim when the codex process exits", async () => {
    const w = world();
    const codex = await startCodex(w);
    expect(decision(await codex.patch("*** Update File: docs/a.md"))).toEqual({ action: "allow" });
    codex.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      decision(
        w.claude("pre-edit", {
          tool_name: "Edit",
          tool_input: { file_path: path.join(w.repo, "docs/a.md") },
        }),
      ),
    ).toEqual({ action: "allow" });
  });

  it("turns an escalation into a deny, because Codex does not support ask", async () => {
    const w = world();
    expect(
      decision(
        w.claude("pre-edit", {
          tool_name: "Edit",
          tool_input: { file_path: path.join(w.repo, "docs/a.md") },
        }),
      ),
    ).toEqual({ action: "allow" });
    const fast = { DOTBABEL_FLEET_ESCALATE_MINUTES: "0.0000001" };
    const codex = await startCodex({ ...w, env: { ...w.env, ...fast } });
    try {
      expect(decision(await codex.patch("*** Update File: docs/a.md")).action).toBe("deny");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = decision(await codex.patch("*** Update File: docs/a.md"));
      expect(second.action).toBe("deny");
      expect(second.reason).toContain("did not release the claim");
      expect(second.reason).toContain("cannot ask for approval from a hook");
    } finally {
      codex.stop();
    }
  });

  it("the merge token holds across hosts: a Codex merge blocks a Claude merge", async () => {
    const w = world();
    const codex = await startCodex(w);
    try {
      const merge = {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 5 --squash" },
      };
      expect(decision(await codex.hook("pre-bash", merge))).toEqual({ action: "allow" });
      const d = decision(w.claude("pre-bash", merge));
      expect(d.action).toBe("deny");
      expect(d.reason).toContain(
        `the live session "codex ${SESSION.slice(-8)}" holds the merge token`,
      );
    } finally {
      codex.stop();
    }
  });

  it("allows silently and claims nothing without a codex ancestor, a UUID, or a patch", async () => {
    const w = world();
    const direct = spawnSync(NODE, [BIN, "hook", "pre-edit"], {
      input: JSON.stringify({
        ...FIXTURE.preToolUseApplyPatch,
        cwd: w.repo,
        tool_input: { command: "*** Begin Patch\n*** Update File: docs/a.md\n*** End Patch" },
      }),
      env: { ...w.env, DOTBABEL_FLEET_HOST: "codex" },
      encoding: "utf8",
    });
    expect(decision(direct)).toEqual({ action: "allow" });
    const codex = await startCodex(w);
    try {
      expect(
        decision(
          await codex.hook("pre-edit", {
            session_id: "not-a-uuid",
            tool_name: "apply_patch",
            tool_input: { command: "*** Begin Patch\n*** Update File: docs/a.md\n*** End Patch" },
          }),
        ),
      ).toEqual({ action: "allow" });
      expect(
        decision(
          await codex.hook("pre-edit", {
            tool_name: "apply_patch",
            tool_input: { command: "echo not a patch" },
          }),
        ),
      ).toEqual({ action: "allow" });
      expect(decision(await codex.patch("*** Update File: /elsewhere/outside.md"))).toEqual({
        action: "allow",
      });
      expect(w.records()).toEqual([]);
    } finally {
      codex.stop();
    }
  });

  it("tells a starting Codex session about the live claims in its repo", async () => {
    const w = world();
    expect(
      decision(
        w.claude("pre-edit", {
          tool_name: "Edit",
          tool_input: { file_path: path.join(w.repo, "docs/a.md") },
        }),
      ),
    ).toEqual({ action: "allow" });
    const codex = await startCodex(w);
    try {
      const out = await codex.hook("session-start", { ...FIXTURE.sessionStart, cwd: w.repo });
      expect(out.status).toBe(0);
      expect(out.stdout).toContain("docs/a.md");
      expect(out.stdout).toContain("peer-pane");
    } finally {
      codex.stop();
    }
  });
});

describe("dotbabel fleet setup --harness codex", () => {
  const setup = (codexHome, args = ["--harness", "codex"]) =>
    spawnSync(NODE, [BIN, "setup", ...args], {
      env: cleanEnv({ CODEX_HOME: codexHome }),
      encoding: "utf8",
    });

  it("adds the fleet and task hooks to hooks.json, once, and keeps other hooks", () => {
    const home = makeTempDir("fleet-codex-home-");
    const peerHook = {
      hooks: [
        { type: "command", command: "'node' 'dotbabel-peer.mjs' hook SessionStart", timeout: 10 },
      ],
    };
    fs.writeFileSync(
      path.join(home, "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [peerHook] } }),
    );
    const first = setup(home);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("/hooks");
    const once = fs.readFileSync(path.join(home, "hooks.json"), "utf8");
    expect(setup(home).status).toBe(0);
    expect(fs.readFileSync(path.join(home, "hooks.json"), "utf8")).toBe(once);

    const { hooks } = JSON.parse(once);
    const guard = `'${path.join(HOOKS, "fleet-guard.sh")}'`;
    const command = (event, matcher) =>
      hooks[event]
        .filter((g) => g.matcher === matcher)
        .flatMap((g) => g.hooks.map((h) => h.command));
    expect(command("PreToolUse", "^apply_patch$")).toEqual([
      `DOTBABEL_FLEET_HOST=codex ${guard} pre-edit`,
    ]);
    expect(command("PreToolUse", "^Bash$")).toEqual([
      `DOTBABEL_FLEET_HOST=codex ${guard} pre-bash`,
    ]);
    expect(command("PostToolUse", undefined)).toEqual([
      `DOTBABEL_FLEET_HOST=codex ${guard} post-tool`,
    ]);
    expect(command("UserPromptSubmit", undefined)).toEqual([
      `DOTBABEL_FLEET_HOST=codex ${guard} prompt`,
    ]);
    expect(command("SessionStart", undefined)).toEqual([
      "'node' 'dotbabel-peer.mjs' hook SessionStart",
      `DOTBABEL_FLEET_HOST=codex ${guard} session-start`,
      `'${path.join(HOOKS, "task-context.sh")}'`,
    ]);
  });

  it("refuses a symlinked hooks.json and an unknown harness", () => {
    const home = makeTempDir("fleet-codex-link-");
    fs.writeFileSync(path.join(home, "real.json"), "{}");
    fs.symlinkSync(path.join(home, "real.json"), path.join(home, "hooks.json"));
    const linked = setup(home);
    expect(linked.status).toBe(2);
    expect(linked.stderr).toMatch(/symlink/);
    expect(fs.readFileSync(path.join(home, "real.json"), "utf8")).toBe("{}");
    for (const args of [[], ["--harness", "gemini"], ["--harness", "claude"]])
      expect(setup(home, args).status).toBe(64);
  });
});

describe("fleet commands in a Codex shell", () => {
  it("select the Codex host from CODEX_THREAD_ID, and DOTBABEL_FLEET_HOST overrides it", () => {
    const repo = makeTempDir("fleet-codex-cli-");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: cleanEnv() });
    const board = (extra) =>
      spawnSync(NODE, [BIN, "claim", "docs/**"], {
        cwd: repo,
        env: cleanEnv({
          DOTBABEL_FLEET_STATE_DIR: makeTempDir("fleet-codex-cli-state-"),
          CLAUDE_CONFIG_DIR: makeTempDir("fleet-codex-cli-claude-"),
          ...extra,
        }),
        encoding: "utf8",
      });
    // No codex process above this test, so neither host finds a session.
    const codex = board({ CODEX_THREAD_ID: SESSION });
    expect(codex.status).toBe(2);
    expect(codex.stderr).toContain("cannot find the Codex session");
    const forced = board({ CODEX_THREAD_ID: SESSION, DOTBABEL_FLEET_HOST: "claude" });
    expect(forced.stderr).toContain("cannot find the Claude Code session");
  });
});
