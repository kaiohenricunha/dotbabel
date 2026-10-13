#!/usr/bin/env node
/**
 * dotbabel-pr-stack — stacked-PR reasoning for the `pr-conductor` skill.
 *
 * Nothing on GitHub models PR-to-PR dependency: every rebase path assumes the
 * base is the trunk. This binary reads the real PR list, builds the dependency
 * graph, and answers three questions the conductor needs — what can land now,
 * what is blocked, and what a child must do once its parent has merged.
 *
 * ALL `gh`/`git` shell-outs live here. `src/pr-stack.mjs` and `src/pr-gates.mjs`
 * are pure and return decisions only; that split is what keeps them testable.
 *
 * Usage:
 *   dotbabel pr-stack graph  [--trunk <ref>] [--limit <N>] [--json]
 *   dotbabel pr-stack plan   [--trunk <ref>] [--limit <N>] [--json]
 *   dotbabel pr-stack next   --pr <N> --parent <N> [--parent-sha <sha>] [--remote <name>]
 *   dotbabel pr-stack gate   --gate local-attest|merge --pr <N>
 *   dotbabel pr-stack gate   --gate skip-ci [--sha <rev>]
 *   dotbabel pr-stack gate   --gate budget --pr <N> --phase <id>
 *   dotbabel pr-stack phases
 *   dotbabel pr-stack entry   [--pr <N>]
 *   dotbabel pr-stack review-complete --pr <N> [--dry-run]
 *   dotbabel pr-stack record  --pr <N> --phase <id> --outcome <o> [--reason <CODE>]
 *                             [--evidence <url>]... [--sha <full sha>]
 *   dotbabel pr-stack receipt --pr <N>
 *   dotbabel pr-stack spot-check --pr <N> [--show | --record-explicit pass|fail] [--workflow <file>] [--trunk <ref>]
 *   dotbabel pr-stack main-status [--limit <N>] [--local [--allow-project-commands]] [--workflow <file>] [--trunk <ref>]
 *   dotbabel pr-stack contradiction --sha <full sha> --test-result <result> [--post] [--trunk <ref>]
 *   dotbabel pr-stack contradiction --pr <N> --local-failure [--post]
 *
 * `next` prints the commands to run; it never executes them. A rebase after a
 * squash-merge needs `--onto`, so the parent's pre-merge head SHA matters —
 * capture it BEFORE merging, since `--delete-branch` may remove the ref.
 *
 * Exits:
 *   0   ok (plan clean, gate passed)
 *   1   gate failed, the stack has a structural problem needing a human, a
 *       contradiction was found, or a `main-status --local` run failed
 *   2   environment error (gh missing/unauthenticated, not a git repo, data
 *       that could not be read, a `--local` run without project-command trust)
 *   64  bad CLI invocation (unknown flag/subcommand, malformed --pr)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedDirectly, misfiredAs } from "../src/lib/invoked-direct.mjs";

import { parse } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { buildStackGraph, planStack, planChildTransition } from "../src/pr-stack.mjs";
import {
  CONDUCTOR_PHASES,
  checkAttemptBudget,
  checkLocalAttestGate,
  checkMergeGate,
  deriveEntryPhase,
  hasSkipCi,
  resolveMaxAttempts,
  summarizeGates,
} from "../src/pr-gates.mjs";
import { GIT_MAX_BUFFER } from "../src/lib/limits.mjs";
import { criteriaGateInputs, prComments } from "../src/criteria/gate-inputs.mjs";
import { attestationGateInputs, baseConfigAtRev } from "../src/attestation-gate-inputs.mjs";
import {
  CONTRADICTION_LABEL,
  CONTRADICTION_RANGE_LIMIT,
  LOCKFILE_INSTALLS,
  RECENT_TRUNK_COMMITS,
  attestationMatch,
  bestRunStates,
  contradictionMarker,
  contradictionRange,
  decideSpotCheck,
  failingCommitMarker,
  installCommandsFor,
  isSpotCheckOff,
  mainVerificationStatus,
  renderContradictionIssue,
  renderLocalContradictionIssue,
  resolveSpotCheckPolicy,
  spotCheckRoll,
} from "../src/merge-verification.mjs";
import {
  InputError,
  ciAvailability,
  classifyWorkflowRun,
  defaultBranch,
  firstParentHistory,
  ghApiJson,
  labelContradicted,
  mergedPullFor,
  openContradictionIssue,
  prChangedPaths,
  readPrHead,
  trunkCommits,
  trustListAt,
  workflowRunsFor,
} from "../src/merge-verification-inputs.mjs";
import { isRepoTrusted } from "../src/trust-allowlist.mjs";
import { loadConfig as loadLocalAttestConfig } from "../src/local-attest-config.mjs";
import { reviewEntryFacts } from "../src/review-gate-inputs.mjs";
import { postReviewComplete } from "../src/review-complete.mjs";
import {
  RECEIPT_OUTCOMES,
  appendAttempt,
  createReceipt,
  frontmatterModel,
  receiptPath,
  receiptProblem,
  receiptVerdict,
  rollbackPoint,
  summarizePhases,
} from "../src/run-receipt.mjs";
import {
  appendSpotCheck,
  createSpotCheckStore,
  firstSelection,
  spotCheckStorePath,
  spotCheckStoreProblem,
  summarizeSpotChecks,
} from "../src/spot-check-store.mjs";

const TOOL = "dotbabel-pr-stack";

const PR_FIELDS = "number,headRefName,baseRefName,state,mergeStateStatus,headRefOid";

const SUBCOMMANDS = new Set([
  "graph",
  "plan",
  "next",
  "gate",
  "phases",
  "entry",
  "review-complete",
  "record",
  "receipt",
  "spot-check",
  "main-status",
  "contradiction",
]);

const FLAGS = {
  // No default here: most subcommands fall back to "main" (main()), while
  // spot-check, main-status and contradiction read the repository default branch.
  trunk: { type: "string" },
  // No default here: graph/plan fall back to 100 (fetchPrs), main-status to 20.
  limit: { type: "string" },
  pr: { type: "string" },
  parent: { type: "string" },
  "parent-sha": { type: "string" },
  remote: { type: "string", default: "origin" },
  gate: { type: "string" },
  sha: { type: "string" },
  "dry-run": { type: "boolean" },
  phase: { type: "string" },
  outcome: { type: "string" },
  reason: { type: "string" },
  evidence: { type: "string", multiple: true },
  workflow: { type: "string", default: "test.yml" },
  show: { type: "boolean" },
  "record-explicit": { type: "string" },
  local: { type: "boolean" },
  "test-result": { type: "string" },
  "local-failure": { type: "boolean" },
  post: { type: "boolean" },
  "allow-project-commands": { type: "boolean" },
};

const HELP = `${TOOL} <subcommand> [options]

Reason about stacked pull requests: dependency graph, merge order, and the
exact commands a child PR needs once its parent has merged.

Subcommands:
  graph              Print the raw dependency graph
  plan               Print what can land now, what is blocked, and any problems
  next               Print the commands to move a child PR after its parent merged
  gate               Evaluate a precondition gate (local-attest | merge | skip-ci | budget)
  phases             Print the canonical pipeline phase order
  entry              Print the phase the conductor should start at for this branch
  review-complete    Post the SHA-pinned marker that the review stage finished on the head
  record             Append one phase attempt to the pull request's run receipt
  receipt            Print the run receipt: verdict, per-phase attempts, rollback point
  spot-check         Decide whether /merge-pr verifies an attested PR explicitly anyway
  main-status        Show which default-branch commits a CI run verified, and the debt
  contradiction      Raise the alarm when a real test failure contradicts a passing attestation

Options:
  --trunk <ref>      Trunk branch name (default: main; spot-check, main-status
                     and contradiction: the repository default branch)
  --limit <N>        Max PRs to enumerate (default: 100); main-status: commits (default: 20)
  --pr <N>           PR number (required by: next, gate except --gate skip-ci,
                     review-complete, record, receipt, spot-check,
                     contradiction --local-failure; optional for entry)
  --parent <N>       Parent PR number (required by: next)
  --parent-sha <sha> Parent head SHA captured before merging (recommended for: next)
  --remote <name>    Git remote name (default: origin)
  --gate <name>      Gate to evaluate: local-attest | merge | skip-ci | budget
  --sha <rev>        Commit to inspect for --gate skip-ci (default: HEAD);
                     record: the full head SHA to use when gh cannot answer
                     (refused when it differs from the head gh reports);
                     contradiction: the default-branch commit whose run failed
  --dry-run          review-complete: check and print the comment, post nothing
  --phase <id>       record, --gate budget: the conductor phase (see \`phases\`)
  --outcome <o>      record: ${RECEIPT_OUTCOMES.join(" | ")}
  --reason <CODE>    record: the blocking reason code, UPPER_SNAKE
  --evidence <url>   record: a link to evidence the phase produced (repeatable)
  --workflow <file>  spot-check, main-status, contradiction: the test workflow
                     file on the default branch (default: test.yml)
  --show             spot-check: print the recorded decisions; decide nothing
  --record-explicit <pass|fail>
                     spot-check: record the result of the explicit run
  --local            main-status: also run the local-attest matrix on the
                     default-branch tip in a temporary worktree (weaker than CI);
                     needs project-command trust
  --allow-project-commands
                     main-status --local: run without the trust allowlist entry
  --test-result <r>  contradiction: the test job result (success | failure |
                     cancelled | skipped)
  --local-failure    contradiction: the explicit run of --pr failed locally
  --post             contradiction: label each suspect PR and open one issue
  --json             Emit a single JSON object on stdout
  --help, -h         Show this help
  --version, -V      Show version

Exit codes: 0 ok, 1 gate failed, structural problem, contradiction found, or a
failed main-status --local run, 2 env error, 64 usage error.`;

/**
 * Write a diagnostic to stderr and exit. Never writes to stdout so `--json`
 * consumers can pipe straight into `jq`.
 *
 * @param {number} code
 * @param {string} [msg]
 * @returns {void}
 */
