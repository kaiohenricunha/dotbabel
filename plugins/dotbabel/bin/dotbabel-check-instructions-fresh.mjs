#!/usr/bin/env node
/**
 * dotbabel-check-instructions-fresh — verifies generated cross-CLI instruction
 * files match a fresh render from CLAUDE.md.
 *
 * Exits: 0 fresh, 1 stale/missing output, 2 env error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError } from "../src/lib/errors.mjs";
import {
  createHarnessContext,
  checkInstructionsFresh,
  version,
} from "../src/index.mjs";

const META = {
  name: "dotbabel-check-instructions-fresh",
  synopsis: "dotbabel-check-instructions-fresh [OPTIONS]",
  description:
    "Verify generated AGENTS.md / GEMINI.md / per-CLI templates match CLAUDE.md.",
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
  result = checkInstructionsFresh(ctx);
} catch (err) {
  out.fail(`freshness check failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

if (result.ok) {
  out.pass("generated instruction files are fresh");
  out.flush();
  process.exit(EXIT_CODES.OK);
}

for (const err of result.errors) {
  out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
}
out.flush();
process.exit(EXIT_CODES.VALIDATION);
