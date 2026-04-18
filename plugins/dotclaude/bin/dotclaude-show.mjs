#!/usr/bin/env node
/**
 * dotclaude-show — display a single artifact by id.
 *
 * Usage: dotclaude-show <id> [OPTIONS]
 *
 * Exits: 0 ok, 1 artifact not found, 2 env error (index missing), 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const META = {
  name: "dotclaude-show",
  synopsis: "dotclaude-show <id> [OPTIONS]",
  description:
    "Display a single artifact by its id from the taxonomy index. When an agent and a skill share the same id, use --type agent|skill|command to disambiguate.",
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
  process.stderr.write("usage: dotclaude-show <id> [OPTIONS]\n");
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

const id = argv.positional[0];
const typeFilter = argv.flags.type;
const matches = (envelope.artifacts ?? []).filter((a) => a.id === id);
const artifact = typeFilter ? matches.find((a) => a.type === typeFilter) : matches[0];

if (!artifact) {
  if (typeFilter && matches.length > 0) {
    const types = matches.map((a) => a.type).join(", ");
    process.stderr.write(`not found as ${typeFilter}: "${id}" exists as: ${types}\n`);
  } else {
    process.stderr.write(`not found: ${id}\n`);
  }
  process.exit(EXIT_CODES.VALIDATION);
}

if (!typeFilter && matches.length > 1) {
  const types = matches.map((a) => a.type).join(", ");
  process.stderr.write(
    `note: multiple artifacts share id "${id}" (${types}); showing ${artifact.type} — use --type to select a specific one\n`,
  );
}

if (argv.json) {
  process.stdout.write(JSON.stringify(artifact, null, 2) + "\n");
  process.exit(EXIT_CODES.OK);
}

process.stdout.write(`id:          ${artifact.id}\n`);
process.stdout.write(`name:        ${artifact.name ?? ""}\n`);
process.stdout.write(`type:        ${artifact.type}\n`);
process.stdout.write(`description: ${artifact.description ?? ""}\n`);
if (artifact.version) process.stdout.write(`version:     ${artifact.version}\n`);
if (artifact.facets) {
  const f = artifact.facets;
  if (f.domain?.length) process.stdout.write(`domain:      ${f.domain.join(", ")}\n`);
  if (f.platform?.length) process.stdout.write(`platform:    ${f.platform.join(", ")}\n`);
  if (f.task?.length) process.stdout.write(`task:        ${f.task.join(", ")}\n`);
  if (f.maturity) process.stdout.write(`maturity:    ${f.maturity}\n`);
}
if (artifact.owner) process.stdout.write(`owner:       ${artifact.owner}\n`);
process.stdout.write(`path:        ${artifact.path}\n`);
process.exit(EXIT_CODES.OK);
