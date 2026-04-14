#!/usr/bin/env node
/**
 * Umbrella dispatcher. Usage:
 *
 *   dotclaude --version
 *   dotclaude --help
 *   dotclaude <subcommand> [args...]      # delegates to dotclaude-<subcommand>.mjs
 *
 * Known subcommands mirror the bin/* entries shipped by the package:
 *   validate-skills, validate-specs, check-spec-coverage,
 *   check-instruction-drift, detect-drift, doctor, init.
 *
 * Exits: 0 ok, 1 delegated failure, 2 env error, 64 usage error.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { version } from "../src/index.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";

const SUBCOMMANDS = [
  "validate-skills",
  "validate-specs",
  "check-spec-coverage",
  "check-instruction-drift",
  "detect-drift",
  "doctor",
  "init",
];

function printUsage() {
  process.stdout.write(
    [
      "dotclaude — structured-error-emitting CLI for @dotclaude/dotclaude",
      "",
      "Usage:",
      "  dotclaude <subcommand> [options]",
      "  dotclaude --version",
      "  dotclaude --help",
      "",
      "Subcommands:",
      ...SUBCOMMANDS.map((s) => `  ${s.padEnd(26)}runs dotclaude-${s}`),
      "",
      "Every subcommand also exists as a standalone bin (e.g. `npx dotclaude-doctor`).",
      "Each subcommand supports --help / --version / --json / --verbose / --no-color.",
      "",
      "Exit codes: 0 ok, 1 validation failure, 2 env error, 64 usage error.",
      "",
    ].join("\n")
  );
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  printUsage();
  process.exit(EXIT_CODES.OK);
}

if (args[0] === "--version" || args[0] === "-V") {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

const sub = args[0];
if (!SUBCOMMANDS.includes(sub)) {
  process.stderr.write(
    `dotclaude: unknown subcommand '${sub}'. Run 'dotclaude --help' for the list.\n`
  );
  process.exit(EXIT_CODES.USAGE);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, `dotclaude-${sub}.mjs`);
if (!existsSync(binPath)) {
  process.stderr.write(
    `dotclaude: bin 'dotclaude-${sub}' not found at ${binPath}. Did the package install correctly?\n`
  );
  process.exit(EXIT_CODES.ENV);
}

const child = spawn(process.execPath, [binPath, ...args.slice(1)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? EXIT_CODES.ENV);
});
