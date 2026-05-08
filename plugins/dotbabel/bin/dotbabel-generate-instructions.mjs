#!/usr/bin/env node
/**
 * dotbabel-generate-instructions — fan-out CLAUDE.md into per-CLI rule files.
 *
 * Reads the canonical `CLAUDE.md`, applies `<!-- dotbabel:cli ... -->` span
 * filtering and substitutions from `docs/repo-facts.json:cli_substitutions`,
 * and writes:
 *
 *   AGENTS.md                                              (Copilot+Codex project)
 *   GEMINI.md                                              (Gemini project)
 *   plugins/dotbabel/templates/cli-instructions/copilot-instructions.md
 *   plugins/dotbabel/templates/cli-instructions/codex-AGENTS.md
 *   plugins/dotbabel/templates/cli-instructions/gemini-GEMINI.md
 *   plugins/dotbabel/templates/cli-instructions/.manifest.json
 *
 * Exits: 0 ok, 1 generation error, 2 env error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError } from "../src/lib/errors.mjs";
import {
  createHarnessContext,
  version,
} from "../src/index.mjs";
import { generateInstructions } from "../src/generate-instructions.mjs";

const META = {
  name: "dotbabel-generate-instructions",
  synopsis: "dotbabel-generate-instructions [OPTIONS]",
  description:
    "Fan out CLAUDE.md into AGENTS.md / GEMINI.md and per-CLI user-scope instruction files.",
  flags: {
    "repo-root": { type: "string" },
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

let ctx;
try {
  ctx = createHarnessContext({ repoRoot: argv.flags["repo-root"] });
} catch (err) {
  out.fail(`could not resolve repo root: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

const dryRun = Boolean(argv.flags["dry-run"]);

let result;
try {
  result = generateInstructions(ctx, { dryRun });
} catch (err) {
  out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON ? err.toJSON() : undefined);
  out.flush();
  process.exit(EXIT_CODES.VALIDATION);
}

for (const file of result.files) {
  out.pass(`${dryRun ? "rendered" : "wrote"} ${file.path}`);
}
out.flush();
process.exit(EXIT_CODES.OK);