function fail(code, msg) {
  if (msg) process.stderr.write(`${TOOL}: ${msg}\n`);
  process.exit(code);
}

/**
 * Run a shell command and capture its output.
 *
 * @param {string} cmd
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function sh(cmd) {
  const r = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Run a command from an ARGV ARRAY, with no shell.
 *
 * The criteria gather interpolates Spec IDs that come from the pull-request
 * body, so nothing it builds may ever reach a shell. `shell: false` is the
 * property that makes that safe; `sh` above stays for the fixed, internally
 * built command strings that have no attacker-reachable parts.
 *
 * @param {string[]} argv
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(argv) {
  const r = spawnSync(argv[0], argv.slice(1), {
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Like `run`, but returns stdout and throws on a non-zero exit. The shape
 * `criteria/comment.mjs` expects of its `capture` dependency.
 *
 * @param {string[]} argv
 * @returns {string}
 */
function capture(argv) {
  const r = run(argv);
  if (r.status !== 0) throw new Error(`command failed (${r.status}): ${argv.join(" ")}\n${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * POST or mutate through `gh api --input -`, so a multiline comment body is
 * never subject to shell quoting. Throws on a non-zero exit.
 *
 * @param {string[]} argv
 * @param {object} jsonBody
 * @returns {void}
 */
function ghApiWithInput(argv, jsonBody) {
  const r = spawnSync(argv[0], argv.slice(1), {
    shell: false,
    input: JSON.stringify(jsonBody),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (r.status !== 0) throw new Error(`command failed (${r.status ?? 1}): ${argv.join(" ")}\n${(r.stderr ?? "").trim()}`);
}

/**
 * Run a `gh` command expected to emit JSON. Exits 2 on any failure — an
 * unauthenticated or missing `gh` is an environment problem, not a verdict.
 *
 * @param {string} cmd
 * @returns {unknown}
 */
function ghJson(cmd) {
  const r = sh(cmd);
  if (r.status !== 0) {
    fail(EXIT_CODES.ENV, `command failed (${r.status}): ${cmd}\n${r.stderr.trim()}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    return fail(EXIT_CODES.ENV, `could not parse JSON from: ${cmd}`);
  }
}

/**
 * Guard a user-supplied git revision before it reaches a command string.
 *
 * @param {string} rev
 * @returns {string}
 */
function assertRev(rev) {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(rev)) {
    return fail(EXIT_CODES.USAGE, `--sha is not a valid revision: ${JSON.stringify(rev)}`);
  }
  return rev;
}

/**
 * Parse a `--pr`-style flag into a positive integer.
 *
 * @param {unknown} raw
 * @param {string} flag
 * @returns {number}
 */
function requireNumber(raw, flag) {
  if (raw === undefined) return fail(EXIT_CODES.USAGE, `${flag} is required`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fail(EXIT_CODES.USAGE, `${flag} must be a positive integer`);
  return n;
}

/**
 * Read `protected_paths` from docs/repo-facts.json, if the repo has one.
 *
 * @returns {string[]}
 */
function repoRoot() {
  const r = sh("git rev-parse --show-toplevel");
  if (r.status !== 0 || r.stdout.trim() === "") {
    return fail(EXIT_CODES.ENV, "not inside a git repository");
  }
  return r.stdout.trim();
}

/**
 * Read `protected_paths` from docs/repo-facts.json. Resolved against the repo
 * root, never the cwd: a relative probe silently returns [] when invoked from
 * a subdirectory, which would make the merge gate skip the Spec ID check and
 * report PASS on a PR that `merge-pr` will block — a fail-open gate.
 *
 * @param {string} root
 * @returns {string[]}
 */
function protectedPaths(root) {
  const factsPath = `${root}/docs/repo-facts.json`;
  if (!existsSync(factsPath)) return [];
  try {
    const facts = JSON.parse(readFileSync(factsPath, "utf8"));
    return Array.isArray(facts.protected_paths) ? facts.protected_paths : [];
  } catch {
    return fail(EXIT_CODES.ENV, `${factsPath} is unreadable`);
  }
}

/**
 * Every changed path on a pull request, or null when the list cannot be shown
 * to be complete.
 *
 * `gh pr view --json files` serves one 100-entry page with no error on
 * truncation. Criteria scope depends on this list, so a short read must not
 * look like a small pull request.
 *
 * @param {number} prNumber
 * @param {unknown} declaredCount `changedFiles` from the same `gh pr view`.
 * @returns {Array<{path: string}>|null}
 */
function paginatedPrFiles(prNumber, declaredCount) {
  const r = sh(
    `gh api repos/{owner}/{repo}/pulls/${prNumber}/files --paginate --jq '.[].filename'`,
  );
  if (r.status !== 0) return null;
  const paths = r.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const declared = Number(declaredCount);
  // GitHub's Files endpoint itself caps at 3000; at that size neither source
  // can be trusted to be complete.
  if (!Number.isFinite(declared) || declared !== paths.length || declared >= 3000) return null;
  return paths.map((path) => ({ path }));
}

/**
 * Gather every merge-gate input for a pull request and evaluate the gate.
 *
 * Shared by `gate --gate merge` and `review-complete`, which needs the criteria
 * half of the very same verdict rather than a second reading of it.
 *
 * @param {number} prNumber
 * @returns {ReturnType<typeof checkMergeGate>}
 */
function gatherMergeGate(prNumber) {
  const root = repoRoot();
  const view = ghJson(
    `gh pr view ${prNumber} --json body,mergeable,mergeStateStatus,files,changedFiles,headRefOid,baseRefOid`,
  );
  // `view.files` is a single unpaginated page that caps at 100 entries, the
  // same trap local-attest-runner.mjs documents and avoids. Criteria scope is
  // now derived from this list (REL-19), so a truncated one would silently
  // drop a governed file out of scope. Re-read it from the paginated Files
  // endpoint and cross-check the count; a mismatch means unreadable, and the
  // gate must fail closed rather than judge a partial diff.
  view.files = paginatedPrFiles(prNumber, view.changedFiles);
  // One fetch, both evidence families. `criteriaGateInputs` short-circuits
  // on several paths without ever fetching comments, so piggybacking the
  // attestation check on its result would report ATTESTATION_MISSING
  // whenever criteria happened not to apply.
  const comments = prComments({ run }, prNumber);
  return checkMergeGate({
    body: view.body,
    hasSpecsDir: existsSync(`${root}/docs/specs`),
    ...attestationGateInputs({ run }, view, comments),
    // A null list means "could not be proven complete"; the criteria half
    // turns that into CRITERIA_FILES_UNREADABLE, and an empty array here
    // keeps the protected-path check from silently passing on it.
    changedPaths: (view.files ?? []).map((f) => f.path),
    protectedPaths: protectedPaths(root),
    mergeable: view.mergeable,
    mergeStateStatus: view.mergeStateStatus,
    ...criteriaGateInputs({ run }, view, prNumber, { comments }),
  });
}

/**
 * Emit the result envelope and exit with the derived code.
 *
 * @param {{subcommand: string, ok: boolean, trunk?: string, result: unknown,
 *          problems?: unknown[], lines?: string[], json: boolean}} out
 * @returns {Promise<void>}
 */
async function emit(out) {
  const exitCode = out.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION;
  if (out.json) {
    const { version } = await import("../src/index.mjs");
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: TOOL,
          version,
          subcommand: out.subcommand,
          ok: out.ok,
          trunk: out.trunk ?? null,
          result: out.result,
          problems: out.problems ?? [],
          exitCode,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const line of out.lines ?? []) process.stdout.write(`${line}\n`);
  }
  process.exit(exitCode);
}

/**
 * Fetch every PR (open AND merged — a merged parent is invisible without
 * `--state all`, which would make its child look orphaned the moment it lands).
 *
 * @param {string} limit
 * @returns {unknown}
 */
function fetchPrs(limit) {
  return ghJson(`gh pr list --state all --limit ${Number(limit) || 100} --json ${PR_FIELDS}`);
}

/**
 * Render a plan as human-readable lines.
 *
 * @param {import("../src/pr-stack.mjs").StackPlan} plan
 * @returns {string[]}
 */
