/**
 * local-attest-runner — orchestration with injectable I/O.
 *
 * Every external call (shell, gh, fs) is routed through a `deps` object so
 * the test suite can stub them without touching the real environment. The
 * runner is otherwise a thin shell that wires `local-attest-lib` helpers
 * together in the right order:
 *
 *   1. checkPreconditions — clean tree, branch, PR, head SHA, gh, docker
 *   2. runMatrix          — execute each leg sequentially, capture tails
 *   3. push (optional)    — only after hard legs pass; before posting
 *   4. upsertComment      — PATCH existing attestation comment or POST a new one
 *   5. applyLabel         — best-effort decoration
 *   6. appendAuditLog     — best-effort jsonl line
 *
 * NEVER interpolate untrusted strings (PR titles, branch names, commit bodies)
 * into a shell command. JSON payloads go through `--input -` (stdin) so shell
 * quoting can never break a multiline markdown body.
 *
 * @typedef {object} Deps
 * @property {(cmd: string, opts?: { cwd?: string, env?: Record<string,string>, capture?: boolean }) => { status: number, stdout: string, stderr: string }} run
 * @property {(cmd: string, payload: object) => string} ghApiWithInput
 * @property {(path: string, line: string) => void} appendLog
 * @property {() => string} hostname
 * @property {(msg: string) => void} log
 * @property {(msg: string) => void} warn
 *
 * @typedef {import("./local-attest-config.mjs").Config} Config
 * @typedef {import("./local-attest-config.mjs").Leg} Leg
 * @typedef {import("./local-attest-lib.mjs").LegResult} LegResult
 * @typedef {import("./local-attest-lib.mjs").Comment} Comment
 *
 * @typedef {object} Preconditions
 * @property {string} branch
 * @property {string} repo
 * @property {string} pr
 * @property {string} headSha
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import os from "node:os";

import {
  buildAuditEntry,
  findAttestComment,
  renderComment,
  summarizeResults,
  tail,
} from "./local-attest-lib.mjs";

/**
 * Build a `Deps` bundle wired to the real environment. Tests construct their
 * own with in-memory recorders instead.
 *
 * @returns {Deps}
 */
