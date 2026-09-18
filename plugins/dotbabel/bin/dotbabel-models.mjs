#!/usr/bin/env node
/**
 * dotbabel-models — Model Intelligence inspection and migration
 * (docs/specs/model-intelligence, §5 "CLI Surface").
 *
 * Verbs arrive with the library capability they expose (IMPL-4). This build
 * carries `migrate` in analysis mode only: it reports what migrating each
 * artifact's legacy `model:` / `effort:` frontmatter would mean and writes
 * nothing. `--write` and `--check` arrive with P-18, behind the batching and
 * preserved-behaviour gates of IMPL-2.
 *
 * Exits: 0 analysis completed, 1 a declaration conflict was found, 2 env error,
 * 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import { parseFrontmatter, walkArtifacts } from "../src/build-index.mjs";
import { analyzeMigration } from "../src/model-intelligence/compat/index.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const META = {
  name: "dotbabel-models",
  synopsis: "dotbabel-models <verb> [OPTIONS]",
  description:
    "Model Intelligence. Verbs: migrate — report what migrating each artifact's legacy model/effort frontmatter would mean. Writes nothing.",
  flags: {
    "repo-root": { type: "string" },
    json: { type: "boolean" },
  },
};

const VERBS = Object.freeze(["migrate"]);

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

const verb = argv.positional?.[0];
if (verb === undefined) {
  process.stderr.write(`a verb is required (one of: ${VERBS.join(", ")})\n`);
  process.exit(EXIT_CODES.USAGE);
}
if (!VERBS.includes(verb)) {
  process.stderr.write(`unknown verb "${verb}" (expected one of: ${VERBS.join(", ")})\n`);
  process.exit(EXIT_CODES.USAGE);
}

// Under `--json`, stdout carries exactly one JSON document, so every human line
// goes to stderr. A caller piping the report into `jq` gets the report, not the
// report plus a summary sentence (§5, "JSON contract").
const out = createOutput({ noColor: argv.noColor, stream: argv.flags.json ? process.stderr : process.stdout });

/**
 * Resolve the repository root the same way the sibling bins do.
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
// Only the three artifact kinds that can carry a compute declaration; a hook or a
// template has no compute context to describe (§5, KD-1).
const MIGRATABLE_KINDS = new Set(["agent", "command", "skill"]);

const inputs = walkArtifacts(repoRoot)
  .filter((artifact) => MIGRATABLE_KINDS.has(artifact.type))
  .map((artifact) => ({
    sourcePath: artifact.path,
    artifactKind: artifact.type,
    frontmatter: parseFrontmatter(artifact.content).frontmatter ?? {},
  }));

const report = analyzeMigration(inputs);

if (argv.flags.json) {
  process.stdout.write(`${JSON.stringify({ verb: "migrate", mode: "analysis", ...report }, null, 2)}\n`);
} else {
  for (const disposition of ["conflict", "ambiguous", "mapped", "inherit", "absent"]) {
    const entries = report.artifacts.filter((entry) => entry.disposition === disposition);
    if (entries.length === 0) continue;
    out.info(`${disposition}: ${entries.length}`);
    // The two dispositions a human must act on are worth naming; the bulk is not.
    if (disposition === "conflict" || disposition === "ambiguous") {
      for (const entry of entries) {
        const detail = entry.conflict ? entry.conflict.message : entry.notes[entry.notes.length - 1];
        out.warn(`  ${entry.sourcePath} — ${detail}`);
      }
    }
  }
  // "mapped" states only that the legacy alias has a known meaning. It is not an
  // approval: the DOC-1 class-F artifacts still need an owner decision, which
  // IMPL-7 gates before P-19f, and every proposal here is a conservative floor
  // that preserves the authored choice rather than relaxing it.
  out.info("mapped means the legacy alias has a known meaning, not that the migration is approved");
  out.info("analysis only: no artifact was written");
}

const conflicts = report.totals.conflict ?? 0;
if (conflicts > 0) {
  out.fail(`${conflicts} artifact(s) declare a canonical requirement that disagrees with their legacy value`);
  process.exit(EXIT_CODES.VALIDATION);
}
out.pass(`analysed ${report.artifacts.length} artifact(s)`);