function renderPlan(plan) {
  const lines = [`stack on ${plan.trunk}: ${plan.counts.total} PR(s), merge order ${plan.order.join(" → ") || "—"}`];
  for (const entry of plan.actionable) {
    lines.push(`  ✓ #${entry.number} ${entry.head} — ${entry.action}: ${entry.reason}`);
  }
  for (const entry of plan.pending) {
    lines.push(`  · #${entry.number} ${entry.head} — ${entry.action}: ${entry.reason}`);
  }
  for (const problem of plan.problems) {
    lines.push(`  ✗ ${problem.kind}: ${problem.message}`);
  }
  return lines;
}

/**
 * Absolute git common directory: one per repository, shared by every
 * worktree, so all of a pull request's phases extend one receipt.
 *
 * @returns {string}
 */
function gitCommonDir() {
  const r = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.status !== 0 || r.stdout.trim() === "") return fail(EXIT_CODES.ENV, "not inside a git repository");
  return r.stdout.trim();
}

/**
 * Read and check the receipt at `file`, or null when none exists yet. A file
 * that is unreadable or fails `receiptProblem` is an environment error: it is
 * history, and silently starting over would erase it.
 *
 * @param {string} file
 * @param {number} prNumber The pull request the file is named for.
 * @returns {import("../src/run-receipt.mjs").RunReceipt|null}
 */
function readReceipt(file, prNumber) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return fail(EXIT_CODES.ENV, `${file} is not readable JSON: ${err.message}`);
  }
  const problem = receiptProblem(parsed, prNumber);
  if (problem) return fail(EXIT_CODES.ENV, `${file} is not a run receipt (${problem}); left unchanged`);
  return parsed;
}

const RECEIPT_LOCK_WAIT_MS = 2_000;
const RECEIPT_LOCK_STALE_MS = 30_000;

/**
 * Run `fn` while holding `<file>.lock`. Every worktree of a repository
 * extends one receipt, so two `record` calls must not both read N attempts
 * and each write N+1. The spot-check log beside the receipt takes its own
 * lock the same way. A lock older than RECEIPT_LOCK_STALE_MS belongs to a
 * process that died holding it and is cleared. A live one that does not free
 * up within RECEIPT_LOCK_WAIT_MS is an environment error.
 *
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @returns {T}
 */
function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + RECEIPT_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between mkdir and stat
      }
      if (age > RECEIPT_LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) return fail(EXIT_CODES.ENV, `lock is busy: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Replace a receipt or a spot-check log atomically, so a crash mid-write
 * leaves the previous history rather than half a file.
 *
 * @param {string} file
 * @param {object} value
 * @returns {void}
 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Read and check the spot-check log at `file`, or null when none exists yet.
 * Like `readReceipt`, a damaged log is an environment error and is left
 * unchanged: it is history.
 *
 * @param {string} file
 * @param {number} prNumber
 * @returns {import("../src/spot-check-store.mjs").SpotCheckStore|null}
 */
function readSpotCheckStore(file, prNumber) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return fail(EXIT_CODES.ENV, `${file} is not readable JSON: ${err.message}`);
  }
  const problem = spotCheckStoreProblem(parsed, prNumber);
  if (problem) return fail(EXIT_CODES.ENV, `${file} is not a spot-check log (${problem}); left unchanged`);
  return parsed;
}

/**
 * The `model` a phase artifact's frontmatter requests, read in the order
 * Claude Code loads a skill or command: the personal copy in `~/.claude/`
 * (where `bootstrap` links it) wins over the project's `.claude/` copy. A
 * copy that is unreadable or names no model falls through to the next. Null
 * when none names one — that is what the receipt records, not a guess.
 *
 * @param {string} root
 * @param {string} artifact
 * @returns {string|null}
 */
function requestedModel(root, artifact) {
  for (const file of [join(homedir(), ".claude", artifact), join(root, ".claude", artifact)]) {
    if (!existsSync(file)) continue;
    try {
      const model = frontmatterModel(readFileSync(file, "utf8"));
      if (model !== null) return model;
    } catch {
      // Unreadable: try the next copy.
    }
  }
  return null;
}

/**
 * The parsed `.dotbabel.json` at `<remote>/<baseRef>`, or undefined when the
 * base has none. The cap is read from the BASE, never the working tree or the
 * branch: the conductor edits and commits in that tree, so a cap it can read
 * there is a cap it can raise. The merge gate reads its policy the same way.
 *
 * Throws when the base ref is not in this clone: an unfetched ref must not
 * read as "no config", which would silently apply the default.
 *
 * @param {string} remote
 * @param {string} baseRef
 * @returns {unknown}
 */
function baseRefConfig(remote, baseRef) {
  const ref = `${remote}/${baseRef}`;
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(ref)) throw new Error(`base ref ${JSON.stringify(ref)} is not a plain ref name`);
  if (run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0) {
    throw new Error(`base ref ${ref} is not in this clone; run \`git fetch ${remote} ${baseRef}\` and retry`);
  }
  if (run(["git", "cat-file", "-e", `${ref}:.dotbabel.json`]).status !== 0) return undefined;
  const shown = run(["git", "show", `${ref}:.dotbabel.json`]);
  try {
    return JSON.parse(shown.stdout);
  } catch (err) {
    throw new Error(`${ref}:.dotbabel.json is not readable JSON: ${err.message}`);
  }
}

/**
 * Render a receipt as human-readable lines.
 *
 * @param {import("../src/run-receipt.mjs").RunReceipt} receipt
 * @returns {string[]}
 */
