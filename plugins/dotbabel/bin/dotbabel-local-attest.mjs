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
 *   dotbabel local-attest [--pr <N>] [--no-push] [--dry-run] [--config <path>]
 *
 *   --pr <N>           Target PR number. Defaults to the open PR for the current branch.
 *   --no-push          Run the matrix + post comment + apply label, but do not `git push`.
 *   --dry-run          Run the matrix, render the comment, print it. Post nothing, label
 *                      nothing, push nothing. Use this to verify a new project's config.
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

import { fileURLToPath, pathToFileURL } from "node:url";

import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { parseArgs } from "../src/local-attest-lib.mjs";
import { ConfigError, loadConfig } from "../src/local-attest-config.mjs";
import { PreconditionError, execute, realDeps } from "../src/local-attest-runner.mjs";

const HELP = `dotbabel-local-attest [--pr <N>] [--no-push] [--dry-run] [--config <path>]

Run the configured CI matrix locally and, on a clean pass, post an attestation
comment to the open PR so the remote pipeline skips itself for this commit.

Options:
  --pr <N>           Target PR number (defaults to the open PR for the branch)
  --no-push          Do not run \`git push\` after attesting
  --dry-run          Print the comment that would be posted; post nothing
  --config <path>    Override the .local-attest config file location
  --help, -h         Show this help
  --version, -V      Show version

Config discovery (in order, when --config not given):
  .local-attest.config.mjs
  .local-attest.config.json
  package.json#local-attest

Exit codes: 0 ok, 1 attestation failure, 2 env error, 64 usage error.`;

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
    const result = execute(deps, cfg, {
      prOverride: argv.pr,
      push: argv.push,
      dryRun: argv.dryRun,
    });
    process.exit(result.exitCode);
  } catch (err) {
    if (err instanceof PreconditionError) {
      fail(1, err.message);
    } else {
      fail(2, err.message);
    }
  }
}

// Run only when invoked as a CLI, not when imported by tests.
const invokedDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirect) {
  main().catch((err) => fail(2, err.message));
}

// Re-exports for unit tests that want to drive the binary's `main` without spawning.
export { main, HELP };
