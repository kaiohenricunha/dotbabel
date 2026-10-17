import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { it, expect } from "vitest";
import { makeTempDir } from "../fixtures/temp-dir.mjs";
import { repository, currentSession, endpointAlive } from "../../src/peer/identity.mjs";
import { processState } from "../../src/fleet/registry.mjs";
function repo() {
  const root = makeTempDir("peer-repo-");
  execFileSync("git", ["init", "-q", root]);
  return root;
}
it("uses Fleet's origin normalization and common git directory for worktrees", () => {
  const root = repo();
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:acme/widget.git"]);
  expect(repository(root).key).toBe("github.com/acme/widget");
  expect(repository(repo()).key).toMatch(/^local:/);
});
it("resolves Claude via the registry and validates incarnation and current session id", () => {
  const root = repo(),
    config = makeTempDir("peer-registry-");
  fs.mkdirSync(path.join(config, "sessions"));
  const procStart = processState(process.pid).startTime;
  fs.writeFileSync(
    path.join(config, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      procStart,
      sessionId: "claude-session",
      cwd: root,
      peerProtocol: 1,
      messagingSocketPath: "/tmp/test.sock",
      version: "2.1.302",
    }),
  );
  const env = { CLAUDE_CONFIG_DIR: config };
  const who = currentSession(repository(root), { env, startPid: process.pid });
  expect(who.key).toBe("claude:claude-session");
  expect(endpointAlive(who, { env })).toBe(true);
  const f = path.join(config, "sessions", `${process.pid}.json`),
    x = JSON.parse(fs.readFileSync(f));
  x.sessionId = "cleared";
  fs.writeFileSync(f, JSON.stringify(x));
  expect(endpointAlive(who, { env })).toBe(false);
  expect(endpointAlive({ ...who, procStart: "wrong" }, { env })).toBe(false);
});
it("requires a real Codex process ancestor, never a supplied UUID alone", () => {
  const r = repository(repo());
  expect(() => currentSession(r, { env: { CODEX_THREAD_ID: "fake" }, startPid: 1 })).toThrow(
    /Codex|session/,
  );
});

it("identifies separate worktrees as one repository while exposing live uncommitted files", () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "evidence.txt"), "committed\n");
  execFileSync("git", ["-C", root, "add", "evidence.txt"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "fixture",
  ]);
  const worktree = path.join(makeTempDir("peer-worktree-"), "main");
  execFileSync("git", ["-C", root, "worktree", "add", "-qb", "implementation", worktree]);
  expect(repository(worktree).key).toBe(repository(root).key);
  expect(repository(worktree).worktree).toBe(worktree);
  fs.writeFileSync(path.join(worktree, "evidence.txt"), "uncommitted Main state\n");
  fs.writeFileSync(path.join(worktree, "new.txt"), "untracked\n");
  expect(
    fs.readFileSync(path.join(repository(worktree).worktree, "evidence.txt"), "utf8"),
  ).toContain("uncommitted");
  expect(
    execFileSync("git", ["-C", worktree, "status", "--porcelain"], { encoding: "utf8" }),
  ).toContain("?? new.txt");
  expect(fs.readFileSync(path.join(root, "evidence.txt"), "utf8")).toBe("committed\n");
});
