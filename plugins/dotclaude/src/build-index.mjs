/**
 * build-index — taxonomy artifact discovery, frontmatter parsing, schema
 * validation, and three-way index construction.
 *
 * Phase 1 of the dotclaude taxonomy plan: non-breaking. Produces warnings
 * only; artifacts with legacy or missing metadata are still indexed (with
 * reduced detail) so downstream consumers can rely on a stable shape.
 *
 * @typedef {'agent'|'skill'|'command'|'hook'|'template'} ArtifactType
 *
 * @typedef {object} Artifact
 * @property {ArtifactType} type
 * @property {string} path              Repo-relative POSIX path to the source file.
 * @property {string} content           Raw file contents (text).
 * @property {object} frontmatter       Parsed YAML frontmatter (possibly empty).
 * @property {string[]} warnings        Parse-time warnings (e.g. missing frontmatter block).
 *
 * @typedef {object} IndexEntry
 * @property {string} id
 * @property {ArtifactType} type
 * @property {string} path
 * @property {string} name
 * @property {string} description
 * @property {string} [version]
 * @property {{ domain: string[], platform: string[], task: string[], maturity: string }} facets
 * @property {string} [owner]
 * @property {string[]} [related]
 *
 * @typedef {object} IndexBundle
 * @property {object} artifactsJson   The { $schema, generatedAt, version, artifacts } envelope.
 * @property {Record<ArtifactType, string[]>} byType
 * @property {{ domain: Record<string, string[]>, platform: Record<string, string[]>, task: Record<string, string[]>, maturity: Record<string, string[]> }} byFacet
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_SCHEMAS_DIR = resolve(__dirname, "..", "..", "..", "schemas");
const { version: pkgVersion } = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "..", "package.json"), "utf8"),
);

/** @type {ArtifactType[]} */
const ARTIFACT_TYPES = ["agent", "skill", "command", "hook", "template"];

/**
 * Convert a filesystem path to a repo-relative POSIX path. Used inside the
 * index envelope so the generated JSON is stable across Windows/Linux hosts.
 *
 * @param {string} repoRoot
 * @param {string} absPath
 * @returns {string}
 */
function toRelPosix(repoRoot, absPath) {
  return relative(repoRoot, absPath).split(sep).join("/");
}

/**
 * Parse the YAML frontmatter block at the top of a markdown-ish document.
 *
 * Supports both inline arrays (`domain: [infra, observability]`) and block
 * arrays thanks to js-yaml. Returns `{}` when no frontmatter is present so
 * callers can always destructure.
 *
 * @param {string} content
 * @returns {{ frontmatter: object, warnings: string[] }}
 */
export function parseFrontmatter(content) {
  const warnings = [];
  if (typeof content !== "string" || content.length === 0) {
    return { frontmatter: {}, warnings: ["empty content"] };
  }
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") {
    warnings.push("no YAML frontmatter (no opening --- on line 1)");
    return { frontmatter: {}, warnings };
  }
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) {
    warnings.push("unterminated YAML frontmatter (no closing ---)");
    return { frontmatter: {}, warnings };
  }
  const block = lines.slice(1, closeIdx).join("\n");
  try {
    const parsed = yaml.load(block);
    if (parsed === null || parsed === undefined) {
      return { frontmatter: {}, warnings };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push("frontmatter is not a YAML mapping");
      return { frontmatter: {}, warnings };
    }
    return { frontmatter: normalizeDates(parsed), warnings };
  } catch (err) {
    warnings.push(`frontmatter YAML parse error: ${err.message}`);
    return { frontmatter: {}, warnings };
  }
}

/**
 * Recursively convert Date values produced by the YAML 1.1 timestamp type
 * back into `YYYY-MM-DD` strings, which is what the schema's `date` format
 * expects. Mutation is scoped to a shallow copy to avoid surprising callers.
 *
 * @param {any} value
 * @returns {any}
 */
function normalizeDates(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeDates(v);
    return out;
  }
  return value;
}

