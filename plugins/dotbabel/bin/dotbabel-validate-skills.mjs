#!/usr/bin/env node
/**
 * dotbabel-validate-skills — validates `.claude/skills-manifest.json` against
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
import { resolve } from "node:path";
import {
  createHarnessContext,
  validateManifest,
  refreshChecksums,
  validateAgents,
  validateAgentTriggerOverlap,
} from "../src/index.mjs";

const META = {
  name: "dotbabel-validate-skills",
  synopsis: "dotbabel-validate-skills [OPTIONS]",
  description: "Validate .claude/skills-manifest.json checksums, orphans, and DAG. Also runs agent frontmatter validation and trigger-overlap detection. Use --update to rewrite checksums in place. Use --strict to promote agent overlap warnings to errors.",
  flags: {
    "repo-root": { type: "string" },
    update: { type: "boolean" },
    strict: { type: "boolean" },
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
} else {
  for (const err of result.errors) {
    out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
  }
}

// --- agents validation ---
const agentsDir = resolve(ctx.repoRoot, "plugins", "dotbabel", "templates", "claude");
let agentsResult;
try {
  agentsResult = validateAgents(agentsDir);
} catch (err) {
  out.fail(`agents validation failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

if (agentsResult.ok && agentsResult.warnings.length === 0) {
  out.pass(`agents valid (${agentsResult.errors.length === 0 ? "no errors" : ""})`);
} else {
  if (agentsResult.ok) {
    out.pass(`agents valid (warnings: ${agentsResult.warnings.length})`);
  }
  for (const err of agentsResult.errors) {
    out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
  }
}
for (const warn of agentsResult.warnings) {
  out.warn(formatError(warn, { verbose: argv.verbose }), warn.toJSON ? warn.toJSON() : undefined);
}

// --- agent trigger-overlap detection (advisory by default) ---
let overlapResult;
try {
  overlapResult = validateAgentTriggerOverlap(agentsDir);
} catch (err) {
  out.fail(`agent trigger-overlap check failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

if (overlapResult.warnings.length === 0) {
  out.pass(`agent triggers: no overlap detected`);
} else {
  for (const warn of overlapResult.warnings) {
    if (argv.flags.strict) {
      out.fail(formatError(warn, { verbose: argv.verbose }), warn.toJSON ? warn.toJSON() : undefined);
    } else {
      out.warn(formatError(warn, { verbose: argv.verbose }), warn.toJSON ? warn.toJSON() : undefined);
    }
  }
}

out.flush();
const overlapFailed = argv.flags.strict && overlapResult.warnings.length > 0;
const hasErrors = !result.ok || !agentsResult.ok || overlapFailed;
process.exit(hasErrors ? EXIT_CODES.VALIDATION : EXIT_CODES.OK);
