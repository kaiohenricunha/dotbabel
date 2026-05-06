#!/usr/bin/env node
/**
 * dotclaude-check-instruction-drift — cross-references `docs/repo-facts.json`
 * against instruction files (CLAUDE.md, README.md, …) to catch stale
 * team_count claims, missing protected-path documentation, and broken
 * instruction-file references.
 *
 * Exits: 0 no drift, 1 drift detected, 2 env error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import {
  createHarnessContext,
  checkInstructionDrift,
} from "../src/index.mjs";

const META = {
  name: "dotclaude-check-instruction-drift",
  synopsis: "dotclaude-check-instruction-drift [OPTIONS]",
  description: "Detect drift between docs/repo-facts.json and instruction files (team_count, protected_paths, instruction_files).",
  flags: {
    "repo-root": { type: "string" },
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

let ctx;
try {
  ctx = createHarnessContext({ repoRoot: argv.flags["repo-root"] });
} catch (err) {
  out.fail(`could not resolve repo root: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

let result;
try {
  result = checkInstructionDrift(ctx);
} catch (err) {
  out.fail(`drift check failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

if (result.ok) {
  out.pass("instruction files match repo facts");
  out.flush();
  process.exit(EXIT_CODES.OK);
}

for (const err of result.errors) {
  out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
}
out.flush();
process.exit(EXIT_CODES.VALIDATION);
