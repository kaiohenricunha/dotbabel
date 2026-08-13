#!/usr/bin/env node
/**
 * dotbabel-local-attest — local CI attestation skill.
 *
 * Run the configured CI matrix locally; on a clean pass, post a SHA-pinned
 * OWNER-authored PR comment that gates the remote pipeline off for that
 * exact commit. A new push changes the SHA, the attestation stops matching,
 * and CI runs again. Saves the cost of double-running every check on
 * GitHub-hosted runners after a maintainer has already verified locally.
 *
 * Usage:
 *   dotbabel local-attest [--pr <N>] [--no-push] [--dry-run] [--fail-fast]
 *                         [--only <leg>] [--from <leg>] [--config <path>]
 *
 *   --pr <N>           Target PR number. Defaults to the open PR for the current branch.
 *   --no-push          Run the matrix + post comment + apply label, but do not `git push`.
 *   --dry-run          Run the matrix, render the comment, print it. Post nothing, label
 *                      nothing, push nothing. Use this to verify a new project's config.
 *   --fail-fast        Stop launching legs after the first hard failure; unstarted legs
 *                      are recorded not-run and the run can no longer attest.
 *   --only <leg>       Diagnostic mode: run only the named leg(s), with relaxed
 *                      preconditions (dirty tree fine, no PR needed). Never attests.
 *   --from <leg>       Diagnostic mode: run the matrix suffix starting at the named leg.
 *   --config <path>    Override the .local-attest config file location.
 *
 * Config discovery (when --config not given):
 *   .local-attest.config.mjs > .local-attest.config.json > package.json#local-attest
 *
 * See skills/local-attest/SKILL.md for the full operator contract, and
 * skills/local-attest/references/config.md for the config schema.
 *
 * Exits:
 *   0   PASS or successful --dry-run
 *   1   hard leg failed, precondition failed, or push failed (nothing posted)
 *   2   environment error (config unreadable, gh missing, etc.)
 *   64  bad CLI invocation (unknown flag, malformed --pr)
 */

import { fileURLToPath } from "node:url";
import { invokedDirectly } from "../src/lib/invoked-direct.mjs";

import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { parseArgs } from "../src/local-attest-lib.mjs";
import { ConfigError, loadConfig } from "../src/local-attest-config.mjs";
import { PreconditionError, execute, realDeps } from "../src/local-attest-runner.mjs";

const HELP = `dotbabel-local-attest [--pr <N>] [--no-push] [--dry-run] [--fail-fast]
                      [--only <leg>] [--from <leg>] [--config <path>]

Run the configured CI matrix locally and, on a clean pass, post an attestation
comment to the open PR so the remote pipeline skips itself for this commit.

Options:
  --pr <N>           Target PR number (defaults to the open PR for the branch)
  --no-push          Do not run \`git push\` after attesting
  --dry-run          Print the comment that would be posted; post nothing
  --fail-fast        Stop launching legs after the first hard failure. A
                     fail-fast run that stopped early can never attest; one
                     where nothing failed completed the full matrix and can.
  --only <leg>       Diagnostic mode: run only the named leg(s). Repeatable,
                     or comma-separated. Relaxed preconditions (dirty tree
                     fine, no PR needed); never posts, labels, or pushes.
  --from <leg>       Diagnostic mode: run the matrix from the named leg to the
                     end. Same rules as --only; mutually exclusive with it.
  --config <path>    Override the .local-attest config file location
  --help, -h         Show this help
  --version, -V      Show version

Config discovery (in order, when --config not given):
  .local-attest.config.mjs
  .local-attest.config.json
  package.json#local-attest

Every run whose matrix executes appends one line to the audit log
(config.auditLogPath), tagged result: attested | hard-fail | head-moved |
push-fail | post-fail | dry-run | diagnostic — failures leave a record too.

Exit codes: 0 ok, 1 attestation/leg failure, 2 env error, 64 usage error.`;

function fail(code, msg) {
  if (msg) process.stderr.write(`dotbabel-local-attest: ${msg}\n`);
  process.exit(code);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
    const { version } = await import("../src/index.mjs");
    process.stdout.write(`${version}\n`);
    process.exit(EXIT_CODES.OK);
  }

  /** @type {ReturnType<typeof parseArgs>} */
  let argv;
  try {
    argv = parseArgs(rawArgs);
  } catch (err) {
    const code = /** @type {any} */ (err).exitCode ?? EXIT_CODES.USAGE;
    fail(code, err.message);
    return;
  }

  if (argv.help) {
    process.stdout.write(HELP + "\n");
    process.exit(EXIT_CODES.OK);
  }

  /** @type {import("../src/local-attest-config.mjs").Config} */
  let cfg;
  try {
    cfg = await loadConfig({ cwd: process.cwd(), override: argv.config });
  } catch (err) {
    if (err instanceof ConfigError) {
      const hint = /** @type {any} */ (err).hint;
      fail(EXIT_CODES.ENV, hint ? `${err.message}\n  hint: ${hint}` : err.message);
    } else {
      fail(EXIT_CODES.ENV, `config load failed: ${err.message}`);
    }
    return;
  }

  const deps = realDeps();
  try {
    const result = await execute(deps, cfg, {
      prOverride: argv.pr,
      push: argv.push,
      dryRun: argv.dryRun,
      only: argv.only,
      from: argv.from,
      failFast: argv.failFast,
    });
    process.exit(result.exitCode);
  } catch (err) {
    if (err instanceof PreconditionError) {
      fail(1, err.message);
    } else if (/** @type {any} */ (err).code === "USAGE") {
      // filterMatrix throws usage errors (unknown --only/--from leg name).
      fail(/** @type {any} */ (err).exitCode ?? EXIT_CODES.USAGE, err.message);
    } else {
      fail(2, err.message);
    }
  }
}

// Run only when invoked as a CLI, not when imported by tests.
const invokedDirect = invokedDirectly(import.meta.url);
if (invokedDirect) {
  main().catch((err) => fail(2, err.message));
}

// Re-exports for unit tests that want to drive the binary's `main` without spawning.
export { main, HELP };
