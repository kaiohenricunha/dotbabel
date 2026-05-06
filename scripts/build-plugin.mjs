#!/usr/bin/env node
/**
 * build-plugin — sync authored artifacts into plugins/dotbabel/templates/claude/
 * and regenerate plugins/dotbabel/templates/claude/skills-manifest.json.
 *
 * For each skill in skills/<slug>/SKILL.md:
 *   → plugins/dotbabel/templates/claude/skills/<slug>/SKILL.md
 *     (frontmatter stripped of owner, created, updated)
 *   → supporting references/, examples/, and scripts/ files copied verbatim
 *
 * For each command in commands/<slug>.md:
 *   → plugins/dotbabel/templates/claude/commands/<slug>.md
 *     (frontmatter stripped of owner, created, updated)
 *
 * For each agent in agents/<slug>.md:
 *   → plugins/dotbabel/templates/claude/agents/<slug>.md
 *     (frontmatter stripped of owner, created, updated)
 *
 * The generated skills-manifest.json uses {{today}} as the generatedAt
 * placeholder so init-harness-scaffold.mjs substitutes the real date at
 * install time.
 *
 * Flags:
 *   --repo-root <path>   Override repo root (default: git rev-parse --show-toplevel).
 *   --check              Verify the on-disk templates match what would be generated;
 *                        exit 1 if stale, 0 if fresh.
 *   --no-color           Suppress ANSI color.
 *   --help / -h
 *   --version / -V
 *
 * Exits: 0 ok, 1 stale (--check mode), 2 env error, 64 usage error.
 */

import { parse, helpText } from "../plugins/dotbabel/src/lib/argv.mjs";
import { EXIT_CODES } from "../plugins/dotbabel/src/lib/exit-codes.mjs";
import { createOutput } from "../plugins/dotbabel/src/lib/output.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const TOOL_VERSION = "1.0.0";
/** Fields stripped from consumer-facing frontmatter. */
const AUTHORING_FIELDS = new Set(["owner", "created", "updated"]);
const SKILL_SUPPORT_DIRS = ["references", "examples", "scripts"];

