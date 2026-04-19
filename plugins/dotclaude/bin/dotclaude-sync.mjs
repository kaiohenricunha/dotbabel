#!/usr/bin/env node
/**
 * dotclaude-sync — pull, push, or show status for a dotclaude installation.
 *
 * Subcommands:
 *   pull     Fetch the latest dotclaude version and re-bootstrap ~/.claude/.
 *   status   Show the current version / git status.
 *   push     Commit and push local changes (clone mode only).
 *
 * Options:
 *   --source <path>   Path to a local dotclaude git clone. Activates clone mode.
 *   --quiet           Suppress per-file progress; print summary only.
 *   --json            Emit a JSON array of events on stdout.
 *   --no-color        Suppress ANSI colour.
 *   --help / -h
 *   --version / -V
 *
 * Exits: 0 ok, 1 sync error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import { syncGlobal } from "../src/sync-global.mjs";

const VALID_SUBCOMMANDS = ["pull", "status", "push"];

const META = {
  name: "dotclaude-sync",
  synopsis: "dotclaude-sync <subcommand> [OPTIONS]",
  description: "Pull, push, or show status for a dotclaude installation. Subcommands: pull, status, push.",
  flags: {
    source: { type: "string" },
    quiet: { type: "boolean" },
  },
};

let argv;
try {
  argv = parse(process.argv.slice(2), META.flags);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(EXIT_CODES.USAGE);
}

if (argv.help) {
  process.stdout.write(`${helpText(META)}\n`);
  process.exit(EXIT_CODES.OK);
}
if (argv.version) {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

const subcommand = argv.positional[0];

if (!subcommand) {
  process.stderr.write(`${META.synopsis}\n\nNo subcommand provided. Valid subcommands: ${VALID_SUBCOMMANDS.join(", ")}\n`);
  process.exit(EXIT_CODES.USAGE);
}

if (!VALID_SUBCOMMANDS.includes(subcommand)) {
  process.stderr.write(`Unknown subcommand: ${subcommand}\nValid subcommands: ${VALID_SUBCOMMANDS.join(", ")}\n`);
  process.exit(EXIT_CODES.USAGE);
}

const source = /** @type {string|undefined} */ (argv.flags.source);
const quiet = Boolean(argv.flags.quiet);

try {
  const result = await syncGlobal(subcommand, {
    source,
    quiet,
    json: argv.json,
    noColor: argv.noColor,
  });

  process.exit(result.ok ? EXIT_CODES.OK : EXIT_CODES.VALIDATION);
} catch (err) {
  process.stderr.write(`sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(EXIT_CODES.VALIDATION);
}
