#!/usr/bin/env node
/**
 * dotclaude-search — full-text search over the taxonomy index.
 *
 * Usage: dotclaude-search <query> [OPTIONS]
 *
 * Exits: 0 ok (including no matches), 2 env error (index missing), 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const META = {
  name: "dotclaude-search",
  synopsis: "dotclaude-search <query> [OPTIONS]",
  description: "Full-text search over name, id, and description in the taxonomy index.",
  flags: {
    "repo-root": { type: "string" },
    type: { type: "string" },
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

if (argv.positional.length === 0) {
  process.stderr.write("usage: dotclaude-search <query> [OPTIONS]\n");
  process.exit(EXIT_CODES.USAGE);
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

const query = argv.positional[0] ?? "";
const queryLower = query.toLowerCase();
const typeFilter = argv.flags.type;

let results = (envelope.artifacts ?? []).filter((a) => {
  if (typeFilter && a.type !== typeFilter) return false;
  if (!queryLower) return true;
  return (
    (a.id ?? "").toLowerCase().includes(queryLower) ||
    (a.name ?? "").toLowerCase().includes(queryLower) ||
    (a.description ?? "").toLowerCase().includes(queryLower)
  );
});

if (argv.json) {
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  process.exit(EXIT_CODES.OK);
}

if (results.length === 0) {
  process.stdout.write("no matches\n");
  process.exit(EXIT_CODES.OK);
}

for (const a of results) {
  process.stdout.write(`${a.id}  [${a.type}]  ${a.description ?? ""}\n`);
}
process.exit(EXIT_CODES.OK);
