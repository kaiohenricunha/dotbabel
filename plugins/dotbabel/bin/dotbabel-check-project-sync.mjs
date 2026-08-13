#!/usr/bin/env node
/**
 * dotbabel-check-project-sync — read-only drift report for project-scope sync.
 *
 * Walks the same intended outputs as `dotbabel project-sync` and reports each
 * as ok / missing / stale. CI-safe: never mutates the filesystem.
 *
 * Flags:
 *   --repo <path>   target repo root (default: cwd)
 *   --all           inspect every fan_out CLI even when its binary is missing
 *                   on PATH (mirrors `dotbabel project-sync --all`)
 *
 * By default a CLI absent from PATH is skipped, matching what `project-sync`
 * did when it declined to write that CLI's symlinks.
 *
 * Exits: 0 ok, 1 drift detected, 2 env error, 64 usage error.
 */

import path from "node:path";
import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError, ValidationError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import { checkProjectSync } from "../src/check-project-sync.mjs";

const META = {
  name: "dotbabel-check-project-sync",
  synopsis: "dotbabel-check-project-sync [OPTIONS]",
  description:
    "Verify a repo's cross-CLI project-sync wiring (instruction files + symlinks) matches what `dotbabel project-sync` would produce. Read-only. CLIs missing from PATH are skipped unless --all is passed.",
  flags: {
    repo: { type: "string" },
    all: { type: "boolean" },
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

const out = createOutput({ json: argv.json, noColor: argv.noColor });

const repoRoot = path.resolve(/** @type {string} */ (argv.flags.repo ?? process.cwd()));

try {
  const result = await checkProjectSync({
    repoRoot,
    allCli: Boolean(argv.flags.all),
    json: argv.json,
    noColor: argv.noColor,
    out,
  });
  if (!result.ok) {
    out.fail(`project-sync drift: ${result.missing.length} missing, ${result.stale.length} stale`);
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }
  const skippedNote = result.skipped.length > 0 ? `, ${result.skipped.length} CLIs skipped` : "";
  out.pass(`project-sync ok (${result.okEntries.length} entries verified${skippedNote})`);
  out.flush();
  process.exit(EXIT_CODES.OK);
} catch (err) {
  if (err instanceof ValidationError) {
    out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON());
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.fail(`check-project-sync failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}