/**
 * Walk the repo and return every taxonomy artifact found. Silently skips
 * directories that don't exist so the function can safely run on partial
 * checkouts.
 *
 * Layout expected (type-first, flat):
 *   <repoRoot>/agents/*.md
 *   <repoRoot>/skills/<slug>/SKILL.md
 *   <repoRoot>/skills/*.md                    (flat skills, if any)
 *   <repoRoot>/commands/*.md
 *   <repoRoot>/hooks/*.md                     (the .md wrapper; .sh lives alongside)
 *   <repoRoot>/templates/<slug>/template.yaml
 *
 * @param {string} repoRoot
 * @returns {Artifact[]}
 */
export function walkArtifacts(repoRoot) {
  /** @type {Artifact[]} */
  const artifacts = [];

  const addMarkdownFiles = (dir, type) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const abs = join(dir, entry.name);
        artifacts.push(loadArtifact(repoRoot, abs, type));
      }
    }
  };

  // agents/
  addMarkdownFiles(join(repoRoot, "agents"), "agent");

  // skills/ — both dir-per-skill (SKILL.md) and flat *.md
  const skillsDir = join(repoRoot, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      const top = join(skillsDir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        artifacts.push(loadArtifact(repoRoot, top, "skill"));
      } else if (entry.isDirectory()) {
        const inner = join(top, "SKILL.md");
        if (existsSync(inner)) {
          artifacts.push(loadArtifact(repoRoot, inner, "skill"));
        }
      }
    }
  }

  // commands/
  addMarkdownFiles(join(repoRoot, "commands"), "command");

  // hooks/ — .md wrappers (actual .sh lives alongside but is not indexed directly)
  addMarkdownFiles(join(repoRoot, "hooks"), "hook");

  // templates/<slug>/template.yaml
  const templatesDir = join(repoRoot, "templates");
  if (existsSync(templatesDir)) {
    for (const entry of readdirSync(templatesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const yamlPath = join(templatesDir, entry.name, "template.yaml");
      if (existsSync(yamlPath)) {
        artifacts.push(loadTemplateArtifact(repoRoot, yamlPath));
      }
    }
  }

  return artifacts;
}

/**
 * Load one markdown-style artifact (agent, skill, command, hook): read file,
 * parse YAML frontmatter, and produce an {@link Artifact} record.
 *
 * @param {string} repoRoot
 * @param {string} absPath
 * @param {ArtifactType} type
 * @returns {Artifact}
 */
function loadArtifact(repoRoot, absPath, type) {
  const content = readFileSync(absPath, "utf8");
  const { frontmatter, warnings } = parseFrontmatter(content);
  return {
    type,
    path: toRelPosix(repoRoot, absPath),
    content,
    frontmatter,
    warnings,
  };
}

/**
 * Load a template artifact from a `template.yaml` file. Treats the entire
 * file body as the frontmatter mapping since templates don't use the
 * `---` fence convention.
 *
 * @param {string} repoRoot
 * @param {string} absPath
 * @returns {Artifact}
 */
function loadTemplateArtifact(repoRoot, absPath) {
  const content = readFileSync(absPath, "utf8");
  const warnings = [];
  let frontmatter = {};
  try {
    const parsed = yaml.load(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = normalizeDates(parsed);
    } else if (parsed !== null && parsed !== undefined) {
      warnings.push("template.yaml is not a YAML mapping");
    }
  } catch (err) {
    warnings.push(`template.yaml parse error: ${err.message}`);
  }
  return {
    type: "template",
    path: toRelPosix(repoRoot, absPath),
    content,
    frontmatter,
    warnings,
  };
}

/**
 * Infer a stable id for an artifact. Prefers explicit `id`, then `name`
 * (lower-kebab), then a path-derived fallback.
 *
 * @param {Artifact} art
 * @returns {string}
 */
function inferId(art) {
  const fm = art.frontmatter ?? {};
  if (typeof fm.id === "string" && fm.id.length > 0) return fm.id;
  if (typeof fm.name === "string" && fm.name.length > 0) {
    return slugify(fm.name);
  }
  // Fallbacks per type.
  if (art.type === "skill" && art.path.endsWith("/SKILL.md")) {
    return slugify(basename(dirname(art.path)));
  }
  if (art.type === "template" && art.path.endsWith("/template.yaml")) {
    return slugify(basename(dirname(art.path)));
  }
  return slugify(basename(art.path).replace(/\.md$/, "").replace(/\.yaml$/, ""));
}

