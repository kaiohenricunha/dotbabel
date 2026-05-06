#!/usr/bin/env node
/**
 * dotclaude-list — list artifacts from the taxonomy index with optional filters.
 *
 * Usage: dotclaude-list [OPTIONS]
 *
 * Exits: 0 ok, 2 env error (index missing), 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const META = {
  name: "dotclaude-list",
  synopsis: "dotclaude-list [OPTIONS]",
  description: "List artifacts from the taxonomy index, with optional facet filters.",
  flags: {
    "repo-root": { type: "string" },
    type: { type: "string" },
    domain: { type: "string" },
    platform: { type: "string" },
    task: { type: "string" },
    maturity: { type: "string" },
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

function resolveRepoRoot() {
  if (argv.flags["repo-root"]) return resolve(argv.flags["repo-root"]);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0) {
    const top = result.stdout.trim();
    if (top) return top;
  }
  return process.cwd();
}

const repoRoot = resolveRepoRoot();
const indexPath = join(repoRoot, "index", "artifacts.json");

if (!existsSync(indexPath)) {
  process.stderr.write("index not found — run dotclaude-index to build it\n");
  process.exit(EXIT_CODES.ENV);
}

let envelope;
try {
  envelope = JSON.parse(readFileSync(indexPath, "utf8"));
} catch (err) {
  process.stderr.write(`failed to read index: ${err.message}\n`);
  process.exit(EXIT_CODES.ENV);
}

const typeFilter = argv.flags.type;
const domainFilter = argv.flags.domain;
const platformFilter = argv.flags.platform;
const taskFilter = argv.flags.task;
const maturityFilter = argv.flags.maturity;

const results = (envelope.artifacts ?? []).filter((a) => {
  if (typeFilter && a.type !== typeFilter) return false;
  if (maturityFilter && a.facets?.maturity !== maturityFilter) return false;
  if (domainFilter && !(a.facets?.domain ?? []).includes(domainFilter)) return false;
  if (platformFilter && !(a.facets?.platform ?? []).includes(platformFilter)) return false;
  if (taskFilter && !(a.facets?.task ?? []).includes(taskFilter)) return false;
  return true;
});

if (argv.json) {
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  process.exit(EXIT_CODES.OK);
}

for (const a of results) {
  process.stdout.write(`${a.id}  [${a.type}]  ${a.description ?? ""}\n`);
}
process.exit(EXIT_CODES.OK);
