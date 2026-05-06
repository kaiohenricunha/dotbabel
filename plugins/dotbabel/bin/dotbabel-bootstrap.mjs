#!/usr/bin/env node
/**
 * dotbabel-bootstrap — set up or refresh ~/.claude/.
 *
 * Symlinks commands/, skills/, CLAUDE.md, and copies agent templates into place.
 * Idempotent — safe to re-run.
 *
 * Flags:
 *   --source <path>      Path to a local dotbabel git clone. Overrides DOTBABEL_DIR.
 *   --target <dir>       Override destination directory. Default: ~/.claude
 *   --quiet              Suppress per-file progress; print summary only.
 *   --json               Emit a JSON array of events on stdout.
 *   --no-color           Suppress ANSI colour.
 *   --help / -h
 *   --version / -V
 *
 * Exits: 0 bootstrap complete, 1 validation error, 2 env error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import { bootstrapGlobal } from "../src/bootstrap-global.mjs";

const META = {
  name: "dotbabel-bootstrap",
  synopsis: "dotbabel-bootstrap [OPTIONS]",
  description: "Set up (or refresh) ~/.claude/ by symlinking commands/, skills/, CLAUDE.md, and copying agent templates into place. Idempotent — safe to re-run.",
  flags: {
    source: { type: "string" },
    target: { type: "string" },
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

// Windows symlink check
if (process.platform === "win32") {
  const out = createOutput({ json: argv.json, noColor: argv.noColor });
  out.fail("bootstrap is not supported on Windows (symlinks require elevated permissions).\n  Use WSL or run bootstrap.sh from Git Bash.");
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

const out = createOutput({ json: argv.json, noColor: argv.noColor });

const source = /** @type {string|undefined} */ (argv.flags.source);
const target = /** @type {string|undefined} */ (argv.flags.target);
const quiet = Boolean(argv.flags.quiet);

try {
  const result = await bootstrapGlobal({
    source,
    target,
    quiet,
    json: argv.json,
    noColor: argv.noColor,
  });

  if (result.ok) {
    out.pass(`bootstrap complete — linked: ${result.linked}, skipped: ${result.skipped}, backed_up: ${result.backed_up}`);
    out.flush();
    process.exit(EXIT_CODES.OK);
  } else {
    out.fail("bootstrap failed");
    out.flush();
    process.exit(EXIT_CODES.ENV);
  }
} catch (err) {
  out.fail(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}
