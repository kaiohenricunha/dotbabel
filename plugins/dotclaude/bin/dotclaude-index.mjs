#!/usr/bin/env node
/**
 * dotclaude-index — rebuilds the taxonomy index under `<repo>/index/`.
 *
 * Walks every authored artifact (agent / skill / command / hook / template),
 * parses frontmatter, validates against per-type JSON schemas (warnings only
 * in Phase 1), and writes three deterministic JSON files:
 *
 *   index/artifacts.json   — full envelope: { $schema, generatedAt, version, artifacts[] }
 *   index/by-type.json     — { agent: [ids…], skill: [ids…], … }
 *   index/by-facet.json    — { domain: {…}, platform: {…}, task: {…}, maturity: {…} }
 *
 * Modes:
 *   (default)   rebuild all three files on disk.
 *   --check     compare the in-memory index to disk; exit 1 if stale.
 *
 * Exits: 0 ok, 1 stale (check mode), 2 env error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { createOutput } from "../src/lib/output.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import {
  walkArtifacts,
  buildIndex,
  validateArtifacts,
  isIndexStale,
  SCHEMAS_DIR,
} from "../src/build-index.mjs";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const META = {
  name: "dotclaude-index",
  synopsis: "dotclaude-index [OPTIONS]",
  description:
    "Rebuild <repo>/index/{artifacts,by-type,by-facet}.json from authored taxonomy artifacts. Use --check to verify the index is fresh without writing.",
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
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

const out = createOutput({ json: argv.json, noColor: argv.noColor });

/**
 * Resolve a repo root the same way `createHarnessContext` does, but without
 * pulling the spec-harness-lib dependency. Order: explicit `--repo-root` >
 * `git rev-parse --show-toplevel` > `process.cwd()`.
 *
 * @returns {string}
 */
function resolveRepoRoot() {
  if (argv.flags["repo-root"]) return resolve(argv.flags["repo-root"]);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    const top = result.stdout.trim();
    if (top) return top;
  }
  return process.cwd();
}

const repoRoot = resolveRepoRoot();

let artifacts;
try {
  artifacts = walkArtifacts(repoRoot);
} catch (err) {
  out.fail(`failed to walk artifacts: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

let warnings = [];
try {
  ({ warnings } = validateArtifacts(artifacts, SCHEMAS_DIR));
} catch (err) {
  out.fail(`schema load failed: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

for (const w of warnings) out.warn(w);

const bundle = buildIndex(artifacts);

if (argv.flags.check) {
  const stale = isIndexStale(repoRoot);
  if (stale) {
    out.fail(
      "index is stale — run `dotclaude-index` to refresh index/artifacts.json, index/by-type.json, index/by-facet.json",
    );
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }
  out.pass(
    `index fresh (${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"})`,
  );
  out.flush();
  process.exit(EXIT_CODES.OK);
}

// Full rebuild. Stamp a deterministic-by-content generatedAt (ISO) and write.
const indexDir = join(repoRoot, "index");
if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });

// Preserve generatedAt when the rest of the envelope is unchanged so
// `--check` immediately afterwards exits 0 (and to avoid noisy diffs).
const artifactsPath = join(indexDir, "artifacts.json");
let preservedGeneratedAt = null;
if (existsSync(artifactsPath)) {
  try {
    const prior = JSON.parse(readFileSync(artifactsPath, "utf8"));
    const stripVol = (o) => {
      const { generatedAt: _ga, ...rest } = o ?? {};
      return rest;
    };
    if (
      JSON.stringify(stripVol(prior)) ===
      JSON.stringify(stripVol(bundle.artifactsJson))
    ) {
      preservedGeneratedAt = prior.generatedAt ?? null;
    }
  } catch {
    // ignore malformed on-disk file; we're about to overwrite it.
  }
}
bundle.artifactsJson.generatedAt =
  preservedGeneratedAt ?? new Date().toISOString();

writeFileSync(
  artifactsPath,
  JSON.stringify(bundle.artifactsJson, null, 2) + "\n",
);
writeFileSync(
  join(indexDir, "by-type.json"),
  JSON.stringify(bundle.byType, null, 2) + "\n",
);
writeFileSync(
  join(indexDir, "by-facet.json"),
  JSON.stringify(bundle.byFacet, null, 2) + "\n",
);

// Write a README once if absent; never overwrite user edits.
const readmePath = join(indexDir, "README.md");
if (!existsSync(readmePath)) {
  writeFileSync(
    readmePath,
    [
      "# index/",
      "",
      "Generated by `dotclaude-index`. Do not hand-edit `artifacts.json`, `by-type.json`, or `by-facet.json` — they are rebuilt from authored artifacts under `agents/`, `skills/`, `commands/`, `hooks/`, and `templates/`.",
      "",
      "To regenerate:",
      "",
      "```bash",
      "node plugins/dotclaude/bin/dotclaude-index.mjs",
      "```",
      "",
      "To verify freshness (e.g. in CI):",
      "",
      "```bash",
      "node plugins/dotclaude/bin/dotclaude-index.mjs --check",
      "```",
      "",
      "This `README.md` is the one file in `index/` you may safely edit — the generator writes it once and never overwrites.",
      "",
    ].join("\n"),
  );
}

out.pass(
  `index written: ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
);
out.flush();
process.exit(EXIT_CODES.OK);