/**
 * Render a human string as a kebab-case slug. Keeps ASCII lowercase + digits.
 *
 * @param {string} input
 * @returns {string}
 */
function slugify(input) {
  const s = String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-");
  let lo = 0;
  let hi = s.length;
  while (lo < hi && s[lo] === "-") lo++;
  while (hi > lo && s[hi - 1] === "-") hi--;
  return s.slice(lo, hi);
}

/**
 * Pull an array-valued facet out of the frontmatter, tolerating both the
 * legacy string form (`domain: infra`) and missing values.
 *
 * @param {object} fm
 * @param {string} key
 * @returns {string[]}
 */
function extractArrayFacet(fm, key) {
  const raw = fm?.[key];
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string");
  if (typeof raw === "string" && raw.length > 0) return [raw];
  return [];
}

/**
 * Convert a walked artifact into the flat {@link IndexEntry} shape used in
 * index/artifacts.json. Missing metadata is filled with empty-but-valid
 * defaults (empty arrays, path-derived name, etc.) so the index is always
 * shape-stable even when frontmatter hasn't been backfilled.
 *
 * @param {Artifact} art
 * @returns {IndexEntry}
 */
function toIndexEntry(art) {
  const fm = art.frontmatter ?? {};
  const id = inferId(art);
  const name =
    typeof fm.name === "string" && fm.name.length > 0 ? fm.name : id;
  const description =
    typeof fm.description === "string" && fm.description.length > 0
      ? fm.description
      : "";
  const domain = extractArrayFacet(fm, "domain");
  const platform = extractArrayFacet(fm, "platform");
  const task = extractArrayFacet(fm, "task");
  const maturity =
    typeof fm.maturity === "string" && fm.maturity.length > 0
      ? fm.maturity
      : "draft";
  /** @type {IndexEntry} */
  const entry = {
    id,
    type: art.type,
    path: art.path,
    name,
    description,
    facets: { domain, platform, task, maturity },
  };
  if (typeof fm.version === "string") entry.version = fm.version;
  if (typeof fm.owner === "string") entry.owner = fm.owner;
  if (Array.isArray(fm.related)) {
    entry.related = fm.related.filter((v) => typeof v === "string");
  }
  return entry;
}

/**
 * Build the three index shapes (artifacts.json envelope, byType, byFacet)
 * from a list of walked artifacts. Entries are sorted by id for stable
 * diffs.
 *
 * @param {Artifact[]} artifacts
 * @returns {IndexBundle}
 */
export function buildIndex(artifacts) {
  const entries = artifacts.map(toIndexEntry);
  entries.sort((a, b) => a.id.localeCompare(b.id));

  /** @type {Record<ArtifactType, string[]>} */
  const byType = {
    agent: [],
    skill: [],
    command: [],
    hook: [],
    template: [],
  };
  /** @type {IndexBundle["byFacet"]} */
  const byFacet = {
    domain: {},
    platform: {},
    task: {},
    maturity: {},
  };

  for (const entry of entries) {
    byType[entry.type].push(entry.id);
    for (const d of entry.facets.domain) {
      (byFacet.domain[d] ||= []).push(entry.id);
    }
    for (const p of entry.facets.platform) {
      (byFacet.platform[p] ||= []).push(entry.id);
    }
    for (const t of entry.facets.task) {
      (byFacet.task[t] ||= []).push(entry.id);
    }
    const mat = entry.facets.maturity;
    (byFacet.maturity[mat] ||= []).push(entry.id);
  }

  // Sort facet buckets for stability.
  for (const bucket of Object.values(byFacet)) {
    for (const key of Object.keys(bucket)) {
      bucket[key].sort();
    }
  }
  for (const type of ARTIFACT_TYPES) byType[type].sort();

  const artifactsJson = {
    $schema: "https://dotclaude.dev/schemas/index.schema.json",
    generatedAt: new Date(0).toISOString(), // deterministic placeholder; CLI overwrites
    version: pkgVersion,
    artifacts: entries,
  };

  return { artifactsJson, byType, byFacet };
}

/**
 * Load every schema file from `schemasDir` into a single Ajv instance and
 * return it along with the per-type compiled validators.
 *
 * @param {string} schemasDir
 * @returns {{ ajv: any, validators: Record<ArtifactType, any> }}
 */
