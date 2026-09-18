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
import {
  LEGACY_DISPOSITIONS,
  analyzeMigration,
  canCarryComputeDeclaration,
} from "../src/model-intelligence/compat/index.mjs";
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
// The library owns which kinds can carry a compute declaration, so this filter and
// the one `interpretLegacy` applies cannot disagree (IMPL-4).
// `walkArtifacts` yields no workflow today, so `ai-review.yml` — which KD-6
// projects — is outside this report until P-17 gives it a canonical source.
const inputs = walkArtifacts(repoRoot)
  .filter((artifact) => canCarryComputeDeclaration(artifact.type))
  .map((artifact) => ({
    sourcePath: artifact.path,
    artifactKind: artifact.type,
    frontmatter: parseFrontmatter(artifact.content).frontmatter ?? {},
  }));

const report = analyzeMigration(inputs);

if (argv.flags.json) {
  // The library owns the envelope, including its name, version, and mode, so the
  // three modes P-18 adds cannot drift into three shapes assembled here (§5).
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  // Severity ordering is a rendering concern and lives here; the set of
  // dispositions is the library's, so a new one still prints.
  const SEVERITY_FIRST = ["invalid-declaration", "conflict", "ambiguous"];
  const ordered = [...SEVERITY_FIRST, ...LEGACY_DISPOSITIONS.filter((d) => !SEVERITY_FIRST.includes(d))];
  for (const disposition of ordered) {
    const entries = report.artifacts.filter((entry) => entry.disposition === disposition);
    if (entries.length === 0) continue;
    out.info(`${disposition}: ${entries.length}`);
    // The two dispositions a human must act on are worth naming; the bulk is not.
    if (SEVERITY_FIRST.includes(disposition)) {
      for (const entry of entries) {
        // Rendered from the codes, which are the contract, rather than from the
        // last element of `notes`, which the library calls presentation.
        out.warn(`  ${entry.sourcePath} — ${entry.codes.join(", ")}`);
        if (entry.conflict) out.warn(`      ${entry.conflict.message}`);
        for (const error of entry.declarationErrors ?? []) out.warn(`      ${error.pointer}: ${error.message}`);
      }
    }
  }
  // "mapped" states only that the legacy alias has a known meaning. It is not an
  // approval: the DOC-1 class-F artifacts still need an owner decision, which
  // IMPL-7 gates before P-19f, and every proposal here is a conservative floor
  // that preserves the authored choice rather than relaxing it.
  out.info("mapped means the legacy alias has a known meaning, not that the migration is approved");
  out.info("every mapped proposal carries MI_PROPOSAL_DEFAULTED: DOC-1 assigns the class per artifact, so an owner decision is still required");
  out.info("analysis only: no artifact was written");
}

const conflicts = report.totals.conflict ?? 0;
const invalid = report.totals["invalid-declaration"] ?? 0;
if (conflicts > 0 || invalid > 0) {
  if (conflicts > 0) out.fail(`${conflicts} artifact(s) declare a canonical requirement that disagrees with their legacy value`);
  // A declaration that does not parse is a strictly worse case than one that
  // merely disagrees, so it fails the same gate (§5 exit codes).
  if (invalid > 0) out.fail(`${invalid} artifact(s) carry a dotbabel.compute block that does not parse`);
  process.exit(EXIT_CODES.VALIDATION);
}
out.pass(`analysed ${report.artifacts.length} artifact(s)`);
