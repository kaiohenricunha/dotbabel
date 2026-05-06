#!/usr/bin/env node
/**
 * dotclaude-validate-specs — validates every `docs/specs/<id>/spec.json` in the
 * repo against the structured-error contract from `validate-specs.mjs`.
 *
 * Exits: 0 all specs valid, 1 one or more validation failures, 2 env error,
 * 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import {
  createHarnessContext,
  listSpecDirs,
  validateSpecs,
} from "../src/index.mjs";

const META = {
  name: "dotclaude-validate-specs",
  synopsis: "dotclaude-validate-specs [OPTIONS]",
  description: "Validate every spec.json under docs/specs/ against the StructuredError contract.",
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

const result = validateSpecs(ctx);
if (result.ok) {
  const count = listSpecDirs(ctx).length;
  out.pass(`${count} spec(s) valid`);
  out.flush();
  process.exit(EXIT_CODES.OK);
}

for (const err of result.errors) {
  out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
}
out.flush();
process.exit(EXIT_CODES.VALIDATION);
