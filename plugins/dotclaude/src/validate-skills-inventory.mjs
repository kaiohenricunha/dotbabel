import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

// ---------------------------------------------------------------------------
// Agent validation helpers
// ---------------------------------------------------------------------------

const VALID_MODELS = new Set(["opus", "sonnet", "haiku", "inherit"]);
const READONLY_PATTERNS = [/(^|-)auditor$/i, /(^|-)reviewer$/i, /(^|-)inspector$/i];
const WRITE_TOOLS = ["Write", "Edit"];
const SECRET_PATTERNS = [
  { pattern: /ghp_/, label: "ghp_" },
  { pattern: /sk-/, label: "sk-" },
  { pattern: /AKIA/, label: "AKIA" },
  { pattern: /-----BEGIN/, label: "-----BEGIN" },
  { pattern: /password\s*=/, label: "password=" },
  { pattern: /token\s*=/, label: "token=" },
];

/**
 * Parse YAML frontmatter from a markdown file string.
 * Returns { fields: Map<string,string>, bodyStartLine: number } where
 * bodyStartLine is the 1-indexed line after the closing `---`.
 *
 * Returns null when no valid frontmatter block is found.
 *
 * @param {string} content
 * @returns {{ fields: Map<string,string>, bodyStartLine: number } | null}
 */
function parseFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx === -1) return null;

  const fields = new Map();
  let currentKey = null;
  let currentValue = [];

  function flushCurrent() {
    if (currentKey !== null) {
      fields.set(currentKey, currentValue.join("\n").trim());
      currentKey = null;
      currentValue = [];
    }
  }

  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i];
    // Key: value (possibly multiline with ">")
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (kvMatch) {
      flushCurrent();
      currentKey = kvMatch[1];
      currentValue = [kvMatch[2]];
    } else if (currentKey !== null && /^\s+/.test(line)) {
      // Continuation of a multiline value
      currentValue.push(line.trim());
    }
  }
  flushCurrent();

  return { fields, bodyStartLine: closeIdx + 2 }; // 1-indexed
}

/**
 * List all .md files in <agentsDir>/agents/
 *
 * @param {string} agentsDir  absolute path to the directory containing an `agents/` sub-folder
 * @returns {string[]}        absolute paths to every .md file
 */
function listAgentFiles(agentsDir) {
  const dir = path.join(agentsDir, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(dir, f));
}

function sha256(content) {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

function loadManifest(ctx) {
  if (!existsSync(ctx.manifestPath)) {
    throw new Error(`Manifest not found: ${ctx.manifestPath}`);
  }
  return JSON.parse(readFileSync(ctx.manifestPath, "utf8"));
}

function listCommandFiles(ctx) {
  const dir = path.join(ctx.repoRoot, ".claude", "commands");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `.claude/commands/${f}`);
}

function listSkillFilesRecursive(ctx) {
  const dir = path.join(ctx.repoRoot, ".claude", "skills");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const top = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(`.claude/skills/${entry.name}`);
    } else if (entry.isDirectory()) {
      // Anthropic-standard directory-form skills: look for SKILL.md inside.
      const inner = path.join(top, "SKILL.md");
      if (existsSync(inner)) out.push(`.claude/skills/${entry.name}/SKILL.md`);
    }
  }
  return out;
}

/**
 * Validate `.claude/skills-manifest.json`:
 *   - every indexed file exists on disk
 *   - recorded sha256 checksum matches the current file contents
 *   - no file on disk under `.claude/commands/` or `.claude/skills/` is
 *     orphaned (i.e. missing from the manifest)
 *   - the `dependencies[]` DAG has no cycles
 *
 * @param {import('./spec-harness-lib.mjs').HarnessContext} ctx
 * @returns {{
 *   ok: boolean,
 *   errors: import('./lib/errors.mjs').ValidationError[],
 *   manifest: any
 * }}
 */
