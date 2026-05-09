#!/usr/bin/env node
/**
 * dotbabel-project-sync — repo-local fan-out of CLAUDE.md, .claude/commands,
 * and .claude/skills into Codex / Gemini / Copilot project-scope analogues.
 *
 * Flags:
 *   --repo <path>   target repo root (default: cwd)
 *   --all           force fan-out even when a CLI binary is missing on PATH
 *   --force         reserved (not yet acted upon — see plan §1.4)
 *   --dry-run       report planned actions, do not mutate the filesystem
 *
 * Exits: 0 ok, 1 validation failure, 2 env error, 64 usage error.
 */

import path from "node:path";
import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError, ValidationError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import { projectSync } from "../src/project-sync.mjs";

const META = {
  name: "dotbabel-project-sync",
  synopsis: "dotbabel-project-sync [OPTIONS]",
  description:
    "Fan out the current repo's CLAUDE.md, .claude/commands, and .claude/skills into Codex / Gemini / Copilot project-scope analogues.",
  flags: {
    repo: { type: "string" },
    all: { type: "boolean" },
    force: { type: "boolean" },
    "dry-run": { type: "boolean" },
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

const repoRoot = path.resolve(
  /** @type {string} */ (argv.flags.repo ?? process.cwd()),
);

try {
  const result = await projectSync({
    repoRoot,
    allCli: Boolean(argv.flags.all),
    force: Boolean(argv.flags.force),
    dryRun: Boolean(argv.flags["dry-run"]),
    json: argv.json,
    noColor: argv.noColor,
    out,
  });
  if (!result.ok) {
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }
  process.exit(EXIT_CODES.OK);
} catch (err) {
  if (err instanceof ValidationError) {
    out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON());
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.fail(`project-sync failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}
