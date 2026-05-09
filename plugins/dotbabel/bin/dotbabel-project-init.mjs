#!/usr/bin/env node
/**
 * dotbabel-project-init — minimal scaffolder for cross-CLI project sync.
 *
 * Writes `.dotbabel.json`, `.claude/commands/.gitkeep`, `.claude/skills/.gitkeep`,
 * and a starter `CLAUDE.md` (with rule-floor markers) when missing. Distinct
 * from `dotbabel init` (which scaffolds the full spec-governance harness).
 *
 * Flags:
 *   --repo <path>   target repo root (default: cwd)
 *   --force         overwrite an existing `.dotbabel.json`
 *   --dry-run       report planned actions, do not mutate the filesystem
 *
 * Exits: 0 ok, 1 SCAFFOLD_CONFLICT or other ValidationError, 2 env error,
 * 64 usage error.
 */

import path from "node:path";
import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError, ValidationError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import { scaffoldProjectInit } from "../src/project-init-scaffold.mjs";

const META = {
  name: "dotbabel-project-init",
  synopsis: "dotbabel-project-init [OPTIONS]",
  description:
    "Scaffold the minimum cross-CLI project-sync layout (.dotbabel.json + .claude/ skeleton + starter CLAUDE.md) into a repo.",
  flags: {
    repo: { type: "string" },
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
  const result = scaffoldProjectInit({
    repoRoot,
    force: Boolean(argv.flags.force),
    dryRun: Boolean(argv.flags["dry-run"]),
  });
  out.pass(
    `project-init complete in ${repoRoot} (${result.filesWritten.length} written, ${result.skipped.length} skipped)`,
  );
  if (argv.verbose || result.filesWritten.length > 0) {
    for (const f of result.filesWritten) out.info(`  + ${f}`);
    for (const s of result.skipped) out.info(`  - ${s} (already present)`);
  }
  out.flush();
  process.exit(EXIT_CODES.OK);
} catch (err) {
  if (err instanceof ValidationError) {
    out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON());
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.fail(`project-init failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}
