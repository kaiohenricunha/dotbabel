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
import { pathToFileURL } from "node:url";

import { parse } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { buildStackGraph, planStack, planChildTransition } from "../src/pr-stack.mjs";
import {
  CONDUCTOR_PHASES,
  checkLocalAttestGate,
  checkMergeGate,
  hasSkipCi,
  summarizeGates,
} from "../src/pr-gates.mjs";

const TOOL = "dotbabel-pr-stack";

const PR_FIELDS = "number,headRefName,baseRefName,state,mergeStateStatus,headRefOid";

const SUBCOMMANDS = new Set(["graph", "plan", "next", "gate", "phases"]);

const FLAGS = {
  trunk: { type: "string", default: "main" },
  limit: { type: "string", default: "100" },
  pr: { type: "string" },
  parent: { type: "string" },
  "parent-sha": { type: "string" },
  remote: { type: "string", default: "origin" },
  gate: { type: "string" },
  sha: { type: "string" },
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

Options:
  --trunk <ref>      Trunk branch name (default: main)
  --limit <N>        Max PRs to enumerate (default: 100)
  --pr <N>           PR number (required by: next, gate)
  --parent <N>       Parent PR number (required by: next)
  --parent-sha <sha> Parent head SHA captured before merging (recommended for: next)
  --remote <name>    Git remote name (default: origin)
  --gate <name>      Gate to evaluate: local-attest | merge | skip-ci
  --sha <rev>        Commit to inspect for --gate skip-ci (default: HEAD)
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
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
  if (!Number.isInteger(n) || n <= 0)
    return fail(EXIT_CODES.USAGE, `${flag} must be a positive integer`);
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
  const lines = [
    `stack on ${plan.trunk}: ${plan.counts.total} PR(s), merge order ${plan.order.join(" → ") || "—"}`,
  ];
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
    for (const warning of transition.warnings)
      process.stderr.write(`${TOOL}: warning: ${warning}\n`);

    return emit({
      subcommand: sub,
      ok: true,
      trunk: flags.trunk,
      result: transition,
      lines: [
        `#${transition.number}: ${transition.reason}`,
        ...transition.steps.map((s) => `  ${s.cmd}`),
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
      hint: verdict.effective ? null : "put [skip ci] on the first or last line of the message",
      verdict,
    };
    return emit({
      subcommand: sub,
      ok: result.ok,
      result,
      problems: result.reasons,
      lines: [
        `gate skip-ci: ${result.ok ? "PASS" : "FAIL"}`,
        ...result.reasons.map((r) => `  ✗ ${r.message}`),
      ],
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
      lines: [
        `gate local-attest: ${result.ok ? "PASS" : "FAIL"}`,
        ...result.reasons.map((r) => `  ✗ ${r.message}`),
      ],
      json,
    });
  }

  if (which === "merge") {
    const root = repoRoot();
    const view = ghJson(`gh pr view ${prNumber} --json body,mergeable,mergeStateStatus,files`);
    const result = checkMergeGate({
      body: view.body,
      hasSpecsDir: existsSync(`${root}/docs/specs`),
      changedPaths: (view.files ?? []).map((f) => f.path),
      protectedPaths: protectedPaths(root),
      mergeable: view.mergeable,
      mergeStateStatus: view.mergeStateStatus,
    });
    const summary = summarizeGates([result]);
    return emit({
      subcommand: sub,
      ok: summary.ok,
      result,
      problems: result.reasons,
      lines: [
        `gate merge: ${result.ok ? "PASS" : "FAIL"}`,
        ...result.reasons.map((r) => `  ✗ ${r.message}`),
      ],
      json,
    });
  }

  return fail(EXIT_CODES.USAGE, `--gate must be one of: local-attest, merge, skip-ci`);
}

// Run only when invoked as a CLI, not when imported by tests.
const invokedDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirect) {
  main().catch((err) => fail(EXIT_CODES.ENV, err.message));
}

// Re-exports for unit tests that want to drive the binary without spawning.
export { main, HELP };
