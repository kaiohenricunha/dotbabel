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
  filterMatrix,
  findAttestComment,
  legStatus,
  renderComment,
  shouldAttest,
  summarizeResults,
  tail,
  toolchainProblems,
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
 * Collect toolchain problems for the config's pins, gathering versions through
 * `deps.run` so tests can stub them. Config paths are repo-owned (the same
 * trust level as the leg commands the matrix executes verbatim).
 *
 * @param {Deps} deps
 * @param {Config} cfg
 * @returns {string[]}
 */
function gatherToolchain(deps, cfg) {
  const pin = cfg.toolchain;
  if (!pin) return [];
  /** @type {Parameters<typeof toolchainProblems>[0]} */
  const inputs = { pin };
  if (pin.node !== undefined) {
    const r = deps.run("node --version", { capture: true });
    inputs.nodeVersion = r.status === 0 ? r.stdout.trim().replace(/^v/, "") : "";
  }
  if (pin.goMod !== undefined) {
    const rv = deps.run("go version", { capture: true });
    inputs.goVersionOutput = rv.status === 0 ? rv.stdout : "";
    const rf = deps.run(`cat "${pin.goMod}"`, { capture: true });
    inputs.goModText = rf.status === 0 ? rf.stdout : "";
  }
  return toolchainProblems(inputs);
}

/**
 * The slim precondition set for a diagnostic (`--only`/`--from`) run. A dirty
 * tree, a missing PR, and a diverged HEAD are all fine — iterating on a fix is
 * the entire point, and a diagnostic run is structurally unable to attest
 * (see shouldAttest). Docker and toolchain problems warn instead of failing:
 * the selected legs will say so loudly if they actually needed them.
 *
 * @param {Deps} deps
 * @param {Config} cfg
 */
export function checkDiagnosticPreconditions(deps, cfg) {
  try {
    capture(deps, "git rev-parse --git-dir");
  } catch {
    throw new PreconditionError("not inside a git repository.");
  }
  if (cfg.requireDocker && deps.run("docker info", { capture: true }).status !== 0) {
    deps.warn(
      "WARNING: Docker is not available — legs that need it will fail. " +
        "(config.requireDocker is true; diagnostic runs continue anyway.)",
    );
  }
  for (const p of gatherToolchain(deps, cfg)) {
    deps.warn(`WARNING: ${p} (diagnostic run — continuing; an attest run stops here)`);
  }
}

/**
 * Re-assert, after the matrix has run, that the tree still holds exactly what
 * was tested. Preconditions are checked once up front, but the matrix takes
 * minutes — long enough for another agent session, another worktree, or the
 * user in a second terminal to commit onto the same branch.
 *
 * Without this, `execute` would attest the pre-matrix SHA and then
 * `git push` whatever HEAD had become: publishing commits that were never
 * tested, and labelling the PR `ci/local-verified` on a head nobody verified.
 * Observed in practice — a matrix attested one SHA and pushed a different one
 * that had landed during its 441-second test leg.
 *
 * @param {Deps} deps
 * @param {Preconditions} pre
 * @returns {void}
 * @throws {PreconditionError} when HEAD moved or the tree became dirty
 */