function compileSchemas(schemasDir) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const files = [
    "facets",
    "common",
    "agent",
    "skill",
    "command",
    "hook",
    "template",
    "index-entry",
  ];
  for (const f of files) {
    const abs = join(schemasDir, `${f}.schema.json`);
    if (!existsSync(abs)) {
      throw new Error(`schema not found: ${abs}`);
    }
    ajv.addSchema(JSON.parse(readFileSync(abs, "utf8")));
  }
  /** @type {Record<ArtifactType, any>} */
  const validators = {
    agent: ajv.getSchema("https://dotclaude.dev/schemas/agent.schema.json"),
    skill: ajv.getSchema("https://dotclaude.dev/schemas/skill.schema.json"),
    command: ajv.getSchema("https://dotclaude.dev/schemas/command.schema.json"),
    hook: ajv.getSchema("https://dotclaude.dev/schemas/hook.schema.json"),
    template: ajv.getSchema(
      "https://dotclaude.dev/schemas/template.schema.json",
    ),
  };
  return { ajv, validators };
}

/**
 * Validate every artifact's frontmatter against its per-type schema. Phase 1
 * is non-blocking: all schema errors become warnings, never hard errors.
 *
 * @param {Artifact[]} artifacts
 * @param {string} [schemasDir]  Defaults to `<repo>/schemas/`.
 * @returns {{ warnings: string[] }}
 */
export function validateArtifacts(artifacts, schemasDir = DEFAULT_SCHEMAS_DIR) {
  const warnings = [];
  const { validators } = compileSchemas(schemasDir);
  for (const art of artifacts) {
    for (const w of art.warnings) {
      warnings.push(`${art.path}: ${w}`);
    }
    const validate = validators[art.type];
    if (!validate) continue;
    const ok = validate(art.frontmatter ?? {});
    if (!ok) {
      for (const err of validate.errors ?? []) {
        const ptr = err.instancePath || "/";
        warnings.push(
          `${art.path}: schema ${art.type} ${ptr} ${err.message} (${err.keyword})`,
        );
      }
    }
  }
  return { warnings };
}

/**
 * Compute the index freshly from disk and return true if the on-disk
 * `index/artifacts.json` differs from the freshly computed envelope.
 *
 * Deliberately ignores the `generatedAt` field when comparing so that
 * rebuilding the same source produces a stale=false result.
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isIndexStale(repoRoot) {
  const fresh = buildIndex(walkArtifacts(repoRoot));
  const onDiskPath = join(repoRoot, "index", "artifacts.json");
  if (!existsSync(onDiskPath)) return true;
  let onDisk;
  try {
    onDisk = JSON.parse(readFileSync(onDiskPath, "utf8"));
  } catch {
    return true;
  }
  const stripVolatile = (o) => {
    const { generatedAt: _ga, ...rest } = o ?? {};
    return rest;
  };
  const a = JSON.stringify(stripVolatile(fresh.artifactsJson));
  const b = JSON.stringify(stripVolatile(onDisk));
  if (a !== b) return true;
  // Also compare by-type / by-facet if present.
  for (const sidecar of ["by-type.json", "by-facet.json"]) {
    const p = join(repoRoot, "index", sidecar);
    if (!existsSync(p)) return true;
  }
  const byTypeOnDisk = safeReadJson(join(repoRoot, "index", "by-type.json"));
  const byFacetOnDisk = safeReadJson(join(repoRoot, "index", "by-facet.json"));
  if (
    JSON.stringify(byTypeOnDisk) !== JSON.stringify(fresh.byType) ||
    JSON.stringify(byFacetOnDisk) !== JSON.stringify(fresh.byFacet)
  ) {
    return true;
  }
  return false;
}

/**
 * Read a JSON file, returning `null` on error so callers can diff against a
 * known-distinct sentinel without throwing.
 *
 * @param {string} p
 * @returns {any}
 */
function safeReadJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The path to the repo-root `schemas/` directory, resolved relative to this
 * module. Exposed so CLIs can pass it to {@link validateArtifacts}.
 */
export const SCHEMAS_DIR = DEFAULT_SCHEMAS_DIR;

/**
 * Ensure `statSync` at a path is a directory, or throw a helpful error.
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
