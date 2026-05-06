#!/usr/bin/env node
/**
 * dotclaude-check-spec-coverage — verifies that every change to a protected
 * path is covered by an approved/implementing/done spec, or the PR body
 * carries a `## No-spec rationale` section.
 *
 * Exits: 0 covered, 1 violation, 2 env error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import {
  createHarnessContext,
  checkSpecCoverage,
  getChangedFiles,
  getPullRequestContext,
} from "../src/index.mjs";

const META = {
  name: "dotclaude-check-spec-coverage",
  synopsis: "dotclaude-check-spec-coverage [OPTIONS]",
  description: "Check that protected-path changes are covered by a spec (or a No-spec rationale) in the current PR.",
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

const { isPullRequest, body, actor } = getPullRequestContext();
const changedFiles = getChangedFiles();

let result;
try {
  result = checkSpecCoverage(ctx, { changedFiles, isPullRequest, body, actor });
} catch (err) {
  out.fail(`coverage check failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

if (result.ok) {
  out.pass(`spec coverage ok (${result.protectedFiles.length} protected file(s) changed)`);
  out.flush();
  process.exit(EXIT_CODES.OK);
}

for (const err of result.errors) {
  out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
}
out.flush();
process.exit(EXIT_CODES.VALIDATION);