function renderReceipt(receipt) {
  const rollback = rollbackPoint(receipt);
  const lines = [`receipt #${receipt.pr}: ${receiptVerdict(receipt)}`];
  for (const [phase, s] of Object.entries(summarizePhases(receipt))) {
    const last = receipt.attempts.filter((a) => a.phase === phase).at(-1);
    const reason = last?.reason_code ? ` (${last.reason_code})` : "";
    lines.push(`  ${phase}: ${s.attempts} attempt(s), last ${s.last_outcome}${reason}, ${s.consecutive_failures} failed in a row`);
  }
  lines.push(
    rollback
      ? `  rollback point: ${rollback.base_ref ?? "(base unknown)"} @ ${rollback.merge_base.slice(0, 12)}`
      : "  rollback point: unknown",
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Merge verification: spot-check, main-status, contradiction.
//
// The decisions are pure (src/merge-verification.mjs), and the GitHub and git
// reads are in src/merge-verification-inputs.mjs. What stays here is the
// argument parsing, the local spot-check log, the local matrix run, and the
// output. One rule runs through all of it: data that could not be read is
// reported as `unknown`, and unknown is never verified.
// ---------------------------------------------------------------------------

const WORKFLOW_FILE_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const LOCAL_LABEL = "local (same machine as the agent; weaker than CI)";
const READ = { run };

/**
 * The `--workflow` value, checked before it reaches an API path.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function requireWorkflow(raw) {
  const wf = String(raw ?? "test.yml");
  if (!WORKFLOW_FILE_RE.test(wf)) return fail(EXIT_CODES.USAGE, `--workflow must be a workflow file name such as test.yml, got ${JSON.stringify(wf)}`);
  return wf;
}

/**
 * Run one gather and map an `InputError` to its exit: `usage` is 64, `env` 2.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function gather(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof InputError) return fail(err.code === "usage" ? EXIT_CODES.USAGE : EXIT_CODES.ENV, err.message);
    throw err;
  }
}

/**
 * The branch to read: `--trunk` when given, otherwise the repository's
 * default branch. An unreadable default branch is exit 2.
 *
 * @param {Record<string, any>} flags
 * @param {boolean} trunkGiven
 * @returns {string}
 */
function resolveTrunk(flags, trunkGiven) {
  return trunkGiven ? String(flags.trunk) : gather(() => defaultBranch(READ));
}

/**
 * Like `ghApiWithInput`, but returns the parsed response (or null when it is
 * not JSON). Throws on a non-zero exit.
 *
 * @param {string[]} argv
 * @param {object} jsonBody
 * @returns {any}
 */
function ghApiPost(argv, jsonBody) {
  const r = spawnSync(argv[0], argv.slice(1), {
    shell: false,
    input: JSON.stringify(jsonBody),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (r.status !== 0) throw new Error(`command failed (${r.status ?? 1}): ${argv.join(" ")}\n${(r.stderr ?? "").trim()}`);
  try {
    return JSON.parse(r.stdout ?? "");
  } catch {
    return null;
  }
}

const WRITE = { run, post: ghApiPost };

/**
 * Append one entry to the pull request's spot-check log, under its own lock.
 * The log is a sibling of the run receipt, never part of it: an older CLI
 * refuses a receipt with an unknown key.
 *
 * @param {number} prNumber
 * @param {Parameters<typeof appendSpotCheck>[1]} entry
 * @returns {string} The log path.
 */
function recordSpotCheck(prNumber, entry) {
  const file = spotCheckStorePath(gitCommonDir(), prNumber);
  withFileLock(file, () => {
    writeJsonAtomic(file, appendSpotCheck(readSpotCheckStore(file, prNumber) ?? createSpotCheckStore({ pr: prNumber }), entry));
  });
  return file;
}

/**
 * Why a spot-check decision came out as it did, in words.
 *
 * @param {ReturnType<typeof decideSpotCheck>} decision
 * @param {number} roll
 * @returns {string}
 */
function spotCheckWhy(decision, roll) {
  if (decision.reason === "always_path") {
    return decision.matched
      ? `changed path ${decision.matched} matches always_paths`
      : "always_paths is set and the changed files could not be read";
  }
  if (decision.reason === "off") return "the applicable rate is 0";
  return `roll ${roll.toFixed(4)} ${decision.selected ? "<" : ">="} rate ${decision.rate}`;
}

const VERIFY_NEXT = (prNumber) =>
  `  → verify explicitly (/merge-pr step 6), then record it: dotbabel pr-stack spot-check --pr ${prNumber} --record-explicit pass|fail`;

/**
 * The `spot-check` subcommand.
 *
 * @param {Record<string, any>} flags
 * @param {boolean} json
 * @param {boolean} trunkGiven
 * @returns {Promise<void>}
 */
async function spotCheckCommand(flags, json, trunkGiven) {
  const prNumber = requireNumber(flags.pr, "--pr");
  const file = spotCheckStorePath(gitCommonDir(), prNumber);
  if (flags.show === true) {
    const store = readSpotCheckStore(file, prNumber);
    const heads = store ? summarizeSpotChecks(store) : [];
    return emit({
      subcommand: "spot-check",
      ok: true,
      result: { path: file, heads },
      lines:
        heads.length === 0
          ? [`spot-check #${prNumber}: nothing recorded (${file})`]
          : [
              `spot-check #${prNumber}:`,
              ...heads.map(
                (h) =>
                  `  ${h.head_sha.slice(0, 8)}: ${h.selected === null ? "no decision" : `${h.selected ? "selected" : "not selected"} (${h.reason}${h.sticky ? ", sticky" : ""})`}, ` +
                  `explicit run: ${h.explicit ?? "none recorded"}`,
              ),
            ],
      json,
    });
  }
  const explicit = flags["record-explicit"];
  if (explicit !== undefined && explicit !== "pass" && explicit !== "fail") {
    return fail(EXIT_CODES.USAGE, "--record-explicit must be pass or fail");
  }
  const workflow = requireWorkflow(flags.workflow);
  // The one GitHub read that comes before every decision: the base commit
  // holds the policy, and the head is what the decision is about.
  const { view, headSha } = gather(() => readPrHead(READ, prNumber, "headRefOid,baseRefName,baseRefOid,changedFiles"));
  const { version } = await import("../src/index.mjs");

  if (explicit !== undefined) {
    recordSpotCheck(prNumber, { kind: "explicit-run", headSha, outcome: explicit, toolVersion: version });
    return emit({
      subcommand: "spot-check",
      ok: true,
      result: { path: file, headSha: headSha.toLowerCase(), explicit },
      lines: [`spot-check #${prNumber}: recorded explicit run ${explicit} on ${headSha.slice(0, 8)}`, `  log: ${file}`],
      json,
    });
  }

  let policy;
  try {
    policy = resolveSpotCheckPolicy(baseConfigAtRev(READ, String(view.baseRefOid ?? "")));
  } catch (err) {
    // A policy that cannot be read must not become the default: a typo would
    // then lower the check rate without anyone seeing it.
    return fail(EXIT_CODES.ENV, err.message);
  }
  const roll = spotCheckRoll({ headSha, prNumber });
  const head = headSha.toLowerCase();

  // A selection is sticky. The roll is fixed for a head, but the rate follows
  // the CI state and the base policy; without this, asking again after one
  // green run could turn SELECTED into "not selected".
  const prior = firstSelection(readSpotCheckStore(file, prNumber), headSha);
  if (prior !== null) {
    const decision = { selected: true, reason: prior.reason, rate: prior.rate, matched: null, sticky: true };
    recordSpotCheck(prNumber, {
      kind: "spot-check",
      headSha,
      selected: true,
      reason: prior.reason,
      rate: prior.rate,
      roll,
      ci: prior.ci,
      workflow: prior.workflow,
      trunk: prior.trunk,
      sticky: true,
      toolVersion: version,
    });
    return emit({
      subcommand: "spot-check",
      ok: true,
      trunk: prior.trunk,
      result: { pr: prNumber, headSha: head, roll, decision, ci: { state: prior.ci }, policy, firstSelectedAt: prior.at, log: file },
      lines: [
        `spot-check #${prNumber}: SELECTED (${prior.reason}: sticky; this head was first selected at ${prior.at})`,
        "  the roll is fixed for a head, and a selection stays",
        VERIFY_NEXT(prNumber),
      ],
      json,
    });
  }

  // Off: nothing can select. Decide before the changed files, the default
  // branch and the CI runs are read, and record nothing.
  if (isSpotCheckOff(policy)) {
    const decision = { selected: false, reason: "off", rate: 0, matched: null, sticky: false };
    return emit({
      subcommand: "spot-check",
      ok: true,
      result: { pr: prNumber, headSha: head, roll, decision, ci: null, policy, changedFilesKnown: null, log: null },
      lines: [
        `spot-check #${prNumber}: not selected (off: the base .dotbabel.json turns spot checks off; nothing read or recorded)`,
        "  → the attestation stands; no explicit run",
      ],
      json,
    });
  }

  const trunk = resolveTrunk(flags, trunkGiven);
  const paths = prChangedPaths(READ, prNumber, view.changedFiles);
  const recentShas = gather(() => {
    try {
      return trunkCommits(READ, { remote: String(flags.remote), trunk, limit: RECENT_TRUNK_COMMITS }).commits.map((c) => c.sha);
    } catch (err) {
      // An unreadable trunk makes CI `unknown`; a malformed one is a usage error.
      if (err instanceof InputError && err.code === "env") return null;
      throw err;
    }
  });
  const ci = gather(() => ciAvailability(READ, { workflow, trunk, recentShas }));
  const decision = { ...decideSpotCheck({ policy, changedPaths: paths, ciAvailable: ci.available, random: roll }), sticky: false };
  recordSpotCheck(prNumber, {
    kind: "spot-check",
    headSha,
    selected: decision.selected,
    reason: decision.reason,
    rate: decision.rate,
    roll,
    ci: ci.state,
    workflow,
    trunk,
    sticky: false,
    toolVersion: version,
  });
  return emit({
    subcommand: "spot-check",
    ok: true,
    trunk,
    result: { pr: prNumber, headSha: head, roll, decision, ci, policy, changedFilesKnown: paths !== null, log: file },
    lines: [
      `spot-check #${prNumber}: ${decision.selected ? "SELECTED" : "not selected"} (${decision.reason}: ${spotCheckWhy(decision, roll)})`,
      `  ci on ${trunk}: ${ci.state} (${ci.reason}${ci.run?.url ? `; ${ci.run.url}` : ""})`,
      decision.selected ? VERIFY_NEXT(prNumber) : "  → the attestation stands; no explicit run",
    ],
    json,
  });
}

/**
 * Refuse `main-status --local` unless the repository is trusted to run its
 * own commands. The local run executes repository code as the current user:
 * the local-attest config module, the install's lifecycle scripts, and every
 * matrix leg, all from the default-branch tip. Under this spec's threat model
 * that tip can hold code that merged on a forged attestation.
 *
 * @param {Record<string, any>} flags
 * @returns {"flag"|"allowlist"}
 */
function requireProjectTrust(flags) {
  if (flags["allow-project-commands"] === true) return "flag";
  const root = repoRoot();
  const trust = isRepoTrusted({ repoRoot: root });
  if (trust.trusted) return "allowlist";
  return fail(
    EXIT_CODES.ENV,
    "main-status --local runs this repository's code from the default-branch tip as you: the local-attest config, " +
      `the install's lifecycle scripts, and every matrix leg. ${root} is not on the project-command trust allowlist ` +
      `(${trust.trustFile}). Trust it with \`dotbabel project-init --trust\`, or pass --allow-project-commands for this run.`,
  );
}

/**
 * Run the local-attest matrix on `sha` in a temporary detached worktree.
 *
 * Diagnostic mode (`--from <first leg>`), not `--dry-run`: an attest run
 * refuses a detached HEAD and needs an open pull request, and a precondition
 * failure exits 1, which would read here as a failing matrix. Diagnostic mode
 * runs the whole matrix from its first leg, never posts, labels or pushes, and
 * cannot attest. Dependencies are installed first from the same lockfile
 * table as the explicit path of /merge-pr; with no supported lockfile nothing
 * is installed and the detail says so. An install failure is `unknown`, not
 * `fail`.
 *
 * @param {string} sha
 * @returns {Promise<{ sha: string, result: "pass"|"fail"|"unknown", exitCode: number|null, label: string,
 *                     worktree: string, detail: string|null }>}
 */
async function runLocalMatrix(sha) {
  const holder = mkdtempSync(join(tmpdir(), "dotbabel-main-status-"));
  const worktree = join(holder, "wt");
  const out = { sha, result: /** @type {"pass"|"fail"|"unknown"} */ ("unknown"), exitCode: /** @type {number|null} */ (null), label: LOCAL_LABEL, worktree, detail: /** @type {string|null} */ (null) };
  const add = run(["git", "worktree", "add", "--detach", worktree, sha]);
  if (add.status !== 0) {
    rmSync(holder, { recursive: true, force: true });
    return { ...out, detail: `git worktree add failed: ${add.stderr.trim()}` };
  }
  try {
    let cfg;
    try {
      cfg = await loadLocalAttestConfig({ cwd: worktree, override: null });
    } catch (err) {
      return { ...out, detail: `no usable local-attest config: ${err.message}` };
    }
    const first = cfg.matrix[0]?.name;
    if (typeof first !== "string" || first === "") return { ...out, detail: "the local-attest matrix has no legs" };
    const installs = installCommandsFor(LOCKFILE_INSTALLS.map(([lockfile]) => lockfile).filter((f) => existsSync(join(worktree, f))));
    for (const { argv } of installs) {
      const r = spawnSync(argv[0], argv.slice(1), { cwd: worktree, stdio: ["ignore", 2, 2] });
      if (r.error) return { ...out, detail: `${argv.join(" ")} could not start: ${r.error.message}` };
      if (r.status !== 0) return { ...out, detail: `${argv.join(" ")} failed (exit ${r.status ?? "signal"})` };
    }
    const installed = installs.length === 0 ? "no supported lockfile; no install ran" : null;
    const bin = fileURLToPath(new URL("./dotbabel-local-attest.mjs", import.meta.url));
    // The child's stdout goes to our stderr, so --json output stays one object.
    const r = spawnSync(process.execPath, [bin, "--from", first], { cwd: worktree, stdio: ["ignore", 2, 2] });
    const code = r.status ?? null;
    if (code === 0 || code === 1) return { ...out, exitCode: code, result: code === 0 ? "pass" : "fail", detail: installed };
    return { ...out, exitCode: code, detail: [`local-attest exited ${code ?? "on a signal"}`, installed].filter(Boolean).join("; ") };
  } finally {
    run(["git", "worktree", "remove", "--force", worktree]);
    run(["git", "worktree", "prune"]);
    rmSync(holder, { recursive: true, force: true });
  }
}

/**
 * The spot-check decision that stands for a pull request's latest head, or
 * null when its log is absent, unreadable, invalid, or holds none. Unlike
 * `readSpotCheckStore` it never exits: one bad log must not stop the report.
 *
 * @param {string} file
 * @param {number} prNumber
 * @returns {{ head_sha: string, selected: boolean|null, reason: string|null, sticky: boolean, explicit: "pass"|"fail"|null }|null}
 */
function latestSpotCheck(file, prNumber) {
  if (!existsSync(file)) return null;
  try {
    const store = JSON.parse(readFileSync(file, "utf8"));
    if (spotCheckStoreProblem(store, prNumber) !== null) return null;
    const latest = summarizeSpotChecks(store).at(-1);
    if (!latest) return null;
    return { head_sha: latest.head_sha, selected: latest.selected, reason: latest.reason, sticky: latest.sticky, explicit: latest.explicit };
  } catch {
    return null;
  }
}

/**
 * The `main-status` subcommand.
 *
 * @param {Record<string, any>} flags
 * @param {boolean} json
 * @param {boolean} trunkGiven
 * @returns {Promise<void>}
 */
async function mainStatusCommand(flags, json, trunkGiven) {
  const limit = flags.limit === undefined ? 20 : requireNumber(flags.limit, "--limit");
  const workflow = requireWorkflow(flags.workflow);
  const trust = flags.local === true ? requireProjectTrust(flags) : null;
  const trunk = resolveTrunk(flags, trunkGiven);
  const { ref, fetched, commits } = gather(() => trunkCommits(READ, { remote: String(flags.remote), trunk, limit }));
  const runs = gather(() => workflowRunsFor(READ, { workflow, trunk, shas: commits.map((c) => c.sha) }));
  const status = mainVerificationStatus({ commits, runs });

  // What the spot-check log recorded for each merged pull request: the
  // decision that stands and whether an explicit run followed. Local and
  // self-reported; absent on another machine.
  const common = gitCommonDir();
  const rows = status.commits.map((c, i) => ({
    ...c,
    subject: commits[i].subject,
    spotCheck: c.pr === null ? null : latestSpotCheck(spotCheckStorePath(common, c.pr), c.pr),
  }));

  const local = flags.local === true && commits.length > 0 ? { ...(await runLocalMatrix(commits[0].sha)), trust } : null;
  const icon = { verified: "✓", red: "✗", unverified: "·", unknown: "?" };
  const debt = status.unverified.length + status.red.length + status.unknown.length;
  const lines = [
    `main-status on ${ref}${fetched ? "" : " (fetch failed; may be stale)"}: ` +
      (status.known
        ? `last green ${status.lastGreen ? status.lastGreen.slice(0, 8) : "none in range"}`
        : `CI runs unknown (${workflow} runs could not be read); nothing is verified`),
    ...rows.map((c) => {
      const spot = c.spotCheck
        ? `  [spot-check: ${c.spotCheck.selected ? "selected" : "not selected"}, explicit run: ${c.spotCheck.explicit ?? "none"}]`
        : "";
      return `  ${icon[c.state]} ${c.state.padEnd(10)} ${c.sha.slice(0, 8)} ${c.pr === null ? "" : `#${c.pr} `}${c.subject}${spot}`;
    }),
    status.known
      ? `  debt: ${debt} commit(s) newer than the last green run ` +
        `(${status.red.length} red, ${status.unverified.length} unverified, ${status.unknown.length} unknown)`
      : `  debt: unknown (${status.unknown.length} commit(s) unknown)`,
    ...(local
      ? [`  ${LOCAL_LABEL}: ${local.result} on ${local.sha.slice(0, 8)}${local.detail ? ` (${local.detail})` : ""}`]
      : []),
  ];
  return emit({
    subcommand: "main-status",
    ok: !(local && local.result === "fail"),
    trunk,
    result: { ref, fetched, workflow, status: { ...status, commits: rows }, local },
    lines,
    json,
  });
}

/**
 * Label each suspect and open (or reopen) the one issue for this alarm.
 *
 * @param {number[]} prs
 * @param {{ title: string, body: string, labels: string[] }} issue
 * @param {string} marker
 * @returns {ReturnType<typeof openContradictionIssue>}
 */
function postContradiction(prs, issue, marker) {
  try {
    for (const pr of prs) labelContradicted(WRITE, pr);
    return openContradictionIssue(WRITE, { issue, marker, workflowOnly: process.env.GITHUB_ACTIONS === "true" });
  } catch (err) {
    return fail(EXIT_CODES.ENV, `contradiction found for ${prs.map((n) => `#${n}`).join(", ")}, but posting failed: ${err.message}`);
  }
}

/**
 * One line that says what `--post` did.
 *
 * @param {number[]} prs
 * @param {ReturnType<typeof openContradictionIssue>|null} posted
 * @returns {string}
 */
function postedLine(prs, posted) {
  if (!posted) return "  not posted (pass --post to label the pull request and open an issue)";
  const state = posted.created ? "opened" : posted.reopened ? "reopened (it was closed)" : "already open";
  return `  labelled ${prs.map((n) => `#${n}`).join(", ")} ${CONTRADICTION_LABEL}; issue ${state}: #${posted.number ?? "?"}${posted.url ? ` ${posted.url}` : ""}`;
}

/**
 * `contradiction --pr <N> --local-failure`: an explicit run on this machine
 * failed against the pull request head, before the merge.
 *
 * @param {Record<string, any>} flags
 * @param {boolean} json
 * @returns {Promise<void>}
 */
async function localContradiction(flags, json) {
  const prNumber = requireNumber(flags.pr, "--pr");
  const { view, headSha } = gather(() => readPrHead(READ, prNumber, "headRefOid,baseRefOid"));
  const base = String(view?.baseRefOid ?? "");
  if (!/^[0-9a-f]{40}$/i.test(base)) return fail(EXIT_CODES.ENV, `#${prNumber} has no readable base SHA`);
  const trust = gather(() => trustListAt(READ, base, "pull request base"));
  const comments = prComments(READ, prNumber);
  if (comments === null) return fail(EXIT_CODES.ENV, `could not read the comments of #${prNumber}`);
  const match = attestationMatch({ comments, headSha, trustedAssociations: trust.list });
  const attestedSha = headSha.toLowerCase();
  const result = {
    pr: prNumber,
    attestedSha,
    local: true,
    run: "red",
    trustedAssociations: trust.list,
    trustListSource: trust.source,
    edited: match.edited,
  };
  if (!match.found) {
    return emit({
      subcommand: "contradiction",
      ok: true,
      result: { ...result, contradiction: false, reason: "no trusted, passing attestation for the head" },
      lines: [`contradiction: none (#${prNumber} had no trusted, passing attestation for ${attestedSha.slice(0, 8)})`],
      json,
    });
  }
  const posted =
    flags.post === true
      ? postContradiction([prNumber], renderLocalContradictionIssue({ pr: prNumber, attestedSha, edited: match.edited }), contradictionMarker({ pr: prNumber, sha: attestedSha }))
      : null;
  return emit({
    subcommand: "contradiction",
    ok: false,
    result: { ...result, contradiction: true, label: CONTRADICTION_LABEL, issue: posted },
    problems: [{ code: "ATTESTATION_CONTRADICTED", message: `#${prNumber} was attested as passing at ${attestedSha}, and an explicit run failed` }],
    lines: [
      `contradiction: FOUND — #${prNumber} was attested as passing at ${attestedSha.slice(0, 8)}, and an explicit run failed (${LOCAL_LABEL})`,
      ...(match.edited ? ["  the attestation comment was edited after it was posted"] : []),
      postedLine([prNumber], posted),
    ],
    json,
  });
}

/**
 * The `contradiction` subcommand.
 *
 * With `--sha`, it judges a failed push run on the default branch. The run
 * can blame every commit back to the last green run (the cumulative rule), so
 * it checks every pull request merged in that first-parent range, at most
 * CONTRADICTION_RANGE_LIMIT commits. Each one with a trusted, passing
 * attestation is a suspect. All suspects get the label, and the failing
 * commit gets one issue. When the first parent's own run was already red,
 * the default branch was red before this push, so it raises no new alarm.
 *
 * @param {Record<string, any>} flags
 * @param {boolean} json
 * @param {boolean} trunkGiven
 * @returns {Promise<void>}
 */
async function contradictionCommand(flags, json, trunkGiven) {
  if (flags["local-failure"] === true) return localContradiction(flags, json);
  const sha = typeof flags.sha === "string" ? flags.sha : "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) return fail(EXIT_CODES.USAGE, "--sha must be a full 40-character SHA (or pass --pr <N> --local-failure)");
  const testResult = flags["test-result"];
  if (!["success", "failure", "cancelled", "skipped"].includes(testResult)) {
    return fail(EXIT_CODES.USAGE, "--test-result must be one of: success, failure, cancelled, skipped");
  }
  const failing = sha.toLowerCase();
  const none = (result, line) =>
    emit({ subcommand: "contradiction", ok: true, result: { sha: failing, testResult, ...result, contradiction: false }, lines: [line], json });
  if (testResult !== "failure") return none({ run: null, reason: "the test job did not fail" }, `contradiction: none (test result ${testResult})`);

  // Classify the run before believing the failure. In CI the run is this very
  // workflow run; locally it is the latest run of the workflow for the
  // commit. A run that never started tested nothing and contradicts nothing.
  // A run or a jobs list that cannot be read is exit 2, never a silent "no".
  const workflow = requireWorkflow(flags.workflow);
  const runId = /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : null;
  let runObj;
  if (runId !== null) {
    runObj = ghApiJson(READ, `repos/{owner}/{repo}/actions/runs/${runId}`);
  } else {
    const resp = ghApiJson(READ, `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?head_sha=${failing}&per_page=1`);
    runObj = Array.isArray(resp?.workflow_runs) ? (resp.workflow_runs[0] ?? null) : null;
  }
  if (!runObj) return fail(EXIT_CODES.ENV, `could not read the workflow run for ${failing}; cannot tell a real failure from a run that never started`);
  const runState = classifyWorkflowRun(READ, runObj);
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runUrl =
    runId !== null && server && repo && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)
      ? `${server}/${repo}/actions/runs/${runId}`
      : (runObj.html_url ?? null);
  if (runState === "unknown") {
    return fail(EXIT_CODES.ENV, `could not read the jobs of the run for ${failing}; cannot tell a real failure from a run that never started`);
  }
  if (runState === "green") return none({ run: runState, runUrl, reason: "the run passed" }, "contradiction: none (the run passed)");
  if (runState === "unverified") {
    return none(
      { run: runState, runUrl, reason: "the run did not test anything (unverified)" },
      "contradiction: none (the run is unverified: it never ran the tests, so it proves nothing either way)",
    );
  }

  // The range the red run can blame: back to the last green run.
  const trunk = resolveTrunk(flags, trunkGiven);
  const history = gather(() => firstParentHistory(READ, failing, CONTRADICTION_RANGE_LIMIT + 1));
  if (history[0]?.sha !== failing) return fail(EXIT_CODES.ENV, `cannot read the history of ${failing}`);
  const parent = history[1]?.sha ?? null;
  const runs = gather(() => workflowRunsFor(READ, { workflow, trunk, shas: history.map((c) => c.sha), classify: (s) => s === parent }));
  if (runs === null) return fail(EXIT_CODES.ENV, `could not read the ${workflow} runs on ${trunk}; cannot find the last green commit`);
  const best = bestRunStates(runs);
  const parentState = parent === null ? null : (best.get(parent) ?? null);
  if (parentState === "unknown") {
    return fail(EXIT_CODES.ENV, `could not read the run of the first parent ${parent}; cannot tell whether ${trunk} was already red`);
  }
  if (parentState === "red") {
    return none(
      { run: runState, runUrl, firstParent: parent, reason: "the default branch was already red at the first parent" },
      `contradiction: no new alarm (the first parent ${parent.slice(0, 8)} already had a red run, so ${trunk} was red before this push)`,
    );
  }
  const greenShas = new Set([...best].filter(([, state]) => state === "green").map(([s]) => s));
  const range = contradictionRange({ commits: history, greenShas });

  const checked = [];
  const suspects = [];
  for (const c of range.commits) {
    const pull = gather(() => mergedPullFor(READ, c.sha));
    if (pull === null) {
      checked.push({ sha: c.sha, pr: null });
      continue;
    }
    // The trust list the merge gate used: the base the pull request merged
    // into, which is the merge commit's first parent. Never the merge commit.
    const trust = gather(() => trustListAt(READ, `${c.sha}^1`, "first parent"));
    const comments = prComments(READ, pull.number);
    if (comments === null) return fail(EXIT_CODES.ENV, `could not read the comments of #${pull.number}`);
    const match = attestationMatch({ comments, headSha: pull.headSha, trustedAssociations: trust.list });
    checked.push({ sha: c.sha, pr: pull.number, attestedSha: pull.headSha, trustedAssociations: trust.list, trustListSource: trust.source, attested: match.found, edited: match.edited });
    if (match.found) suspects.push({ pr: pull.number, attestedSha: pull.headSha, mergeSha: c.sha, edited: match.edited });
  }

  const rangeOut = { commits: range.commits.map((c) => c.sha), lastGreen: range.lastGreen, bounded: range.bounded };
  const span = `${failing.slice(0, 8)} back to ${range.lastGreen ? `the last green ${range.lastGreen.slice(0, 8)}` : range.bounded ? "the bound" : "the start of the history"} (${range.commits.length} commit(s))`;
  const result = { sha: failing, testResult, run: runState, runUrl, trunk, range: rangeOut, checked, suspects };
  if (suspects.length === 0) {
    return emit({
      subcommand: "contradiction",
      ok: true,
      result: { ...result, contradiction: false, reason: "no pull request in the range had a trusted, passing attestation" },
      lines: [`contradiction: none (no pull request merged in ${span} had a trusted, passing attestation)`],
      json,
    });
  }
  const prs = suspects.map((s) => s.pr);
  const posted =
    flags.post === true
      ? postContradiction(prs, renderContradictionIssue({ failingSha: failing, runUrl, range, suspects }), failingCommitMarker(failing))
      : null;
  return emit({
    subcommand: "contradiction",
    ok: false,
    result: { ...result, contradiction: true, label: CONTRADICTION_LABEL, issue: posted },
    problems: suspects.map((s) => ({
      code: "ATTESTATION_CONTRADICTED",
      message: `#${s.pr} was attested as passing at ${s.attestedSha}, and the run on ${failing} failed`,
    })),
    lines: [
      `contradiction: FOUND — the run on ${failing.slice(0, 8)} failed, and ${suspects.length} pull request(s) merged in ${span} had a trusted, passing attestation`,
      ...suspects.map(
        (s) => `  #${s.pr}: attested at ${s.attestedSha.slice(0, 8)}, merged as ${s.mergeSha.slice(0, 8)}${s.edited ? " (the comment was edited after it was posted)" : ""}`,
      ),
      ...(runUrl ? [`  failed run: ${runUrl}`] : []),
      postedLine(prs, posted),
    ],
    json,
  });
}

/**
 * Entry point.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
    const { version } = await import("../src/index.mjs");
    process.stdout.write(`${version}\n`);
    process.exit(EXIT_CODES.OK);
  }

  let argv;
  try {
    argv = parse(rawArgs, FLAGS);
  } catch (err) {
    return fail(EXIT_CODES.USAGE, err.message);
  }

  if (argv.help || rawArgs.length === 0) {
    process.stdout.write(`${HELP}\n`);
    process.exit(EXIT_CODES.OK);
  }

  const sub = argv.positional[0];
  if (!SUBCOMMANDS.has(sub)) {
    return fail(EXIT_CODES.USAGE, `unknown subcommand: ${sub ?? "(none)"}`);
  }

  const { flags, json } = argv;
  const trunkGiven = typeof flags.trunk === "string";
  if (!trunkGiven) flags.trunk = "main";

  if (sub === "phases") {
    return emit({
      subcommand: sub,
      ok: true,
      result: { phases: CONDUCTOR_PHASES },
      lines: CONDUCTOR_PHASES.map((p, i) => `${i + 1}. ${p.id} → ${p.invocation} (${p.artifact})`),
      json,
    });
  }

  if (sub === "graph" || sub === "plan") {
    const graph = buildStackGraph(fetchPrs(flags.limit), { trunk: flags.trunk });
    if (sub === "graph") {
      return emit({
        subcommand: sub,
        ok: true,
        trunk: graph.trunk,
        result: graph,
        lines: graph.edges.map((e) => `#${e.parent} → #${e.child}`),
        json,
      });
    }
    const plan = planStack(graph);
    return emit({
      subcommand: sub,
      ok: plan.ok,
      trunk: plan.trunk,
      result: plan,
      problems: plan.problems,
      lines: renderPlan(plan),
      json,
    });
  }

  if (sub === "next") {
    const childNumber = requireNumber(flags.pr, "--pr");
    const parentNumber = requireNumber(flags.parent, "--parent");
    const child = ghJson(`gh pr view ${childNumber} --json ${PR_FIELDS}`);
    const parent = ghJson(`gh pr view ${parentNumber} --json ${PR_FIELDS}`);
    if (typeof flags["parent-sha"] === "string" && flags["parent-sha"] !== "") {
      parent.headRefOid = flags["parent-sha"];
    }

    let transition;
    try {
      transition = planChildTransition({ child, parent, trunk: flags.trunk, remote: flags.remote });
    } catch (err) {
      return fail(EXIT_CODES.VALIDATION, err.message);
    }
    for (const warning of transition.warnings) process.stderr.write(`${TOOL}: warning: ${warning}\n`);

    return emit({
      subcommand: sub,
      ok: true,
      trunk: flags.trunk,
      result: transition,
      lines: [`#${transition.number}: ${transition.reason}`, ...transition.steps.map((s) => `  ${s.cmd}`)],
      json,
    });
  }

  if (sub === "entry") {
    // Removes the need to remember that `open-pr` self-skips on an existing
    // pull request. The state is observable, so it is derived rather than
    // asked for with `--from`.
    let prNumber = flags.pr === undefined ? null : requireNumber(flags.pr, "--pr");
    if (prNumber === null) {
      // State, not just the number: `gh pr view` falls back to the most recent
      // CLOSED or MERGED pull request for the head ref, and a dead one must
      // still enter at phase 2 rather than skip it.
      const r = sh("gh pr view --json number,state");
      if (r.status === 0) {
        try {
          const view = JSON.parse(r.stdout);
          if (view.state === "OPEN" && Number.isInteger(view.number) && view.number > 0) {
            prNumber = view.number;
          }
        } catch {
          prNumber = null;
        }
      } else if (!/no pull requests? found|no open pull requests?/i.test(r.stderr)) {
        // A genuine "this branch has no PR" is the NO_PR answer. Anything else
        // — gh missing, unauthenticated, an API error — is an environment
        // problem, and laundering it into NO_PR would tell phase 2 to open a
        // pull request that may already exist.
        fail(EXIT_CODES.ENV, `could not resolve the pull request for this branch:\n${r.stderr.trim()}`);
      }
    }
    // Evidence about the CURRENT head decides whether the review and attest
    // stages can be skipped. Unreadable evidence degrades to "none", never to an
    // error: the conservative answer is the full pipeline, which is always safe,
    // and an outage must not stop someone from resuming work.
    let evidence = null;
    if (prNumber !== null) {
      const head = run(["gh", "pr", "view", String(prNumber), "--json", "headRefOid", "--jq", ".headRefOid"]);
      const headSha = head.status === 0 ? head.stdout.trim() : "";
      evidence = /^[0-9a-f]{40}$/i.test(headSha)
        ? reviewEntryFacts({ run }, prNumber, headSha)
        : {
            reviewedAtHead: false,
            attestedAtHead: false,
            review: {
              state: "not-reviewed",
              code: "REVIEW_INVALID",
              detail: "the pull request head SHA could not be read",
            },
          };
    }
    const result = deriveEntryPhase({
      prNumber,
      reviewedAtHead: evidence?.reviewedAtHead,
      attestedAtHead: evidence?.attestedAtHead,
    });
    return emit({
      subcommand: sub,
      ok: true,
      result: {
        ...result,
        prNumber,
        evidence: evidence && {
          reviewedAtHead: evidence.reviewedAtHead,
          attestedAtHead: evidence.attestedAtHead,
          review: { code: evidence.review.code, detail: evidence.review.detail },
        },
      },
      problems: [],
      lines: [
        `entry: ${result.phase} (${result.reason})`,
        ...(result.skips.length > 0 ? [`  skips: ${result.skips.join(", ")}`] : []),
        ...(evidence
          ? [
              `  review: ${evidence.reviewedAtHead ? "complete on this head" : `${evidence.review.code} (${evidence.review.detail})`}`,
              `  attestation: ${evidence.attestedAtHead ? "current on this head" : "none on this head"}`,
            ]
          : []),
      ],
      json,
    });
  }

  if (sub === "review-complete") {
    const prNumber = requireNumber(flags.pr, "--pr");
    const { version } = await import("../src/index.mjs");
    const outcome = postReviewComplete(
      { run, capture, ghApiWithInput, log: (msg) => process.stderr.write(`${TOOL}: ${msg}\n`) },
      {
        prNumber,
        // The criteria half of the very verdict `gate --gate merge` reports, so
        // the two can never disagree about whether criteria are satisfied.
        criteriaReasons: (n) => gatherMergeGate(n).reasons.filter((r) => String(r.code).startsWith("CRITERIA_")),
        dryRun: flags["dry-run"] === true,
        toolVersion: version,
      },
    );
    if (outcome.env) return fail(EXIT_CODES.ENV, outcome.message);
    const reasons = outcome.reasons ?? [];
    return emit({
      subcommand: sub,
      ok: outcome.ok,
      result: {
        posted: outcome.posted,
        headSha: outcome.headSha ?? null,
        reviewedSha: outcome.reviewedSha ?? null,
        counts: outcome.counts ?? null,
        reasons,
        ...(flags["dry-run"] === true && outcome.body ? { body: outcome.body } : {}),
      },
      problems: reasons,
      lines: [
        `review-complete: ${outcome.ok ? (outcome.posted ? "POSTED" : "DRY-RUN") : "BLOCKED"}`,
        ...reasons.map((r) => `  ✗ ${r.code}: ${r.message}`),
        ...(outcome.ok && outcome.counts
          ? [
              `  head ${outcome.headSha.slice(0, 8)}, reviewed ${outcome.reviewedSha.slice(0, 8)}, ` +
                `${outcome.counts.findingsPosted} finding(s), ${outcome.counts.otherOpenThreads} other open thread(s)`,
            ]
          : []),
        ...(flags["dry-run"] === true && outcome.body ? ["", outcome.body] : []),
      ],
      json,
    });
  }

  if (sub === "record") {
    const prNumber = requireNumber(flags.pr, "--pr");
    const phase = CONDUCTOR_PHASES.find((p) => p.id === flags.phase);
    if (!phase) return fail(EXIT_CODES.USAGE, `--phase must be one of: ${CONDUCTOR_PHASES.map((p) => p.id).join(", ")}`);
    if (!RECEIPT_OUTCOMES.includes(/** @type {any} */ (flags.outcome))) {
      return fail(EXIT_CODES.USAGE, `--outcome must be one of: ${RECEIPT_OUTCOMES.join(", ")}`);
    }
    if (flags.reason !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(String(flags.reason))) {
      return fail(EXIT_CODES.USAGE, "--reason must be an UPPER_SNAKE reason code");
    }
    const explicitSha = typeof flags.sha === "string" && flags.sha !== "" ? flags.sha : null;
    if (explicitSha !== null && !/^[0-9a-f]{40}$/i.test(explicitSha)) {
      return fail(EXIT_CODES.USAGE, "--sha must be a full 40-character SHA for record");
    }
    // The head comes from the pull request, not the local checkout: `/review-pr`
    // pushes from its own worktree, so this checkout can lag behind the head
    // the phase actually ran on. --sha is a FALLBACK for when gh cannot answer:
    // it never overrides the head gh reports, so it cannot attach an outcome to
    // a commit the pull request is not at.
    const view = run(["gh", "pr", "view", String(prNumber), "--json", "headRefOid,baseRefName"]);
    let ghHead = null;
    let baseRef = null;
    if (view.status === 0) {
      try {
        const parsed = JSON.parse(view.stdout);
        if (typeof parsed.headRefOid === "string" && /^[0-9a-f]{40}$/i.test(parsed.headRefOid)) ghHead = parsed.headRefOid;
        baseRef = typeof parsed.baseRefName === "string" && parsed.baseRefName !== "" ? parsed.baseRefName : null;
      } catch {
        // Fall through: an unparseable answer is no answer.
      }
    }
    let headSha = ghHead;
    if (explicitSha !== null && ghHead !== null && explicitSha.toLowerCase() !== ghHead.toLowerCase()) {
      return fail(EXIT_CODES.USAGE, `--sha ${explicitSha} is not the head of #${prNumber} (${ghHead}); omit --sha`);
    }
    if (headSha === null && explicitSha !== null) {
      if (run(["git", "cat-file", "-e", `${explicitSha}^{commit}`]).status !== 0) {
        return fail(EXIT_CODES.USAGE, `--sha ${explicitSha} is not a commit in this repository`);
      }
      headSha = explicitSha;
    }
    if (headSha === null) {
      return fail(EXIT_CODES.ENV, `could not read the head of #${prNumber}; pass --sha to record anyway\n${view.stderr.trim()}`);
    }
    let mergeBase = null;
    if (baseRef !== null) {
      const mb = run(["git", "merge-base", `${flags.remote}/${baseRef}`, headSha]);
      if (mb.status === 0 && /^[0-9a-f]{40}$/i.test(mb.stdout.trim())) mergeBase = mb.stdout.trim();
    }
    const file = receiptPath(gitCommonDir(), prNumber);
    const { version } = await import("../src/index.mjs");
    const attemptInput = {
      phase: phase.id,
      outcome: String(flags.outcome),
      headSha,
      baseRef,
      mergeBase,
      reasonCode: flags.reason === undefined ? null : String(flags.reason),
      evidence: Array.isArray(flags.evidence) ? flags.evidence.map(String) : [],
      requestedModel: requestedModel(repoRoot(), phase.artifact),
      toolVersion: version,
    };
    // Validate before taking the lock, so a usage error never waits on it.
    try {
      appendAttempt(createReceipt({ pr: prNumber }), attemptInput);
    } catch (err) {
      return fail(EXIT_CODES.USAGE, err.message);
    }
    const receipt = withFileLock(file, () => {
      const next = appendAttempt(readReceipt(file, prNumber) ?? createReceipt({ pr: prNumber }), attemptInput);
      writeJsonAtomic(file, next);
      return next;
    });
    const attempt = receipt.attempts.at(-1);
    const summary = summarizePhases(receipt)[phase.id];
    // Recording never fails on the cap: an unreadable cap is reported here and
    // made an error by `gate --gate budget`, which is where the decision is.
    let maxAttempts = null;
    let capProblem = null;
    try {
      maxAttempts = resolveMaxAttempts(baseRefConfig(flags.remote, baseRef ?? flags.trunk), phase.id);
    } catch (err) {
      capProblem = err.message;
    }
    return emit({
      subcommand: sub,
      ok: true,
      result: { path: file, attempt, phase: summary, verdict: receiptVerdict(receipt), maxAttempts },
      lines: [
        `record: ${attempt.phase} attempt ${attempt.n} ${attempt.outcome} on ${attempt.head_sha.slice(0, 8)}`,
        `  consecutive failures: ${summary.consecutive_failures} of ${maxAttempts ?? `? (${capProblem})`}`,
        `  receipt: ${file}`,
      ],
      json,
    });
  }

  if (sub === "receipt") {
    const prNumber = requireNumber(flags.pr, "--pr");
    const file = receiptPath(gitCommonDir(), prNumber);
    const receipt = readReceipt(file, prNumber);
    if (receipt === null) {
      return emit({
        subcommand: sub,
        ok: true,
        result: { path: file, receipt: null },
        lines: [`no receipt for #${prNumber} (${file})`],
        json,
      });
    }
    return emit({
      subcommand: sub,
      ok: true,
      result: {
        path: file,
        verdict: receiptVerdict(receipt),
        phases: summarizePhases(receipt),
        rollback: rollbackPoint(receipt),
        receipt,
      },
      lines: renderReceipt(receipt),
      json,
    });
  }

  if (sub === "spot-check") return spotCheckCommand(flags, json, trunkGiven);
  if (sub === "main-status") return mainStatusCommand(flags, json, trunkGiven);
  if (sub === "contradiction") return contradictionCommand(flags, json, trunkGiven);

  const which = flags.gate;

  // skip-ci inspects a local commit message, so it needs no PR number.
  if (which === "skip-ci") {
    const rev = typeof flags.sha === "string" && flags.sha !== "" ? assertRev(flags.sha) : "HEAD";
    const msg = sh(`git log -1 --pretty=%B ${rev}`);
    if (msg.status !== 0) return fail(EXIT_CODES.ENV, `cannot read commit message for ${rev}`);
    const verdict = hasSkipCi(msg.stdout);
    const result = {
      ok: verdict.effective,
      gate: "skip-ci",
      reasons: verdict.effective
        ? []
        : [
            {
              code: verdict.present ? "SKIP_CI_INEFFECTIVE" : "SKIP_CI_ABSENT",
              message: verdict.present
                ? `marker ${verdict.marker} sits on the ${verdict.location}; only the first or last line counts`
                : "commit message carries no [skip ci] marker",
            },
          ],
      warnings: [],
      hint: verdict.effective ? null : "put [skip ci] on the first or last line of the message",
      verdict,
    };
    return emit({
      subcommand: sub,
      ok: result.ok,
      result,
      problems: result.reasons,
      lines: [`gate skip-ci: ${result.ok ? "PASS" : "FAIL"}`, ...result.reasons.map((r) => `  ✗ ${r.message}`)],
      json,
    });
  }

  const prNumber = requireNumber(flags.pr, "--pr");

  if (which === "budget") {
    const phase = CONDUCTOR_PHASES.find((p) => p.id === flags.phase);
    if (!phase) return fail(EXIT_CODES.USAGE, `--phase must be one of: ${CONDUCTOR_PHASES.map((p) => p.id).join(", ")}`);
    // The base the pull request merges into; the trunk when gh cannot say.
    let baseRef = flags.trunk;
    const view = run(["gh", "pr", "view", String(prNumber), "--json", "baseRefName"]);
    if (view.status === 0) {
      try {
        const name = JSON.parse(view.stdout).baseRefName;
        if (typeof name === "string" && name !== "") baseRef = name;
      } catch {
        // Fall back to the trunk: an unparseable answer is no answer.
      }
    }
    let maxAttempts;
    try {
      maxAttempts = resolveMaxAttempts(baseRefConfig(flags.remote, baseRef), phase.id);
    } catch (err) {
      // A cap that cannot be read must not become the default: a typo would
      // then raise or remove the limit without anyone noticing.
      return fail(EXIT_CODES.ENV, err.message);
    }
    const receipt = readReceipt(receiptPath(gitCommonDir(), prNumber), prNumber);
    const consecutiveFailures = receipt ? (summarizePhases(receipt)[phase.id]?.consecutive_failures ?? 0) : 0;
    const result = checkAttemptBudget({ phase: phase.id, consecutiveFailures, maxAttempts });
    return emit({
      subcommand: sub,
      ok: result.ok,
      result,
      problems: result.reasons,
      lines: [
        `gate budget: ${result.ok ? "PASS" : "FAIL"} (${phase.id}: ${consecutiveFailures} of ${maxAttempts} failed in a row)`,
        ...result.reasons.map((r) => `  ✗ ${r.message}`),
        ...(result.hint ? [`  → ${result.hint}`] : []),
      ],
      json,
    });
  }

  if (which === "local-attest") {
    const view = ghJson(`gh pr view ${prNumber} --json headRefOid`);
    const result = checkLocalAttestGate({
      branch: sh("git rev-parse --abbrev-ref HEAD").stdout.trim(),
      worktreeStatus: sh("git status --porcelain").stdout,
      localHead: sh("git rev-parse HEAD").stdout.trim(),
      prHeadOid: view.headRefOid,
      prNumber,
    });
    return emit({
      subcommand: sub,
      ok: result.ok,
      result,
      problems: result.reasons,
      lines: [`gate local-attest: ${result.ok ? "PASS" : "FAIL"}`, ...result.reasons.map((r) => `  ✗ ${r.message}`)],
      json,
    });
  }

  if (which === "merge") {
    const result = gatherMergeGate(prNumber);
    const summary = summarizeGates([result]);
    return emit({
      subcommand: sub,
      ok: summary.ok,
      result,
      problems: result.reasons,
      // Warnings print too. Under `enforcement: warn` every criteria finding
      // moves here, and that mode is the documented rollback switch — if the
      // findings only reached `--json`, warn mode would look identical to off.
      lines: [
        `gate merge: ${result.ok ? "PASS" : "FAIL"}`,
        ...result.reasons.map((r) => `  ✗ ${r.message}`),
        ...(result.warnings ?? []).map((w) => `  ⚠ ${w.message}`),
      ],
      json,
    });
  }

  return fail(EXIT_CODES.USAGE, `--gate must be one of: local-attest, merge, skip-ci, budget`);
}

// Run only when invoked as a CLI, not when imported by tests. When argv[1]
// names this bin but the guard still missed, exit 0 would read as a gate
// PASS — fail loudly instead.
const invokedDirect = invokedDirectly(import.meta.url);
if (invokedDirect) {
  main().catch((err) => fail(EXIT_CODES.ENV, err.message));
} else if (misfiredAs("dotbabel-pr-stack")) {
  fail(EXIT_CODES.ENV, "run-direct guard did not fire; refusing to exit 0 without running.");
}

// Re-exports for unit tests that want to drive the binary without spawning.
export { main, HELP };
