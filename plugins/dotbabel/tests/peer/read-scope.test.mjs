import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { it, expect, beforeEach } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { peerHook } from "../../src/peer/hooks.mjs";
import { createState, registerMain, pairAdvisor } from "../../src/peer/state.mjs";

let root, repo, mainTree, outside, p, advisor, input;
beforeEach(() => {
  root = fs.realpathSync(makeTempDir("peer-read-scope-"));
  repo = path.join(root, "repo");
  mainTree = path.join(root, "elsewhere", "main-tree");
  outside = path.join(root, "outside");
  for (const dir of [repo, mainTree, outside, path.join(repo, "src")])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "x");
  fs.symlinkSync(outside, path.join(repo, "escape"));
  const s = createState("r");
  const main = { key: "m", repo: "r", worktree: mainTree };
  advisor = { key: "a", repo: "r", worktree: repo };
  p = registerMain(s, main, { alive: () => true });
  pairAdvisor(s, advisor, p.code, { alive: () => true });
  input = { hook_event_name: "PreToolUse", cwd: repo, session_id: "sid" };
});
const decide = (tool, tool_input, extra = {}) =>
  peerHook(p, advisor, { ...input, ...extra, tool_name: tool, tool_input })?.hookSpecificOutput
    ?.permissionDecision ?? "allow";
const bash = (command) => decide("Bash", { command });

it("allows reads in the Advisor's and Main's worktrees, wherever Main's is", () => {
  expect(decide("Read", { file_path: path.join(repo, "src", "a.mjs") })).toBe("allow");
  expect(decide("Read", { file_path: path.join(mainTree, "b.mjs") })).toBe("allow");
  expect(decide("Grep", { pattern: "x", path: "src" })).toBe("allow");
  expect(decide("Glob", { pattern: "**/*.mjs" })).toBe("allow");
  expect(decide("Read", { filePath: path.join(repo, "README.md") })).toBe("allow");
  expect(bash("ls src")).toBe("allow");
  expect(bash(`git -C '${mainTree}' diff`)).toBe("allow");
  expect(bash("rg -n price src --glob '*.mjs'")).toBe("allow");
});
it("refuses reads outside the pair, through a .. escape, or through a symlink", () => {
  expect(decide("Read", { file_path: "/etc/hostname" })).toBe("deny");
  expect(decide("Read", { file_path: path.join(repo, "..", "outside", "secret.txt") })).toBe(
    "deny",
  );
  expect(decide("Read", { file_path: path.join(repo, "escape", "secret.txt") })).toBe("deny");
  expect(decide("Grep", { pattern: "x", path: outside })).toBe("deny");
  expect(decide("Glob", { pattern: "*", path: "/home" })).toBe("deny");
  expect(decide("Read", { filePath: "/etc/passwd" })).toBe("deny");
  for (const command of [
    "cat /etc/hostname",
    "cat ../outside/secret.txt",
    "cat escape/secret.txt",
    "find / -name x",
    `git -C '${outside}' log`,
    "git -C/etc log",
    "grep -rn x /etc",
    "rg --file=/etc/passwd x src",
  ])
    expect(bash(command), command).toBe("deny");
});
it("refuses common secret files inside the pair, but not their examples", () => {
  for (const file of [
    ".env",
    ".env.local",
    "config/.npmrc",
    ".ssh/id_ed25519",
    "keys/id_rsa",
    "certs/server.pem",
    "certs/server.key",
    ".aws/credentials",
    "credentials.json",
  ])
    expect(decide("Read", { file_path: path.join(repo, file) }), file).toBe("deny");
  expect(decide("Read", { file_path: path.join(repo, ".env.example") })).toBe("allow");
  expect(decide("Read", { file_path: path.join(repo, "src", "keyboard.mjs") })).toBe("allow");
  expect(bash("cat .env")).toBe("deny");
  expect(bash("git show HEAD:.env")).toBe("deny");
  expect(bash("git show HEAD:src/a.mjs")).toBe("allow");
});
it("allows the pair's own ledger and this session's saved tool results only", () => {
  const ledger = path.join(root, "state", `${createHash("sha256").update("r").digest("hex")}.json`);
  const other = path.join(
    root,
    "state",
    `${createHash("sha256").update("other").digest("hex")}.json`,
  );
  const env = process.env.DOTBABEL_PEER_STATE_DIR;
  process.env.DOTBABEL_PEER_STATE_DIR = path.join(root, "state");
  try {
    expect(decide("Read", { file_path: ledger })).toBe("allow");
    expect(decide("Read", { file_path: other })).toBe("deny");
  } finally {
    if (env === undefined) delete process.env.DOTBABEL_PEER_STATE_DIR;
    else process.env.DOTBABEL_PEER_STATE_DIR = env;
  }
  const project = path.join(root, "projects", "proj");
  const transcript = { transcript_path: path.join(project, "sid.jsonl") };
  const saved = path.join(project, "sid", "tool-results", "out.txt");
  expect(decide("Read", { file_path: saved }, transcript)).toBe("allow");
  expect(
    decide(
      "Read",
      { file_path: path.join(project, "other-sid", "tool-results", "out.txt") },
      transcript,
    ),
  ).toBe("deny");
  expect(decide("Read", { file_path: path.join(project, "sid.jsonl") }, transcript)).toBe("deny");
});
it("leaves Main's reads alone", () => {
  const main = p.main;
  const out = peerHook(p, main, {
    ...input,
    tool_name: "Read",
    tool_input: { file_path: "/etc/hostname" },
  });
  expect(out?.hookSpecificOutput?.permissionDecision).not.toBe("deny");
});

it("resolves git words against its -C folder, skips the subcommand, and checks bare names", () => {
  const away = { cwd: outside };
  const run = (command) => decide("Bash", { command }, away);
  expect(run(`git -C '${repo}' show HEAD:src/a.mjs`)).toBe("allow");
  expect(run(`git -C '${repo}' show HEAD:.env`)).toBe("deny");
  expect(run("git status")).toBe("allow");
  expect(run("git log secret.txt")).toBe("deny");
  expect(run("cat secret.txt")).toBe("deny");
});

it("says whether a read was outside the pair or a secret file", () => {
  const reason = (file_path) =>
    peerHook(p, advisor, { ...input, tool_name: "Read", tool_input: { file_path } })
      .hookSpecificOutput.permissionDecisionReason;
  expect(reason("/etc/hostname")).toContain("This path is outside them.");
  expect(reason(path.join(repo, ".env"))).toContain("never reads secret files");
});

it("refuses searches that read hidden, ignored, untracked, or linked files, and points to rg", () => {
  for (const command of [
    "grep -rn TOKEN .",
    "grep -R x src",
    "grep --recursive x .",
    "grep -d recurse x .",
    "grep --directories=recurse x .",
    "egrep -ri x .",
    "rg --hidden x",
    "rg -. x",
    "rg -uu x",
    "rg -nu x",
    "rg --no-ignore x",
    "rg --no-ignore-vcs x",
    "rg -L x",
    "rg --follow x",
    "git grep --untracked x",
    "git grep --no-index x",
  ])
    expect(bash(command), command).toBe("deny");
  for (const command of [
    "rg -n TOKEN src",
    "rg --glob '*.mjs' -n x",
    "grep -n x app.js",
    "git grep -n x",
    "find . -name '*.mjs'",
  ])
    expect(bash(command), command).toBe("allow");
  const reason = peerHook(p, advisor, {
    ...input,
    tool_name: "Bash",
    tool_input: { command: "grep -rn TOKEN ." },
  }).hookSpecificOutput.permissionDecisionReason;
  expect(reason).toContain("rg");
});
