import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

it("adds the absolute folders in DOTBABEL_PEER_READ_ROOTS, still without secrets", () => {
  const shared = path.join(root, "shared-lib");
  fs.mkdirSync(shared);
  const saved = process.env.DOTBABEL_PEER_READ_ROOTS;
  try {
    expect(decide("Read", { file_path: path.join(shared, "index.mjs") })).toBe("deny");
    process.env.DOTBABEL_PEER_READ_ROOTS = ["relative/ignored", shared].join(path.delimiter);
    expect(decide("Read", { file_path: path.join(shared, "index.mjs") })).toBe("allow");
    expect(bash(`rg -n x '${shared}'`)).toBe("allow");
    expect(decide("Read", { file_path: path.join(shared, ".env") })).toBe("deny");
    expect(decide("Read", { file_path: path.join(root, "relative", "ignored", "a") })).toBe("deny");
    expect(decide("Read", { file_path: "/etc/hostname" })).toBe("deny");
  } finally {
    if (saved === undefined) delete process.env.DOTBABEL_PEER_READ_ROOTS;
    else process.env.DOTBABEL_PEER_READ_ROOTS = saved;
  }
});

// A git repository with each file written, and the tracked ones added to the index.
function gitRepo(files, ignore) {
  execFileSync("git", ["init", "-q", repo]);
  if (ignore) fs.writeFileSync(path.join(repo, ".gitignore"), ignore);
  for (const [file, tracked] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), "TOKEN\n");
    if (tracked) execFileSync("git", ["-C", repo, "add", "-f", file]);
  }
}
const reasonOf = (tool, tool_input) =>
  peerHook(p, advisor, { ...input, tool_name: tool, tool_input })?.hookSpecificOutput
    ?.permissionDecisionReason;

it("refuses an rg, Grep, or git grep search that would read a tracked secret file", () => {
  gitRepo({ "config/credentials.json": true, "src/a.mjs": true });
  for (const command of ["rg -n TOKEN", "rg -n TOKEN .", "rg -n TOKEN config", "git grep -n TOKEN"])
    expect(bash(command), command).toBe("deny");
  expect(decide("Grep", { pattern: "TOKEN" })).toBe("deny");
  expect(decide("Grep", { pattern: "TOKEN", path: "config" })).toBe("deny");
  expect(bash("rg -n TOKEN src")).toBe("allow");
  expect(decide("Grep", { pattern: "TOKEN", path: "src" })).toBe("allow");
  const reason = reasonOf("Bash", { command: "rg -n TOKEN" });
  expect(reason).toContain("config/credentials.json");
  expect(reason).toContain("narrower path");
});

it("refuses an unignored untracked secret, and follows rg on ignored and hidden files", () => {
  gitRepo({ "certs/server.key": false, "src/a.mjs": true });
  expect(bash("rg -n TOKEN")).toBe("deny");
  fs.writeFileSync(path.join(repo, ".gitignore"), "*.key\n");
  expect(bash("rg -n TOKEN")).toBe("allow");
  // rg skips hidden files below the folder it searches; the Grep tool passes --hidden.
  fs.mkdirSync(path.join(repo, ".config"));
  fs.writeFileSync(path.join(repo, ".config", "credentials.json"), "TOKEN\n");
  expect(bash("rg -n TOKEN")).toBe("allow");
  expect(decide("Grep", { pattern: "TOKEN" })).toBe("deny");
});

it("finds the folders rg searches after its pattern and value options", () => {
  gitRepo({ "credentials.json": true, "src/a.mjs": true });
  for (const command of ["rg src", "rg -g '*.mjs' src", "rg --max-count=3 TOKEN", "rg -n -- TOKEN"])
    expect(bash(command), command).toBe("deny");
  for (const command of [
    "rg -e TOKEN src",
    "rg --regexp=TOKEN src",
    "rg -nA 2 TOKEN src",
    "rg -nA2 TOKEN src",
    "rg --max-count 3 TOKEN src",
    "rg -g '*.mjs' TOKEN src",
    "rg -n TOKEN -- src",
  ])
    expect(bash(command), command).toBe("allow");
});

it("refuses a git grep over a tracked hidden secret that rg would skip", () => {
  gitRepo({ ".secrets/id_rsa": true, "src/a.mjs": true });
  expect(bash("rg -n TOKEN")).toBe("allow");
  expect(bash("git grep -n TOKEN")).toBe("deny");
  expect(decide("Bash", { command: `git -C '${repo}' grep -n TOKEN` }, { cwd: mainTree })).toBe(
    "deny",
  );
  expect(bash("git grep -n TOKEN -- src")).toBe("deny");
});

it("searches an ignored folder that rg is given by name", () => {
  gitRepo({ "vendor/server.key": false, "src/a.mjs": true }, "vendor/\n");
  expect(bash("rg -n TOKEN")).toBe("allow");
  expect(bash("rg -n TOKEN vendor")).toBe("deny");
});

it("walks the visible files of a folder outside git, up to a limit", () => {
  const shared = path.join(root, "shared-lib");
  fs.mkdirSync(path.join(shared, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(shared, ".hidden", "id_rsa"), "TOKEN\n");
  const saved = process.env.DOTBABEL_PEER_READ_ROOTS;
  process.env.DOTBABEL_PEER_READ_ROOTS = shared;
  try {
    expect(bash(`rg -n TOKEN '${shared}'`)).toBe("allow");
    fs.mkdirSync(path.join(shared, "keys"));
    fs.writeFileSync(path.join(shared, "keys", "id_rsa"), "TOKEN\n");
    expect(bash(`rg -n TOKEN '${shared}'`)).toBe("deny");
    fs.rmSync(path.join(shared, "keys"), { recursive: true });
    const many = path.join(shared, "many");
    fs.mkdirSync(many);
    for (let i = 0; i <= 10000; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), "");
    const reason = reasonOf("Bash", { command: `rg -n TOKEN '${shared}'` });
    expect(reason).toContain("narrower path");
  } finally {
    if (saved === undefined) delete process.env.DOTBABEL_PEER_READ_ROOTS;
    else process.env.DOTBABEL_PEER_READ_ROOTS = saved;
  }
});