export function realDeps() {
  return {
    run(cmd, { cwd, env, capture = false } = {}) {
      const r = spawnSync(cmd, {
        shell: true,
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: capture ? "pipe" : ["inherit", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    ghApiWithInput(cmd, payload) {
      const r = spawnSync(cmd, {
        shell: true,
        input: JSON.stringify(payload),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (r.status !== 0) {
        throw new Error(`command failed (${r.status}): ${cmd}\n${r.stderr || ""}`);
      }
      return r.stdout;
    },
    appendLog(path, line) {
      appendFileSync(path, line);
    },
    hostname() {
      return os.hostname();
    },
    log(msg) {
      process.stdout.write(msg + "\n");
    },
    warn(msg) {
      process.stderr.write(msg + "\n");
    },
  };
}

/**
 * Run a captured shell command; throws on non-zero with stderr in the message.
 *
 * @param {Deps} deps
 * @param {string} cmd
 * @returns {string}
 */
function capture(deps, cmd) {
  const r = deps.run(cmd, { capture: true });
  if (r.status !== 0) {
    throw new Error(`command failed (${r.status}): ${cmd}\n${r.stderr || ""}`);
  }
  return (r.stdout || "").trim();
}

/**
 * Thrown by {@link checkPreconditions} when the worktree, gh auth, PR
 * resolution, head-SHA match, or Docker check fails. The CLI maps this to
 * exit code 1 ("attestation failure") so callers can distinguish it from
 * environment errors (exit 2).
 */
export class PreconditionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "PreconditionError";
    this.code = "LOCAL_ATTEST_PRECONDITION";
  }
}

/**
 * @param {Deps} deps
 * @param {Config} cfg
 * @param {{ prOverride?: string|null }} [opts]
 * @returns {Preconditions}
 */
export function checkPreconditions(deps, cfg, opts = {}) {
  let branch;
  try {
    branch = capture(deps, "git rev-parse --abbrev-ref HEAD");
  } catch {
    throw new PreconditionError("not inside a git repository.");
  }
  if (branch === "HEAD") {
    throw new PreconditionError("detached HEAD — check out the PR branch before attesting.");
  }

  if (cfg.requireClean) {
    const dirty = capture(deps, "git status --porcelain");
    if (dirty !== "") {
      throw new PreconditionError(
        "worktree is not clean — commit or stash your changes before attesting.\n" +
          "The attestation must certify the exact tree that gets pushed.\n\n" +
          dirty,
      );
    }
  }

  if (deps.run("gh auth status", { capture: true }).status !== 0) {
    throw new PreconditionError("gh is not authenticated — run `gh auth login`.");
  }

  const repo = capture(deps, "gh repo view --json nameWithOwner --jq .nameWithOwner");

  let pr = opts.prOverride ?? null;
  if (!pr) {
    try {
      pr = capture(deps, "gh pr view --json number --jq .number");
      if (!pr) throw new Error("no PR number");
    } catch {
      throw new PreconditionError(`no open PR for branch ${branch} — pass --pr <N> explicitly.`);
    }
  }

  const headSha = capture(deps, "git rev-parse HEAD");
  const prHeadSha = capture(deps, `gh pr view ${pr} --json headRefOid --jq .headRefOid`);
  if (headSha !== prHeadSha) {
    throw new PreconditionError(
      `local HEAD (${headSha.slice(0, 8)}) differs from PR #${pr} head (${prHeadSha.slice(0, 8)}).\n` +
        "Push or pull so they match before attesting.",
    );
  }

  if (cfg.requireDocker && deps.run("docker info", { capture: true }).status !== 0) {
    throw new PreconditionError(
      "Docker is not available — config.requireDocker is true. Start Docker and retry.",
    );
  }

  // Trust list mismatch is a warning, not a failure: a non-trusted user can
  // still iterate; their attestation just won't skip CI. The skill prints
  // the warning once at the start of the run so it's loud.
  try {
    const me = capture(deps, "gh api user --jq .login");
    const ownerAssoc = capture(deps, `gh api repos/${repo}/collaborators/${me}/permission --jq .permission`).toUpperCase();
    const mapped =
      ownerAssoc === "ADMIN" ? "OWNER" :
      ownerAssoc === "WRITE" ? "MEMBER" :
      ownerAssoc === "READ" ? "COLLABORATOR" :
      ownerAssoc;
    if (!cfg.trustedAssociations.includes(mapped)) {
      deps.warn(
        `WARNING: you (${me}) have permission ${ownerAssoc} on ${repo}, which is not in the configured trust list (${cfg.trustedAssociations.join(", ")}). The CI gate will not honor this attestation.`,
      );
    }
  } catch {
    // Permission probe is a courtesy — never block on it.
  }

  return { branch, repo, pr, headSha };
}

/**
 * Execute the matrix sequentially. Each leg runs to completion; output is
 * tailed at 10 lines so large logs don't bloat the result struct.
 *
 * @param {Deps} deps
 * @param {Leg[]} matrix
 * @returns {LegResult[]}
 */
export function runMatrix(deps, matrix) {
  /** @type {LegResult[]} */
  const results = [];
  for (const leg of matrix) {
    deps.log(`\n=== ${leg.name} (${leg.mode}) ===`);
    const started = Date.now();
    const r = deps.run(leg.command, { cwd: leg.cwd, env: leg.env });
    const durationS = Math.round((Date.now() - started) / 1000);
    const passed = r.status === 0;
    const output = tail(`${r.stdout || ""}\n${r.stderr || ""}`);
    results.push({ name: leg.name, mode: leg.mode, passed, durationS, tail: output });
    deps.log(`--- ${leg.name}: ${passed ? "PASS" : "FAIL"} (${durationS}s)`);
    if (!passed) deps.log(output);
  }
  return results;
}

/**
 * Insert or update the attestation comment. Always sends the body via stdin
 * (`gh api --input -`) so multiline markdown can't be mangled by shell quoting.
 *
 * @param {Deps} deps
 * @param {{ repo: string, pr: string|number, body: string }} args
 * @returns {{ kind: "post"|"patch", commentId?: number|string }}
 */
export function upsertComment(deps, { repo, pr, body }) {
  const raw = capture(deps, `gh api repos/${repo}/issues/${pr}/comments --paginate`);
  /** @type {Comment[]} */
  const comments = JSON.parse(raw || "[]");
  const existing = findAttestComment(comments);
  if (existing) {
    deps.ghApiWithInput(
      `gh api --method PATCH repos/${repo}/issues/comments/${existing.id} --input -`,
      { body },
    );
    deps.log(`Updated existing attestation comment ${existing.id}.`);
    return { kind: "patch", commentId: existing.id };
  }
  deps.ghApiWithInput(`gh api --method POST repos/${repo}/issues/${pr}/comments --input -`, {
    body,
  });
  deps.log("Posted new attestation comment.");
  return { kind: "post" };
}

/**
 * Create the label if it does not exist, then attach it to the PR. Both
 * sub-steps are best-effort: label-already-exists is ignored, and attach
 * failure warns but does not abort.
 *
 * @param {Deps} deps
 * @param {{ repo: string, pr: string|number, label: string }} args
 */
export function applyLabel(deps, { repo, pr, label }) {
  deps.run(
    `gh label create ${label} --repo ${repo} --color BFD4F2 ` +
      `--description "Local CI attestation posted; remote CI jobs may skip"`,
    { capture: true },
  );
  const r = deps.run(`gh pr edit ${pr} --add-label ${label}`, { capture: true });
  if (r.status !== 0) {
    deps.warn(`WARNING: could not apply ${label} label (non-fatal): ${r.stderr || ""}`);
  } else {
    deps.log(`Applied ${label} label.`);
  }
}

/**
 * Append one JSONL line to the audit log. Failures are swallowed.
 *
 * @param {Deps} deps
 * @param {{ auditLogPath: string, pr: string|number, sha: string, advisoryFails: string[], hostname: string }} args
 */
export function appendAuditLog(deps, { auditLogPath, pr, sha, advisoryFails, hostname }) {
  try {
    const entry = buildAuditEntry({ pr, sha, hostname, advisoryFails });
    deps.appendLog(auditLogPath, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort audit log; never block the run.
  }
}

/**
 * End-to-end orchestration: preconditions → matrix → push (optional) →
 * comment → label → audit. Returns the rendered comment body so the CLI
 * can print it in --dry-run mode.
 *
 * @param {Deps} deps
 * @param {Config} cfg
 * @param {{ prOverride?: string|null, push: boolean, dryRun: boolean }} flags
 * @returns {{ ok: boolean, body: string, results: LegResult[], pre: Preconditions, exitCode: number }}
 */
export function execute(deps, cfg, flags) {
  const pre = checkPreconditions(deps, cfg, { prOverride: flags.prOverride });
  deps.log(`Attesting PR #${pre.pr} (${pre.repo}) at ${pre.headSha.slice(0, 8)}.`);

  const results = runMatrix(deps, cfg.matrix);
  const { hardFails, advisoryFails } = summarizeResults(results);

  deps.log("\n========== Summary ==========");
  for (const r of results) {
    const m = r.passed ? "PASS" : r.mode === "advisory" ? "fail (advisory)" : "FAIL";
    deps.log(`  ${r.name.padEnd(28)} ${m} (${r.durationS}s)`);
  }

  const body = renderComment(results, {
    headSha: pre.headSha,
    hostname: deps.hostname(),
  });

  if (hardFails.length > 0) {
    deps.warn(
      `\n${hardFails.length} hard leg(s) failed: ${hardFails.map((r) => r.name).join(", ")}.`,
    );
    deps.warn("No attestation posted, no label applied, nothing pushed.");
    return { ok: false, body, results, pre, exitCode: 1 };
  }
  if (advisoryFails.length > 0) {
    deps.log(
      `\n${advisoryFails.length} advisory leg(s) failed (not blocking): ${advisoryFails.map((r) => r.name).join(", ")}.`,
    );
  }

  if (flags.dryRun) {
    deps.log("\n--dry-run: would post the comment below; not posting, not labeling, not pushing.\n");
    deps.log(body);
    return { ok: true, body, results, pre, exitCode: 0 };
  }

  if (flags.push && cfg.pushAfterAttest) {
    deps.log("\nPushing...");
    const pushResult = deps.run("git push");
    if (pushResult.status !== 0) {
      deps.warn("git push failed — no attestation posted. Fix the push and retry.");
      return { ok: false, body, results, pre, exitCode: 1 };
    }
    deps.log("Pushed.");
  }

  upsertComment(deps, { repo: pre.repo, pr: pre.pr, body });
  applyLabel(deps, { repo: pre.repo, pr: pre.pr, label: cfg.label });
  appendAuditLog(deps, {
    auditLogPath: cfg.auditLogPath,
    pr: pre.pr,
    sha: pre.headSha,
    advisoryFails: advisoryFails.map((r) => r.name),
    hostname: deps.hostname(),
  });

  if (flags.push && cfg.pushAfterAttest) {
    deps.log("Remote CI jobs gated by the attestation comment will skip for this commit.");
  } else {
    deps.log("\nDid not push. Push manually to trigger the CI skip.");
  }

  return { ok: true, body, results, pre, exitCode: 0 };
}