const META = {
  name: "build-plugin",
  synopsis: "build-plugin [OPTIONS]",
  description:
    "Sync authored artifacts into plugins/dotbabel/templates/claude/ and regenerate skills-manifest.json. Use --check to verify freshness without writing.",
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
const templateRoot = join(repoRoot, "plugins", "dotbabel", "templates", "claude");
const manifestPath = join(templateRoot, "skills-manifest.json");

if (!existsSync(indexPath)) {
  process.stderr.write("index not found — run dotbabel-index to build it\n");
  process.exit(EXIT_CODES.ENV);
}

let envelope;
try {
  envelope = JSON.parse(readFileSync(indexPath, "utf8"));
} catch (err) {
  out.fail(`failed to read index: ${err.message}`);
  out.flush();
  process.exit(EXIT_CODES.ENV);
}

const artifacts = (envelope.artifacts ?? []).filter(
  (a) => a.type === "skill" || a.type === "command" || a.type === "agent",
);

/**
 * Parse frontmatter + body from a SKILL.md or command.md file.
 * Returns stripped frontmatter text (authoring-only fields removed) + body.
 *
 * @param {string} content
 * @returns {string}
 */
function stripAuthoringFields(content) {
  const sep = "---";
  const first = content.indexOf(sep);
  const second = content.indexOf(sep, first + 3);
  if (first === -1 || second === -1) return content;

  const fmLines = content.slice(first + 3, second).split("\n");
  const kept = fmLines.filter((line) => {
    const key = line.split(":")[0].trim();
    return !AUTHORING_FIELDS.has(key);
  });
  return `---${kept.join("\n")}---${content.slice(second + 3)}`;
}

/**
 * Return all regular files below a directory, relative to that directory.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function walkRelativeFiles(dir) {
  const files = [];
  function walk(current, prefix = "") {
    for (const entry of readdirSync(current).sort()) {
      const abs = join(current, entry);
      const rel = prefix ? join(prefix, entry) : entry;
      if (statSync(abs).isDirectory()) {
        walk(abs, rel);
      } else if (statSync(abs).isFile()) {
        files.push(rel);
      }
    }
  }
  walk(dir);
  return files;
}

/**
 * Build the in-memory representation of what the templates + manifest should
 * look like given the current index.
 *
 * @returns {{ files: Map<string, string>, manifestText: string }}
 */
function buildExpected() {
  /** @type {Map<string, string>} absPath → expected content */
  const files = new Map();

  const manifestEntries = [];

  for (const artifact of artifacts.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    if (artifact.type === "skill") {
      const srcPath = join(repoRoot, "skills", artifact.id, "SKILL.md");
      if (!existsSync(srcPath)) continue;
      const raw = readFileSync(srcPath, "utf8");
      const stripped = stripAuthoringFields(raw);
      const destPath = join(templateRoot, "skills", artifact.id, "SKILL.md");
      files.set(destPath, stripped);

      // Copy lazy-loaded support files so SKILL.md references and helper scripts
      // resolve in both bootstrap and npm template installs.
      for (const supportDirName of SKILL_SUPPORT_DIRS) {
        const supportDir = join(repoRoot, "skills", artifact.id, supportDirName);
        if (!existsSync(supportDir)) continue;
        for (const relFile of walkRelativeFiles(supportDir)) {
          files.set(
            join(templateRoot, "skills", artifact.id, supportDirName, relFile),
            readFileSync(join(supportDir, relFile), "utf8"),
          );
        }
      }

      manifestEntries.push({
        name: artifact.id,
        path: `.claude/skills/${artifact.id}/SKILL.md`,
        checksum: "",
        dependencies: [],
        lastValidated: null,
      });
    } else if (artifact.type === "command") {
      const srcPath = join(repoRoot, "commands", `${artifact.id}.md`);
      if (!existsSync(srcPath)) continue;
      const raw = readFileSync(srcPath, "utf8");
      const stripped = stripAuthoringFields(raw);
      const destPath = join(templateRoot, "commands", `${artifact.id}.md`);
      files.set(destPath, stripped);
      manifestEntries.push({
        name: artifact.id,
        path: `.claude/commands/${artifact.id}.md`,
        checksum: "",
        dependencies: [],
        lastValidated: null,
      });
    } else if (artifact.type === "agent") {
      const srcPath = join(repoRoot, "agents", `${artifact.id}.md`);
      if (!existsSync(srcPath)) continue;
      const raw = readFileSync(srcPath, "utf8");
      const stripped = stripAuthoringFields(raw);
      const destPath = join(templateRoot, "agents", `${artifact.id}.md`);
      files.set(destPath, stripped);
    }
  }

  const manifest = { version: 1, generatedAt: "{{today}}", skills: manifestEntries };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  return { files, manifestText };
}

const { files, manifestText } = buildExpected();

if (argv.flags.check) {
  let stale = false;

  // Check manifest
  if (!existsSync(manifestPath)) {
    out.fail("skills-manifest.json not found — run build-plugin to generate it");
    stale = true;
  } else {
    const existing = readFileSync(manifestPath, "utf8");
    if (existing !== manifestText) {
      out.fail("skills-manifest.json is stale — run `node scripts/build-plugin.mjs` to regenerate");
      stale = true;
    }
  }

  // Check each generated template file
  for (const [destPath, expected] of files) {
    if (!existsSync(destPath)) {
      out.fail(`missing template file: ${destPath}`);
      stale = true;
    } else {
      const actual = readFileSync(destPath, "utf8");
      if (actual !== expected) {
        out.fail(`stale template file: ${destPath}`);
        stale = true;
      }
    }
  }

  if (stale) {
    out.flush();
    process.exit(EXIT_CODES.VALIDATION);
  }

  out.pass(`plugin templates fresh (${files.size} files + manifest)`);
  out.flush();
  process.exit(EXIT_CODES.OK);
}

// Full rebuild
let written = 0;

// Clean up existing template artifacts to prevent orphans from old runs.
if (!argv.flags.check) {
  for (const dir of ["commands", "skills", "agents"]) {
    const d = join(templateRoot, dir);
    if (existsSync(d)) {
      spawnSync("rm", ["-rf", d]);
    }
  }
}

for (const [destPath, content] of files) {
  mkdirSync(destPath.slice(0, destPath.lastIndexOf("/")), { recursive: true });
  writeFileSync(destPath, content);
  written++;
}

writeFileSync(manifestPath, manifestText);
out.pass(`plugin templates written: ${written} file${written === 1 ? "" : "s"} + manifest`);
out.flush();
process.exit(EXIT_CODES.OK);
