#!/usr/bin/env node
/**
 * dotbabel-init — scaffold the harness template tree into a target repository.
 *
 * Flags:
 *   --project-name <name>    defaults to basename(cwd)
 *   --project-type <type>    defaults to "unknown"
 *   --force                  overwrite an already-initialized repo
 *   --target-dir <path>      scaffolding destination (defaults to cwd)
 *
 * Exits: 0 scaffold complete, 1 ValidationError (SCAFFOLD_CONFLICT), 2 env
 * error, 64 usage error.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { formatError, ValidationError } from "../src/lib/errors.mjs";
import { version } from "../src/index.mjs";
import { scaffoldHarness } from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const META = {
  name: "dotbabel-init",
  synopsis: "dotbabel-init [OPTIONS]",
  description: "Scaffold the harness template tree (.claude/, docs/, .github/workflows/, githooks/) into the current repo.",
  flags: {
    "project-name": { type: "string" },
    "project-type": { type: "string" },
    "target-dir": { type: "string" },
    force: { type: "boolean" },
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

const targetDir = /** @type {string} */ (argv.flags["target-dir"] ?? process.cwd());
const projectName = /** @type {string} */ (argv.flags["project-name"] ?? path.basename(targetDir));
const projectType = /** @type {string} */ (argv.flags["project-type"] ?? "unknown");
const force = Boolean(argv.flags.force);

const templatesDir = path.resolve(__dirname, "..", "templates");
const today = new Date().toISOString().slice(0, 10);

try {
  const { filesWritten } = scaffoldHarness(
    {
      templatesDir,
      targetDir,
      placeholders: { project_name: projectName, project_type: projectType, today },
    },
    { force }
  );
  out.pass(`harness initialized in ${targetDir} (${filesWritten.length} files)`);
  if (argv.verbose) {
    for (const f of filesWritten) out.info(`  ${f}`);
  }
  out.flush();
  process.exit(EXIT_CODES.OK);
} catch (err) {
  if (err instanceof ValidationError) {
    out.fail(formatError(err, { verbose: argv.verbose }), err.toJSON());
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.fail(`scaffold failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}
