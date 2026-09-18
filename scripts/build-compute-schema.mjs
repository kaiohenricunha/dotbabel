#!/usr/bin/env node
/**
 * build-compute-schema — write `schemas/dotbabel.compute.schema.json` from the
 * single authority in `plugins/dotbabel/src/model-intelligence/requirement/schema.mjs`.
 *
 * The declaration's enums and its mode-conditional rules live in `MODE_RULES`
 * and the domain vocabulary. This script renders them; `--check` verifies the
 * committed file still matches, so adding a runtime to the `RUNTIMES` registry
 * or a mode to `RESOLUTION_MODES` cannot leave the schema silently behind
 * (spec model-intelligence, §5; ARCH-58).
 *
 * Flags:
 *   --repo-root <path>   Override repo root (default: git rev-parse --show-toplevel).
 *   --check              Verify the on-disk schema matches what would be generated;
 *                        exit 1 if stale, 0 if fresh.
 *   --no-color           Suppress ANSI color.
 *   --help / -h
 *   --version / -V
 *
 * Exits: 0 ok, 1 stale (--check mode), 2 env error, 64 usage error.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, helpText } from "../plugins/dotbabel/src/lib/argv.mjs";
import { EXIT_CODES } from "../plugins/dotbabel/src/lib/exit-codes.mjs";
import { createOutput } from "../plugins/dotbabel/src/lib/output.mjs";
import { format } from "prettier";
import { buildComputeSchema } from "../plugins/dotbabel/src/model-intelligence/requirement/schema.mjs";

const TOOL_VERSION = "1.0.0";
const SCHEMA_RELATIVE = join("schemas", "dotbabel.compute.schema.json");

const META = {
  name: "build-compute-schema",
  synopsis: "build-compute-schema [OPTIONS]",
  description:
    "Generate schemas/dotbabel.compute.schema.json from the model-intelligence MODE_RULES table and domain vocabulary. Use --check to verify freshness without writing.",
  flags: {
    "repo-root": { type: "string" },
    check: { type: "boolean" },
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
  process.stdout.write(`${TOOL_VERSION}\n`);
  process.exit(EXIT_CODES.OK);
}

const out = createOutput({ noColor: argv.noColor });

/**
 * Read the repository's prettier options so the generated file matches `--check`.
 * @returns {Promise<object>}
 */
async function resolvePrettierConfig() {
  const { resolveConfig } = await import("prettier");
  return (await resolveConfig(target)) ?? {};
}

/**
 * Resolve the repository root the same way the sibling generators do.
 * @returns {string}
 */
function resolveRepoRoot() {
  if (argv.flags["repo-root"]) return resolve(argv.flags["repo-root"]);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  process.stderr.write("cannot resolve repo root — pass --repo-root\n");
  process.exit(EXIT_CODES.ENV);
}

const repoRoot = resolveRepoRoot();
const target = join(repoRoot, SCHEMA_RELATIVE);
// Format through prettier's own API rather than guessing its rules: `npm run lint`
// runs `prettier --check` over every `.json` file, and it collapses short arrays
// that `JSON.stringify` would expand. Generating what the linter accepts keeps the
// generator and the formatter from fighting over the committed file.
const rendered = await format(JSON.stringify(buildComputeSchema()), {
  ...(await resolvePrettierConfig()),
  parser: "json",
});

if (argv.flags.check) {
  if (!existsSync(target)) {
    out.fail(`${SCHEMA_RELATIVE} is missing — run node scripts/build-compute-schema.mjs`);
    process.exit(EXIT_CODES.VALIDATION);
  }
  if (readFileSync(target, "utf8") !== rendered) {
    out.fail(`${SCHEMA_RELATIVE} is stale — run node scripts/build-compute-schema.mjs`);
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.pass(`${SCHEMA_RELATIVE} fresh`);
  process.exit(EXIT_CODES.OK);
}

writeFileSync(target, rendered, "utf8");
out.pass(`generated ${SCHEMA_RELATIVE}`);
