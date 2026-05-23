import { describe, it, expect } from "vitest";

import { validateConfig } from "../src/local-attest-config.mjs";
import {
  PreconditionError,
  appendAuditLog,
  applyLabel,
  checkPreconditions,
  execute,
  runMatrix,
  upsertComment,
} from "../src/local-attest-runner.mjs";

/**
 * Build a `deps` stub whose `run`/`ghApiWithInput`/`appendLog` record every
 * invocation. The `runReplies` parameter is a regex-keyed table mapping a
 * command-substring pattern to its mocked result.
 */
function makeDeps({ runReplies = [], hostname = "stub-host" } = {}) {
  const calls = { run: [], gh: [], log: [], warn: [], appendLog: [] };

  const run = (cmd, opts = {}) => {
    calls.run.push({ cmd, opts });
    for (const [pattern, result] of runReplies) {
      if (pattern.test(cmd)) {
        return { status: 0, stdout: "", stderr: "", ...result };
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  return {
    deps: {
      run,
      ghApiWithInput(cmd, payload) {
        calls.gh.push({ cmd, payload });
        return "";
      },
      appendLog(path, line) {
        calls.appendLog.push({ path, line });
      },
      hostname() {
        return hostname;
      },
      log(msg) {
        calls.log.push(msg);
      },
      warn(msg) {
        calls.warn.push(msg);
      },
    },
    calls,
  };
}

function baseConfig(overrides = {}) {
  return validateConfig({
    matrix: [
      { name: "lint", mode: "hard", command: "echo lint" },
      { name: "test", mode: "hard", command: "echo test" },
      { name: "knip", mode: "advisory", command: "echo knip" },
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// checkPreconditions
// ---------------------------------------------------------------------------

describe("checkPreconditions", () => {
  const HAPPY_REPLIES = [
    [/git rev-parse --abbrev-ref HEAD/, { stdout: "feature-x\n" }],
    [/git status --porcelain/, { stdout: "" }],
    [/gh auth status/, { status: 0 }],
    [/gh repo view --json nameWithOwner/, { stdout: "kaio/repo\n" }],
    [/gh pr view --json number/, { stdout: "42\n" }],
    [/git rev-parse HEAD/, { stdout: "abc1234abc1234abc1234abc1234abc1234abc12\n" }],
    [/gh pr view 42 --json headRefOid/, { stdout: "abc1234abc1234abc1234abc1234abc1234abc12\n" }],
    [/gh api user --jq \.login/, { stdout: "kaio\n" }],
    [/gh api repos\/.*\/collaborators\/.*\/permission/, { stdout: "ADMIN\n" }],
  ];

  it("succeeds on the happy path", () => {
    const { deps } = makeDeps({ runReplies: HAPPY_REPLIES });
    const pre = checkPreconditions(deps, baseConfig());
    expect(pre.branch).toBe("feature-x");
    expect(pre.repo).toBe("kaio/repo");
    expect(pre.pr).toBe("42");
  });

  it("fails when not inside a git repo", () => {
    const { deps } = makeDeps({ runReplies: [[/git rev-parse --abbrev-ref HEAD/, { status: 1, stderr: "fatal" }]] });
    expect(() => checkPreconditions(deps, baseConfig())).toThrow(PreconditionError);
  });

  it("fails on detached HEAD", () => {
    const { deps } = makeDeps({
      runReplies: [[/git rev-parse --abbrev-ref HEAD/, { stdout: "HEAD\n" }]],
    });
    expect(() => checkPreconditions(deps, baseConfig())).toThrow(/detached HEAD/);
  });

  it("fails when worktree is dirty and requireClean is true", () => {
    const replies = HAPPY_REPLIES.map((p) =>
      p[0].source.includes("git status") ? [p[0], { stdout: " M file.txt\n" }] : p,
    );
    const { deps } = makeDeps({ runReplies: replies });
    expect(() => checkPreconditions(deps, baseConfig())).toThrow(/worktree is not clean/);
  });

  it("skips the dirty check when requireClean is false", () => {
    const replies = HAPPY_REPLIES.map((p) =>
      p[0].source.includes("git status") ? [p[0], { stdout: " M file.txt\n" }] : p,
    );
    const { deps } = makeDeps({ runReplies: replies });
    expect(() => checkPreconditions(deps, baseConfig({ requireClean: false }))).not.toThrow();
  });

  it("fails when gh is not authenticated", () => {
    const replies = HAPPY_REPLIES.map((p) =>
      p[0].source.includes("gh auth status") ? [p[0], { status: 1, stderr: "not logged in" }] : p,
    );
    const { deps } = makeDeps({ runReplies: replies });
    expect(() => checkPreconditions(deps, baseConfig())).toThrow(/gh is not authenticated/);
  });

  it("fails when no PR for the branch and no --pr passed", () => {
    const replies = HAPPY_REPLIES.map((p) =>
      p[0].source.includes("gh pr view --json number") ? [p[0], { status: 1, stderr: "no pr" }] : p,
    );
    const { deps } = makeDeps({ runReplies: replies });
    expect(() => checkPreconditions(deps, baseConfig())).toThrow(/no open PR/);
  });

  it("fails when local HEAD != PR head", () => {
    const replies = HAPPY_REPLIES.map((p) =>
      p[0].source.includes("git rev-parse HEAD")
        ? [p[0], { stdout: "ffffffffffffffffffffffffffffffffffffffff\n" }]
        : p,
    );
    const { deps } = makeDeps({ runReplies: replies });
    expect(() => checkPreconditions(deps, baseConfig())).toThrow(/differs from PR/);
  });

  it("fails when requireDocker is true and docker is unavailable", () => {
    const replies = [...HAPPY_REPLIES, [/docker info/, { status: 1 }]];
    const { deps } = makeDeps({ runReplies: replies });
    expect(() => checkPreconditions(deps, baseConfig({ requireDocker: true }))).toThrow(
      /Docker is not available/,
    );
  });

  it("warns but does not fail when permission level is outside the trust list", () => {
    const replies = HAPPY_REPLIES.map((p) =>
      p[0].source.includes("collaborators") ? [p[0], { stdout: "READ\n" }] : p,
    );
    const { deps, calls } = makeDeps({ runReplies: replies });
    expect(() => checkPreconditions(deps, baseConfig())).not.toThrow();
    expect(calls.warn.some((w) => /not in the configured trust list/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runMatrix
// ---------------------------------------------------------------------------

describe("runMatrix", () => {
  it("runs every leg in order and records pass/fail", () => {
    const { deps, calls } = makeDeps({
      runReplies: [
        [/echo test/, { status: 1, stderr: "boom" }],
      ],
    });
    const results = runMatrix(deps, baseConfig().matrix);
    expect(results.map((r) => r.name)).toEqual(["lint", "test", "knip"]);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[2].passed).toBe(true);
    // Stub run() was invoked once per leg.
    expect(calls.run.filter((c) => /^echo /.test(c.cmd))).toHaveLength(3);
  });

  it("captures tail output for failures", () => {
    const longErr = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const { deps } = makeDeps({
      runReplies: [[/echo lint/, { status: 1, stderr: longErr }]],
    });
    const [lint] = runMatrix(deps, baseConfig().matrix);
    expect(lint.tail.split("\n").length).toBeLessThanOrEqual(10);
    expect(lint.tail).toContain("line29");
  });

  it("forwards cwd and env per leg", () => {
    const cfg = validateConfig({
      matrix: [{ name: "scoped", mode: "hard", command: "echo x", cwd: "api", env: { K: "v" } }],
    });
    const { deps, calls } = makeDeps();
    runMatrix(deps, cfg.matrix);
    expect(calls.run[0].opts).toMatchObject({ cwd: "api", env: { K: "v" } });
  });
});

// ---------------------------------------------------------------------------
// upsertComment / applyLabel / appendAuditLog
// ---------------------------------------------------------------------------

describe("upsertComment", () => {
  it("POSTs when no existing attestation comment", () => {
    const { deps, calls } = makeDeps({
      runReplies: [[/gh api repos.*\/comments/, { stdout: "[]" }]],
    });
    const r = upsertComment(deps, { repo: "kaio/repo", pr: 1, body: "hi" });
    expect(r.kind).toBe("post");
    expect(calls.gh).toHaveLength(1);
    expect(calls.gh[0].cmd).toMatch(/--method POST/);
    expect(calls.gh[0].payload).toEqual({ body: "hi" });
  });

  it("PATCHes the existing attestation comment in place", () => {
    const existing = [
      { id: 999, author_association: "OWNER", body: `<!-- local-attest verified-sha=abc1234 -->` },
    ];
    const { deps, calls } = makeDeps({
      runReplies: [[/gh api repos.*\/comments/, { stdout: JSON.stringify(existing) }]],
    });
    const r = upsertComment(deps, { repo: "kaio/repo", pr: 1, body: "new" });
    expect(r.kind).toBe("patch");
    expect(r.commentId).toBe(999);
    expect(calls.gh[0].cmd).toMatch(/--method PATCH .*comments\/999/);
  });

  it("always sends body via stdin (--input -), never shell-interpolated", () => {
    const { deps, calls } = makeDeps({
      runReplies: [[/gh api repos.*\/comments/, { stdout: "[]" }]],
    });
    upsertComment(deps, { repo: "kaio/repo", pr: 1, body: "line1\nline2 `backticks` $vars" });
    expect(calls.gh[0].cmd).toContain("--input -");
    expect(calls.gh[0].cmd).not.toContain("line1");
  });
});

describe("applyLabel", () => {
  it("creates the label (ignores already-exists) then attaches it", () => {
    const { deps, calls } = makeDeps();
    applyLabel(deps, { repo: "kaio/repo", pr: 1, label: "ci/local-verified" });
    const cmds = calls.run.map((c) => c.cmd);
    expect(cmds.some((c) => /gh label create ci\/local-verified/.test(c))).toBe(true);
    expect(cmds.some((c) => /gh pr edit 1 --add-label ci\/local-verified/.test(c))).toBe(true);
  });

  it("warns but does not throw when label attach fails", () => {
    const { deps, calls } = makeDeps({
      runReplies: [[/gh pr edit/, { status: 1, stderr: "no perms" }]],
    });
    expect(() => applyLabel(deps, { repo: "kaio/repo", pr: 1, label: "x" })).not.toThrow();
    expect(calls.warn.some((w) => /could not apply/.test(w))).toBe(true);
  });
});

describe("appendAuditLog", () => {
  it("writes one JSONL line with the documented shape", () => {
    const { deps, calls } = makeDeps();
    appendAuditLog(deps, {
      auditLogPath: "/tmp/x.jsonl",
      pr: "7",
      sha: "abc1234",
      advisoryFails: ["knip"],
      hostname: "h",
    });
    expect(calls.appendLog).toHaveLength(1);
    const { path, line } = calls.appendLog[0];
    expect(path).toBe("/tmp/x.jsonl");
    const obj = JSON.parse(line);
    expect(obj).toMatchObject({ pr: 7, sha: "abc1234", host: "h", advisoryFails: ["knip"] });
    expect(typeof obj.ts).toBe("string");
  });

  it("swallows fs errors (best-effort)", () => {
    const { deps } = makeDeps();
    deps.appendLog = () => {
      throw new Error("disk full");
    };
    expect(() =>
      appendAuditLog(deps, {
        auditLogPath: "/tmp/x.jsonl",
        pr: 1,
        sha: "abc1234",
        advisoryFails: [],
        hostname: "h",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// execute (orchestration)
// ---------------------------------------------------------------------------

describe("execute (orchestration)", () => {
  const happy = [
    [/git rev-parse --abbrev-ref HEAD/, { stdout: "feature\n" }],
    [/git status --porcelain/, { stdout: "" }],
    [/gh auth status/, { status: 0 }],
    [/gh repo view --json nameWithOwner/, { stdout: "k/r\n" }],
    [/gh pr view --json number/, { stdout: "42\n" }],
    [/git rev-parse HEAD/, { stdout: "abc1234abc1234abc1234abc1234abc1234abc12\n" }],
    [/gh pr view 42 --json headRefOid/, { stdout: "abc1234abc1234abc1234abc1234abc1234abc12\n" }],
    [/gh api user --jq \.login/, { stdout: "k\n" }],
    [/gh api repos\/.*\/collaborators\/.*\/permission/, { stdout: "ADMIN\n" }],
  ];

  it("dry-run prints the body but never calls gh comments / label / push", () => {
    const cfg = baseConfig();
    const { deps, calls } = makeDeps({ runReplies: happy });
    const r = execute(deps, cfg, { prOverride: null, push: true, dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(calls.gh).toHaveLength(0);
    expect(calls.appendLog).toHaveLength(0);
    expect(calls.run.some((c) => /git push/.test(c.cmd))).toBe(false);
    expect(calls.run.some((c) => /gh label create/.test(c.cmd))).toBe(false);
    expect(r.body.split("\n")[0]).toMatch(/^<!-- local-attest verified-sha=[0-9a-f]{7,40} -->$/);
  });

  it("exits 1 when a hard leg fails and posts nothing", () => {
    const cfg = baseConfig();
    const replies = [
      ...happy,
      [/echo test/, { status: 1, stderr: "boom" }],
    ];
    const { deps, calls } = makeDeps({ runReplies: replies });
    const r = execute(deps, cfg, { prOverride: null, push: true, dryRun: false });
    expect(r.exitCode).toBe(1);
    expect(r.ok).toBe(false);
    expect(calls.gh).toHaveLength(0);
    expect(calls.appendLog).toHaveLength(0);
  });

  it("posts + labels + audits on full pass (no dry-run)", () => {
    const cfg = baseConfig();
    const replies = [
      ...happy,
      [/gh api repos.*\/comments/, { stdout: "[]" }],
    ];
    const { deps, calls } = makeDeps({ runReplies: replies });
    const r = execute(deps, cfg, { prOverride: null, push: false, dryRun: false });
    expect(r.exitCode).toBe(0);
    // 1 gh comment upsert
    expect(calls.gh).toHaveLength(1);
    // 1 audit log line
    expect(calls.appendLog).toHaveLength(1);
    // label create + label attach
    expect(calls.run.some((c) => /gh label create/.test(c.cmd))).toBe(true);
    expect(calls.run.some((c) => /gh pr edit 42 --add-label/.test(c.cmd))).toBe(true);
  });
});
