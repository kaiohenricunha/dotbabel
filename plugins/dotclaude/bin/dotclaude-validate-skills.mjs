#!/usr/bin/env node
/**
 * dotclaude-validate-skills — validates `.claude/skills-manifest.json` against
 * the sha256 checksums recorded for every indexed skill/command, and flags
 * orphan files on disk + dependency cycles.
 *
 * Exits: 0 manifest valid, 1 one or more violations, 2 env error, 64 usage
 * error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import {
  createHarnessContext,
  validateManifest,
  refreshChecksums,
} from "../src/index.mjs";

const META = {
  name: "dotclaude-validate-skills",
  synopsis: "dotclaude-validate-skills [OPTIONS]",
  description: "Validate .claude/skills-manifest.json checksums, orphans, and DAG. Use --update to rewrite checksums in place.",
  flags: {
    "repo-root": { type: "string" },
    update: { type: "boolean" },
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

if (argv.flags.update) {
  try {
    refreshChecksums(ctx);
    out.pass(`manifest refreshed at ${ctx.manifestPath}`);
    out.flush();
    process.exit(EXIT_CODES.OK);
  } catch (err) {
    out.fail(`refresh failed: ${err.message}`);
    out.flush();
    process.exit(EXIT_CODES.ENV);
  }
}

let result;
try {
  result = validateManifest(ctx);
} catch (err) {
  out.fail(err.message);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

if (result.ok) {
  out.pass(`manifest valid (${result.manifest.skills.length} skills)`);
  out.flush();
  process.exit(EXIT_CODES.OK);
}

for (const err of result.errors) {
  out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
}
out.flush();
process.exit(EXIT_CODES.VALIDATION);