export function verifyHeadUnchanged(deps, pre) {
  const headNow = capture(deps, "git rev-parse HEAD");
  if (headNow !== pre.headSha) {
    throw new PreconditionError(
      `HEAD moved while the matrix was running: tested ${pre.headSha.slice(0, 8)}, ` +
        `now ${headNow.slice(0, 8)}.\n` +
        "Nothing was posted, pushed, or labelled — the results describe a commit that is no " +
        "longer checked out. Another writer touched this branch; re-run to attest the new head.",
    );
  }

  const dirty = capture(deps, "git status --porcelain");
  if (dirty !== "") {
    throw new PreconditionError(
      "The working tree became dirty while the matrix was running:\n" +
        `${dirty}\n` +
        "Nothing was posted, pushed, or labelled — the matrix tested a tree that does not " +
        "match the commit it would attest. Clean the tree and re-run.",
    );
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

  // Toolchain pins are fail-closed on an attest run: the attestation claims
  // "CI would pass", and a matrix run on a different Node or Go than CI uses
  // certifies a run CI would never perform. Diagnostic runs warn instead
  // (checkDiagnosticPreconditions) — iterating on the wrong toolchain is the
  // operator's business until they try to attest with it.
  const toolchainIssues = gatherToolchain(deps, cfg);
  if (toolchainIssues.length > 0) {
    throw new PreconditionError(
      "toolchain mismatch — the attestation must certify the toolchain CI runs on:\n  " +
        toolchainIssues.join("\n  "),
    );
  }

  // Trust list mismatch is a warning, not a failure: a non-trusted user can
  // still iterate; their attestation just won't skip CI. The skill prints
  // the warning once at the start of the run so it's loud.
  try {
    const me = capture(deps, "gh api user --jq .login");
    const ownerAssoc = capture(
      deps,
      `gh api repos/${repo}/collaborators/${me}/permission --jq .permission`,
    ).toUpperCase();
    const PERM_TO_ASSOC = {
      ADMIN: "OWNER",
      WRITE: "MEMBER",
      READ: "COLLABORATOR",
      MAINTAIN: "MEMBER",
      TRIAGE: "COLLABORATOR",
    };
    const mapped = PERM_TO_ASSOC[ownerAssoc] ?? ownerAssoc;
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
 * With `failFast`, a hard failure stops launching further legs; the remainder
 * are recorded as `{ notRun: true, passed: false }` — fail-closed for any
 * consumer that forgets to check `notRun`, and never mistakable for a pass.
 * Advisory failures never trip the abort: they cannot block an attestation,
 * so stopping the run on one would only cost information.
 *
 * @param {Deps} deps
 * @param {Leg[]} matrix
 * @param {{ failFast?: boolean }} [opts]
 * @returns {LegResult[]}
 */
export function runMatrix(deps, matrix, { failFast = false } = {}) {
  /** @type {LegResult[]} */
  const results = [];
  let aborted = false;
  for (const leg of matrix) {
    if (aborted) {
      results.push({
        name: leg.name,
        mode: leg.mode,
        passed: false,
        notRun: true,
        durationS: 0,
        tail: "",
      });
      deps.log(`--- ${leg.name}: NOT RUN (fail-fast)`);
      continue;
    }
    deps.log(`\n=== ${leg.name} (${leg.mode}) ===`);
    const started = Date.now();
    const r = deps.run(leg.command, { cwd: leg.cwd, env: leg.env });
    const durationS = Math.round((Date.now() - started) / 1000);
    const passed = r.status === 0;
    const output = tail(`${r.stdout || ""}\n${r.stderr || ""}`);
    results.push({ name: leg.name, mode: leg.mode, passed, durationS, tail: output });
    deps.log(`--- ${leg.name}: ${passed ? "PASS" : "FAIL"} (${durationS}s)`);
    if (!passed) deps.log(output);
    if (failFast && !passed && leg.mode === "hard") {
      aborted = true;
      deps.log(`fail-fast: ${leg.name} failed — remaining legs will not run.`);
    }
  }
  return results;
}

/**
 * Insert or update the attestation comment. Always sends the body via stdin
 * (`gh api --input -`) so multiline markdown can't be mangled by shell quoting.
 * Only PATCHes a comment whose original author is in `trustedAssociations` so
 * the CI gate (which filters by author_association) sees the correct author.
 *
 * @param {Deps} deps
 * @param {{ repo: string, pr: string|number, body: string, trustedAssociations?: string[] }} args
 * @returns {{ kind: "post"|"patch", commentId?: number|string }}
 */
export function upsertComment(deps, { repo, pr, body, trustedAssociations }) {
  const raw = capture(deps, `gh api repos/${repo}/issues/${pr}/comments --paginate`);
  /** @type {Comment[]} */
  const comments = JSON.parse(raw || "[]");
  const trusted = trustedAssociations ? new Set(trustedAssociations) : null;
  const candidates = trusted
    ? comments.filter((c) => c && trusted.has(c.author_association))
    : comments;
  const existing = findAttestComment(candidates);
  if (existing) {
    const id = Number(existing.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`unexpected comment id: ${existing.id}`);
    }
    deps.ghApiWithInput(`gh api --method PATCH repos/${repo}/issues/comments/${id} --input -`, {
      body,
    });
    deps.log(`Updated existing attestation comment ${id}.`);
    return { kind: "patch", commentId: id };
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
 * Append one JSONL line to the audit log. Best-effort: an unwritable log must
 * never flip a green attest into a crash, nor mask the real exit code on a
 * failure path — but it warns, because once the log is the failure record,
 * silence is a bug.
 *
 * Everything besides `auditLogPath` flows through to `buildAuditEntry`.
 *
 * @param {Deps} deps
 * @param {{ auditLogPath: string } & Parameters<typeof buildAuditEntry>[0]} args
 */
export function appendAuditLog(deps, { auditLogPath, ...entryInput }) {
  try {
    const entry = buildAuditEntry(entryInput);
    deps.appendLog(auditLogPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    deps.warn(`WARNING: audit log append failed (non-fatal): ${err.message || err}`);
  }
}

const SUMMARY_LABELS = {
  pass: "PASS",
  fail: "FAIL",
  "advisory-fail": "fail (advisory)",
  "not-run": "NOT RUN (fail-fast)",
};

/**
 * @param {Deps} deps
 * @param {LegResult[]} results
 */
function printSummary(deps, results) {
  deps.log("\n========== Summary ==========");
  for (const r of results) {
    deps.log(`  ${r.name.padEnd(28)} ${SUMMARY_LABELS[legStatus(r)]} (${r.durationS}s)`);
  }
}

/**
 * End-to-end orchestration. Two mutually exclusive shapes:
 *
 * Attest run (default): preconditions → matrix → head recheck → comment →
 * push (optional) → label → audit. Posting is structurally gated on
 * `shouldAttest` — a partial or failed run cannot reach it.
 *
 * Diagnostic run (`only`/`from` set): slim preconditions (dirty tree fine,
 * no PR needed) → filtered matrix → audit. Never posts, labels, or pushes;
 * exits 1 on ANY selected-leg failure, advisory included, because there is
 * no gate to grade against and `--only knip` exiting 0 on a knip failure
 * would be useless in a shell loop.
 *
 * Audit invariant: every run whose matrix settles writes exactly one JSONL
 * line, tagged `result: attested | hard-fail | head-moved | push-fail |
 * post-fail | dry-run | diagnostic`. Precondition failures write nothing —
 * no matrix ran, and there may not even be a resolved PR or SHA to key on.
 *
 * @param {Deps} deps
 * @param {Config} cfg
 * @param {{ prOverride?: string|null, push: boolean, dryRun: boolean,
 *           only?: string[], from?: string|null, failFast?: boolean }} flags
 * @returns {{ ok: boolean, body: string, results: LegResult[], pre: Preconditions|null, exitCode: number }}
 */
export function execute(deps, cfg, flags) {
  const only = flags.only ?? [];
  const from = flags.from ?? null;
  const failFast = flags.failFast === true;
  const diagnostic = only.length > 0 || from !== null;
  const auditFlags = { only, from, failFast, push: flags.push };

  if (diagnostic) {
    const matrix = filterMatrix(cfg.matrix, { only, from });
    checkDiagnosticPreconditions(deps, cfg);
    let dirty = true;
    let headSha = null;
    try {
      dirty = capture(deps, "git status --porcelain") !== "";
      headSha = capture(deps, "git rev-parse HEAD");
    } catch {
      // Best-effort context for the audit line only.
    }
    deps.log(
      `Diagnostic run: ${matrix.length} of ${cfg.matrix.length} leg(s) — attestation disabled.`,
    );

    const results = runMatrix(deps, matrix, { failFast });
    printSummary(deps, results);
    const { advisoryFails } = summarizeResults(results);
    appendAuditLog(deps, {
      auditLogPath: cfg.auditLogPath,
      result: "diagnostic",
      pr: flags.prOverride ?? null,
      sha: headSha,
      hostname: deps.hostname(),
      advisoryFails: advisoryFails.map((r) => r.name),
      results,
      flags: auditFlags,
      dirty,
    });

    const failed = results.filter((r) => !r.notRun && !r.passed);
    if (failed.length > 0) {
      deps.warn(`\n${failed.length} leg(s) failed: ${failed.map((r) => r.name).join(", ")}.`);
      deps.warn("Diagnostic run — nothing was posted, labelled, or pushed.");
      return { ok: false, body: "", results, pre: null, exitCode: 1 };
    }
    deps.log(
      "\nAll selected legs passed. Diagnostic runs never attest — run a full attest before relying on the CI skip.",
    );
    return { ok: true, body: "", results, pre: null, exitCode: 0 };
  }

  const pre = checkPreconditions(deps, cfg, { prOverride: flags.prOverride });
  deps.log(`Attesting PR #${pre.pr} (${pre.repo}) at ${pre.headSha.slice(0, 8)}.`);

  const results = runMatrix(deps, cfg.matrix, { failFast });
  const { hardFails, advisoryFails } = summarizeResults(results);
  printSummary(deps, results);

  const audit = (result) =>
    appendAuditLog(deps, {
      auditLogPath: cfg.auditLogPath,
      result,
      pr: pre.pr,
      sha: pre.headSha,
      hostname: deps.hostname(),
      advisoryFails: advisoryFails.map((r) => r.name),
      results,
      flags: auditFlags,
    });

  const body = renderComment(results, {
    headSha: pre.headSha,
    hostname: deps.hostname(),
  });

  // The mechanical bar: posting is only reachable through this predicate.
  // hardFails covers the executed failures; shouldAttest additionally rejects
  // not-run legs and unsettled holes, so a fail-fast stop can never attest.
  if (!shouldAttest({ diagnostic: false, results })) {
    if (hardFails.length > 0) {
      deps.warn(
        `\n${hardFails.length} hard leg(s) failed: ${hardFails.map((r) => r.name).join(", ")}.`,
      );
    }
    const notRun = results.filter((r) => r.notRun);
    if (notRun.length > 0) {
      deps.warn(
        `${notRun.length} leg(s) did not run (fail-fast): ${notRun.map((r) => r.name).join(", ")}.`,
      );
    }
    deps.warn("No attestation posted, no label applied, nothing pushed.");
    audit("hard-fail");
    return { ok: false, body, results, pre, exitCode: 1 };
  }
  if (advisoryFails.length > 0) {
    deps.log(
      `\n${advisoryFails.length} advisory leg(s) failed (not blocking): ${advisoryFails.map((r) => r.name).join(", ")}.`,
    );
  }

  if (flags.dryRun) {
    deps.log(
      "\n--dry-run: would post the comment below; not posting, not labeling, not pushing.\n",
    );
    deps.log(body);
    audit("dry-run");
    return { ok: true, body, results, pre, exitCode: 0 };
  }

  // The marker SHA is the HEAD captured before the matrix ran, but `git push`
  // publishes whatever HEAD is NOW. Those are only the same commit if nothing
  // touched the branch in between — re-assert that before any side effect, or
  // we publish untested work and vouch for it.
  try {
    verifyHeadUnchanged(deps, pre);
  } catch (err) {
    audit("head-moved");
    throw err;
  }

  // Post the attestation comment BEFORE pushing so it is visible when the
  // push event fires GitHub Actions.
  try {
    upsertComment(deps, {
      repo: pre.repo,
      pr: pre.pr,
      body,
      trustedAssociations: cfg.trustedAssociations,
    });
  } catch (err) {
    // A gh outage after a long green matrix must still leave a record.
    audit("post-fail");
    throw err;
  }

  if (flags.push && cfg.pushAfterAttest) {
    deps.log("\nPushing...");
    const pushResult = deps.run("git push");
    if (pushResult.status !== 0) {
      deps.warn(
        "git push failed. The attestation comment was already posted but the branch was not pushed.\n" +
          "Fix the push issue and retry — `git push` alone is enough; the comment is already in place.",
      );
      audit("push-fail");
      return { ok: false, body, results, pre, exitCode: 1 };
    }
    deps.log("Pushed.");
  }

  applyLabel(deps, { repo: pre.repo, pr: pre.pr, label: cfg.label });
  audit("attested");

  if (flags.push && cfg.pushAfterAttest) {
    deps.log("Remote CI jobs gated by the attestation comment will skip for this commit.");
  } else {
    deps.log("\nDid not push. Push manually to trigger the CI skip.");
  }

  return { ok: true, body, results, pre, exitCode: 0 };
}
