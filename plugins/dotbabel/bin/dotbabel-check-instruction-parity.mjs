#!/usr/bin/env node
/**
 * dotbabel-check-instruction-parity — verifies generated cross-CLI instruction
 * files preserve all headings that apply to each CLI target.
 *
 * Exits: 0 parity ok, 1 parity drift, 2 env error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError } from "../src/lib/errors.mjs";
import {
  createHarnessContext,
  checkInstructionParity,
  version,
} from "../src/index.mjs";

const META = {
  name: "dotbabel-check-instruction-parity",
  synopsis: "dotbabel-check-instruction-parity [OPTIONS]",
  description:
    "Verify generated cross-CLI instruction outputs preserve applicable headings.",
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
  result = checkInstructionParity(ctx);
} catch (err) {
  out.fail(`instruction parity check failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

if (result.ok) {
  out.pass("generated instruction headings have parity");
  out.flush();
  process.exit(EXIT_CODES.OK);
}

for (const err of result.errors) {
  out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
}
out.flush();
process.exit(EXIT_CODES.VALIDATION);