export function validateManifest(ctx) {
  const errors = [];
  const manifest = loadManifest(ctx);
  const entryPaths = new Set(manifest.skills.map((s) => s.path));

  for (const skill of manifest.skills) {
    const abs = path.join(ctx.repoRoot, skill.path);
    if (!existsSync(abs)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.MANIFEST_ENTRY_MISSING,
        category: "manifest",
        file: skill.path,
        message: `File not found: ${skill.path}`,
        hint: "remove the manifest entry or restore the file on disk",
      }));
      continue;
    }
    const actual = sha256(readFileSync(abs, "utf8"));
    if (actual !== skill.checksum) {
      errors.push(new ValidationError({
        code: ERROR_CODES.MANIFEST_CHECKSUM_MISMATCH,
        category: "manifest",
        file: skill.path,
        expected: skill.checksum,
        got: actual,
        message: `Checksum mismatch for ${skill.name}: expected ${skill.checksum}, got ${actual}`,
        hint: "run `node plugins/dotclaude/scripts/auto-update-manifest.mjs` to refresh checksums",
      }));
    }
  }

  const onDisk = [...listCommandFiles(ctx), ...listSkillFilesRecursive(ctx)];
  for (const p of onDisk) {
    if (!entryPaths.has(p)) {
      errors.push(new ValidationError({
        code: ERROR_CODES.MANIFEST_ORPHAN_FILE,
        category: "manifest",
        file: p,
        message: `Orphan on disk (not in manifest): ${p}`,
        hint: "add the file to .claude/skills-manifest.json or delete it",
      }));
    }
  }

  // DAG check — no cycles in dependencies[].
  const graph = new Map(manifest.skills.map((s) => [s.name, s.dependencies ?? []]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const name of graph.keys()) color.set(name, WHITE);
  function visit(name, stack) {
    if (color.get(name) === GRAY) {
      errors.push(new ValidationError({
        code: ERROR_CODES.MANIFEST_DEPENDENCY_CYCLE,
        category: "manifest",
        file: ".claude/skills-manifest.json",
        got: stack.concat(name).join(" -> "),
        message: `Dependency cycle: ${stack.concat(name).join(" -> ")}`,
      }));
      return;
    }
    if (color.get(name) === BLACK) return;
    color.set(name, GRAY);
    for (const dep of graph.get(name) ?? []) {
      if (graph.has(dep)) visit(dep, stack.concat(name));
    }
    color.set(name, BLACK);
  }
  for (const name of graph.keys()) visit(name, []);

  return { ok: errors.length === 0, errors, manifest };
}

/**
 * Recompute every sha256 in `.claude/skills-manifest.json` from the current
 * contents on disk and write the manifest back in place. Does not validate
 * anything — pair with {@link validateManifest} to confirm the result.
 *
 * @param {import('./spec-harness-lib.mjs').HarnessContext} ctx
 * @returns {any}   The in-memory manifest object just written to disk.
 */
