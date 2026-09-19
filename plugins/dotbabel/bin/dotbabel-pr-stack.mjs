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
 *   dotbabel pr-stack phases
 *   dotbabel pr-stack entry   [--pr <N>]
 *   dotbabel pr-stack review-complete --pr <N> [--dry-run]
 *
 * `next` prints the commands to run; it never executes them. A rebase after a
 * squash-merge needs `--onto`, so the parent's pre-merge head SHA matters —
 * capture it BEFORE merging, since `--delete-branch` may remove the ref.
 *
 * Exits:
 *   0   ok (plan clean, gate passed)
 *   1   gate failed, or the stack has a structural problem needing a human
 *   2   environment error (gh missing/unauthenticated, not a git repo)
 *   64  bad CLI invocation (unknown flag/subcommand, malformed --pr)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { invokedDirectly, misfiredAs } from "../src/lib/invoked-direct.mjs";

import { parse } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { buildStackGraph, planStack, planChildTransition } from "../src/pr-stack.mjs";
import {
  CONDUCTOR_PHASES,
  checkLocalAttestGate,
  checkMergeGate,
  deriveEntryPhase,
  hasSkipCi,
  summarizeGates,
} from "../src/pr-gates.mjs";
import { GIT_MAX_BUFFER } from "../src/lib/limits.mjs";
import { criteriaGateInputs, prComments } from "../src/criteria/gate-inputs.mjs";
import { attestationGateInputs } from "../src/attestation-gate-inputs.mjs";
import { reviewEntryFacts } from "../src/review-gate-inputs.mjs";
import { postReviewComplete } from "../src/review-complete.mjs";

const TOOL = "dotbabel-pr-stack";

const PR_FIELDS = "number,headRefName,baseRefName,state,mergeStateStatus,headRefOid";

const SUBCOMMANDS = new Set(["graph", "plan", "next", "gate", "phases", "entry", "review-complete"]);

const FLAGS = {
  trunk: { type: "string", default: "main" },
  limit: { type: "string", default: "100" },
  pr: { type: "string" },
  parent: { type: "string" },
  "parent-sha": { type: "string" },
  remote: { type: "string", default: "origin" },
  gate: { type: "string" },
  sha: { type: "string" },
  "dry-run": { type: "boolean" },
};

const HELP = `${TOOL} <subcommand> [options]

Reason about stacked pull requests: dependency graph, merge order, and the
exact commands a child PR needs once its parent has merged.

Subcommands:
  graph              Print the raw dependency graph
  plan               Print what can land now, what is blocked, and any problems
  next               Print the commands to move a child PR after its parent merged
  gate               Evaluate a precondition gate (local-attest | merge | skip-ci)
  phases             Print the canonical pipeline phase order
  entry              Print the phase the conductor should start at for this branch
  review-complete    Post the SHA-pinned marker that the review stage finished on the head

Options:
  --trunk <ref>      Trunk branch name (default: main)
  --limit <N>        Max PRs to enumerate (default: 100)
  --pr <N>           PR number (required by: next, gate, review-complete; optional for entry)
  --parent <N>       Parent PR number (required by: next)
  --parent-sha <sha> Parent head SHA captured before merging (recommended for: next)
  --remote <name>    Git remote name (default: origin)
  --gate <name>      Gate to evaluate: local-attest | merge | skip-ci
  --sha <rev>        Commit to inspect for --gate skip-ci (default: HEAD)
  --dry-run          review-complete: check and print the comment, post nothing
  --json             Emit a single JSON object on stdout
  --help, -h         Show this help
  --version, -V      Show version

Exit codes: 0 ok, 1 gate failed or structural problem, 2 env error, 64 usage error.`;

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

  return fail(EXIT_CODES.USAGE, `--gate must be one of: local-attest, merge, skip-ci`);
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
