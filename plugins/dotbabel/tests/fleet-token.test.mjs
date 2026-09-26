// Behavior tests for the merge token of `dotbabel fleet`: the per-repo lease
// that lets one session at a time rebase onto the base, attest, and merge,
// and the detector that spots those commands in a shell command line.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import {
  DEFAULT_TOKEN_IDLE_MS,
  TOKEN_SCHEMA,
  findTokenCommand,
  formatTokenDeny,
  formatTokenStatus,
  readToken,
  releaseToken,
  takeToken,
  tokenHolder,
  touchToken,
} from "../src/fleet/token.mjs";

const T0 = Date.parse("2026-09-26T12:00:00.000Z");
const REPO = "github.com/acme/widget";
const A = { key: "100-1", pid: 100, procStart: "1", sessionId: "sess-a", name: "pane-a" };
const B = { key: "200-2", pid: 200, procStart: "2", sessionId: "sess-b", name: "pane-b" };
const DEAD_PID = 666;
const isAlive = (owner) => owner.pid !== DEAD_PID;

function take(dir, owner, overrides = {}) {
  return takeToken(dir, { repoKey: REPO, owner, branch: "feat/x", kind: "rebase", now: T0, isAlive, ...overrides });
}

describe("takeToken", () => {
  it("gives a free token to the first session and records who took it", () => {
    const dir = makeTempDir("fleet-token-");
    const result = take(dir, A);
    expect(result.taken).toBe(true);
    expect(readToken(dir)).toMatchObject({
      schema: TOKEN_SCHEMA,
      repo: REPO,
      owner: { key: A.key, name: "pane-a" },
      branch: "feat/x",
      kind: "rebase",
      takenAt: new Date(T0).toISOString(),
      touchedAt: new Date(T0).toISOString(),
    });
  });

  it("refuses a second session while the holder is live and active", () => {
    const dir = makeTempDir("fleet-token-");
    take(dir, A);
    const result = take(dir, B, { kind: "merge", now: T0 + 60_000 });
    expect(result.taken).toBe(false);
    expect(result.holder.owner.key).toBe(A.key);
    expect(readToken(dir).owner.key).toBe(A.key);
  });

  it("lets the holder take it again, which keeps takenAt and moves touchedAt", () => {
    const dir = makeTempDir("fleet-token-");
    take(dir, A);
    expect(take(dir, A, { kind: "attest", now: T0 + 5_000 }).taken).toBe(true);
    expect(readToken(dir)).toMatchObject({
      kind: "attest",
      takenAt: new Date(T0).toISOString(),
      touchedAt: new Date(T0 + 5_000).toISOString(),
    });
  });

  it("frees the token of a session that exited", () => {
    const dir = makeTempDir("fleet-token-");
    take(dir, { ...A, key: "666-9", pid: DEAD_PID });
    expect(take(dir, B).taken).toBe(true);
    expect(readToken(dir).owner.key).toBe(B.key);
  });

  it("frees a token that was not used for the idle window", () => {
    const dir = makeTempDir("fleet-token-");
    take(dir, A);
    expect(take(dir, B, { now: T0 + DEFAULT_TOKEN_IDLE_MS - 1 }).taken).toBe(false);
    expect(take(dir, B, { now: T0 + DEFAULT_TOKEN_IDLE_MS }).taken).toBe(true);
  });

  it("uses a custom idle window", () => {
    const dir = makeTempDir("fleet-token-");
    take(dir, A);
    expect(take(dir, B, { now: T0 + 1_000, idleMs: 1_000 }).taken).toBe(true);
  });

  it("takes the token over a stale lock", () => {
    const dir = makeTempDir("fleet-token-");
    const lock = path.join(dir, "merge-token.lock");
    fs.mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(take(dir, A).taken).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("throws when another process holds the lock for longer than the wait", () => {
    const dir = makeTempDir("fleet-token-");
    fs.mkdirSync(path.join(dir, "merge-token.lock"), { recursive: true });
    expect(() => take(dir, A, { lockWaitMs: 30 })).toThrow(/lock/);
  });
});

describe("readToken and tokenHolder", () => {
  it("reads nothing from an empty directory or a foreign file", () => {
    const dir = makeTempDir("fleet-token-");
    expect(readToken(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "merge-token.json"), '{"schema":99,"owner":{"key":"1-1"}}');
    expect(readToken(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "merge-token.json"), "not json");
    expect(readToken(dir)).toBeNull();
  });

  it("reports the holder only while it is live and inside the idle window", () => {
    const dir = makeTempDir("fleet-token-");
    take(dir, A);
    const token = readToken(dir);
    expect(tokenHolder(token, { now: T0, isAlive })?.owner.key).toBe(A.key);
    expect(tokenHolder(token, { now: T0 + DEFAULT_TOKEN_IDLE_MS, isAlive })).toBeNull();
    expect(tokenHolder(token, { now: T0, isAlive: () => false })).toBeNull();
    expect(tokenHolder(null, { now: T0, isAlive })).toBeNull();
  });
});

describe("touchToken and releaseToken", () => {
  it("moves touchedAt only for the holder", () => {
    const dir = makeTempDir("fleet-token-");
    take(dir, A);
    expect(touchToken(dir, B.key, { now: T0 + 10 })).toBe(false);
    expect(touchToken(dir, A.key, { now: T0 + 10 })).toBe(true);
    expect(readToken(dir).touchedAt).toBe(new Date(T0 + 10).toISOString());
    expect(touchToken(makeTempDir("fleet-token-"), A.key, { now: T0 })).toBe(false);
  });

  it("releases only the holder's token", () => {
    const dir = makeTempDir("fleet-token-");
    take(dir, A);
    expect(releaseToken(dir, B.key)).toBe(false);
    expect(readToken(dir)).not.toBeNull();
    expect(releaseToken(dir, A.key)).toBe(true);
    expect(readToken(dir)).toBeNull();
    expect(releaseToken(dir, A.key)).toBe(false);
  });
});

describe("findTokenCommand", () => {
  it.each([
    ["git rebase origin/main", "rebase"],
    ["git fetch origin && git rebase origin/main", "rebase"],
    ["git rebase main", "rebase"],
    ["git rebase --onto origin/main feat/parent", "rebase"],
    ["git rebase -i origin/master", "rebase"],
    ["git pull --rebase origin main", "rebase"],
    ["git pull -r origin main", "rebase"],
    ["dotbabel local-attest --pr 12 --no-push", "attest"],
    ["npx dotbabel local-attest --pr 12", "attest"],
    ["npx -y dotbabel-local-attest --pr 12", "attest"],
    ["node plugins/dotbabel/bin/dotbabel.mjs local-attest --pr 12", "attest"],
    ["gh pr merge 12 --squash --delete-branch", "merge"],
    ["cd /tmp && gh pr merge 12 --repo acme/widget --squash", "merge"],
  ])("finds %s", (command, kind) => {
    expect(findTokenCommand(command)?.kind).toBe(kind);
  });

  it.each([
    "git rebase -i HEAD~3",
    "git rebase --continue",
    "git rebase --abort",
    "git rebase feat/other",
    "git pull --rebase",
    "git pull origin main",
    "git log --grep rebase",
    'git commit -m "git rebase origin/main"',
    'echo "gh pr merge 12"',
    "gh pr view 12",
    "dotbabel quality check --profile pr",
    "",
  ])("ignores %j", (command) => {
    expect(findTokenCommand(command)).toBeNull();
  });

  it("reads git -C as the directory and gh --repo as the repository", () => {
    expect(findTokenCommand("git -C ../widget rebase origin/main")).toEqual({ kind: "rebase", cwd: "../widget", repo: null });
    expect(findTokenCommand("gh pr merge 12 --repo acme/widget")).toEqual({ kind: "merge", cwd: null, repo: "acme/widget" });
    expect(findTokenCommand("git rebase origin/trunk", { bases: ["trunk"] })?.kind).toBe("rebase");
  });
});

describe("token text", () => {
  const holder = {
    schema: TOKEN_SCHEMA,
    repo: REPO,
    owner: A,
    branch: "feat/x",
    kind: "attest",
    takenAt: new Date(T0).toISOString(),
    touchedAt: new Date(T0 + 60_000).toISOString(),
  };

  it("tells a blocked session who holds the token and what to do", () => {
    const text = formatTokenDeny({
      repoKey: REPO,
      holder,
      action: "gh pr merge",
      cli: "dotbabel fleet",
      now: T0 + 5 * 60_000,
      idleMs: DEFAULT_TOKEN_IDLE_MS,
    });
    expect(text).toContain('the live Claude Code session "pane-a" holds the merge token for github.com/acme/widget');
    expect(text).toContain("branch feat/x");
    expect(text).toContain("gh pr merge");
    expect(text).toContain('SendMessage "pane-a"');
    expect(text).toContain("dotbabel fleet token release");
    expect(text).toMatch(/frees itself .* at \d\d:\d\d/);
  });

  it("describes a held and a free token in one line", () => {
    expect(formatTokenStatus({ repoKey: REPO, holder, now: T0 + 60_000, idleMs: DEFAULT_TOKEN_IDLE_MS })).toMatch(
      /^Merge token for github.com\/acme\/widget: held by "pane-a" \(branch feat\/x, attest, taken 1m ago\), free at \d\d:\d\d at the latest\.$/,
    );
    expect(formatTokenStatus({ repoKey: REPO, holder: null, now: T0, idleMs: DEFAULT_TOKEN_IDLE_MS })).toBe(
      "Merge token for github.com/acme/widget: free.",
    );
  });
});