export function refreshChecksums(ctx) {
  const manifest = loadManifest(ctx);
  for (const skill of manifest.skills) {
    const abs = path.join(ctx.repoRoot, skill.path);
    if (!existsSync(abs)) continue;
    skill.checksum = sha256(readFileSync(abs, "utf8"));
    skill.lastValidated = new Date().toISOString().slice(0, 10);
  }
  manifest.generatedAt = new Date().toISOString();
  writeFileSync(ctx.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/**
 * Validate agent `.md` files found under `<agentsDir>/agents/*.md`.
 *
 * Each agent file must have YAML frontmatter with four required fields:
 *   - `name`        non-empty string
 *   - `description` non-empty string
 *   - `tools`       non-empty string
 *   - `model`       one of: opus | sonnet | haiku | inherit
 *
 * Security checks:
 *   - SEC-1: warn on common secret patterns in the file body
 *   - SEC-2: agents whose name contains auditor/reviewer/inspector must not
 *             list Write or Edit in `tools:`
 *
 * @param {string} agentsDir  Absolute path to the directory that contains an
 *                            `agents/` sub-folder (e.g. the repo root or a
 *                            `.claude/` dir).
 * @returns {{ ok: boolean, errors: ValidationError[], warnings: ValidationError[] }}
 */
export function validateAgents(agentsDir) {
  const errors = [];
  const warnings = [];

  const agentFiles = listAgentFiles(agentsDir);

  for (const absPath of agentFiles) {
    const relPath = path.relative(agentsDir, absPath);
    const content = readFileSync(absPath, "utf8");
    const lines = content.split("\n");

    // --- frontmatter ---
    const fm = parseFrontmatter(content);
    if (!fm) {
      errors.push(new ValidationError({
        code: ERROR_CODES.AGENT_MISSING_FIELD,
        category: "agent",
        file: relPath,
        line: 1,
        message: `missing YAML frontmatter (no --- block found)`,
        hint: "add --- frontmatter with name, description, tools, and model fields",
      }));
      continue;
    }

    // Required fields
    for (const field of ["name", "description", "tools", "model"]) {
      const val = fm.fields.get(field);
      if (!val || val.trim() === "") {
        // Compute the line number of the field (or default to 1)
        let fieldLine = 1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === "---" && i > 0) break;
          if (lines[i].match(new RegExp(`^${field}\\s*:`))) {
            fieldLine = i + 1;
            break;
          }
        }
        errors.push(new ValidationError({
          code: ERROR_CODES.AGENT_MISSING_FIELD,
          category: "agent",
          file: relPath,
          line: fieldLine,
          message: `missing required field: ${field}`,
          hint: `add \`${field}:\` to the frontmatter`,
        }));
      }
    }

    // model value validation (only if model field is present)
    const modelVal = fm.fields.get("model");
    if (modelVal && modelVal.trim() !== "" && !VALID_MODELS.has(modelVal.trim())) {
      let modelLine = 1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/^model\s*:/)) { modelLine = i + 1; break; }
      }
      errors.push(new ValidationError({
        code: ERROR_CODES.AGENT_INVALID_MODEL,
        category: "agent",
        file: relPath,
        line: modelLine,
        got: modelVal.trim(),
        expected: "opus|sonnet|haiku|inherit",
        message: `model value "${modelVal.trim()}" is not valid (must be opus|sonnet|haiku|inherit)`,
        hint: `change model to one of: opus, sonnet, haiku, inherit`,
      }));
    }

    // SEC-2: read-only agents must not have Write or Edit in tools
    const nameVal = (fm.fields.get("name") ?? "").trim();
    const toolsVal = (fm.fields.get("tools") ?? "").trim();
    const isReadonly = READONLY_PATTERNS.some((p) => p.test(nameVal));
    if (isReadonly) {
      const toolsList = toolsVal.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
      const badTools = WRITE_TOOLS.filter((t) => toolsList.includes(t));
      if (badTools.length > 0) {
        let toolsLine = 1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].match(/^tools\s*:/)) { toolsLine = i + 1; break; }
        }
        errors.push(new ValidationError({
          code: ERROR_CODES.AGENT_WRITE_TOOL_IN_READONLY,
          category: "agent",
          file: relPath,
          line: toolsLine,
          got: badTools.join(", "),
          message: `read-only agent has write tools: ${badTools.join(", ")}`,
          hint: `remove ${badTools.join(", ")} from tools: — this agent is designated read-only (name matches auditor/reviewer/inspector)`,
        }));
      }
    }

    // SEC-1: scan body lines for secret patterns (body starts after frontmatter)
    const bodyStart = fm.bodyStartLine - 1; // convert to 0-indexed
    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i];
      for (const { pattern, label } of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          warnings.push(new ValidationError({
            code: ERROR_CODES.AGENT_SECRET_PATTERN,
            category: "agent",
            file: relPath,
            line: i + 1,
            message: `possible secret pattern: "${label}"`,
            hint: "remove or redact the secret; never commit credentials in agent files",
          }));
          break; // one warning per line is enough
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Detect trigger keyword overlap between agents. Each agent's `description`
 * frontmatter contains a "Triggers on:" sentence with quoted phrases; if the
 * same phrase appears in two or more agents' trigger lists without an explicit
 * cross-reference in the agents' `## Collaboration` section, that's a routing
 * ambiguity — Claude's dispatcher will pick non-deterministically.
 *
 * Advisory by default. Use `--strict` in the CLI to promote warnings to errors.
 *
 * @param {string} agentsDir  Absolute path to the directory that contains an
 *                            `agents/` sub-folder.
 * @returns {{ ok: boolean, errors: ValidationError[], warnings: ValidationError[] }}
 */
export function validateAgentTriggerOverlap(agentsDir) {
  const errors = [];
  const warnings = [];

  const agentFiles = listAgentFiles(agentsDir);

  // keyword (lowercased) → array of { agentName, file }
  const triggerIndex = new Map();
  // agentName → { collaborationText: string, file: string }
  const collaborationByAgent = new Map();

  for (const absPath of agentFiles) {
    const relPath = path.relative(agentsDir, absPath);
    const content = readFileSync(absPath, "utf8");
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const name = (fm.fields.get("name") ?? "").trim();
    const description = fm.fields.get("description") ?? "";
    if (!name || !description) continue;

    // Extract quoted trigger phrases. Match all "..." inside the description.
    const quoted = description.match(/"([^"]+)"/g) ?? [];
    for (const raw of quoted) {
      const keyword = raw.slice(1, -1).trim().toLowerCase();
      if (!keyword) continue;
      if (!triggerIndex.has(keyword)) triggerIndex.set(keyword, []);
      triggerIndex.get(keyword).push({ agentName: name, file: relPath });
    }

    // Capture the body text after `## Collaboration` so we can check whether
    // an overlapping agent is explicitly cross-referenced there.
    const collabMatch = content.match(/##\s+Collaboration[\s\S]*$/i);
    collaborationByAgent.set(name, {
      collaborationText: collabMatch ? collabMatch[0] : "",
      file: relPath,
    });
  }

  for (const [keyword, claimants] of triggerIndex) {
    if (claimants.length < 2) continue;
    const names = claimants.map((c) => c.agentName);

    // Check whether each claimant's collaboration section mentions at least
    // one of the other claimants by name.
    for (const claimant of claimants) {
      const otherNames = names.filter((n) => n !== claimant.agentName);
      const collab = collaborationByAgent.get(claimant.agentName)?.collaborationText ?? "";
      const referencesAny = otherNames.some((other) => collab.includes(other));
      if (!referencesAny) {
        warnings.push(new ValidationError({
          code: ERROR_CODES.AGENT_TRIGGER_OVERLAP,
          category: "agent",
          file: claimant.file,
          message: `trigger "${keyword}" also claimed by: ${otherNames.join(", ")} — but ## Collaboration does not reference them`,
          hint: `add a handoff line in ## Collaboration naming one of: ${otherNames.join(", ")}, or narrow the trigger keyword to disambiguate`,
        }));
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
