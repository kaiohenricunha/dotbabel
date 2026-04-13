import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import path from "path";

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

export function validateManifest(ctx) {
  const errors = [];
  const manifest = loadManifest(ctx);
  const entryPaths = new Set(manifest.skills.map((s) => s.path));

  for (const skill of manifest.skills) {
    const abs = path.join(ctx.repoRoot, skill.path);
    if (!existsSync(abs)) {
      errors.push(`File not found: ${skill.path}`);
      continue;
    }
    const actual = sha256(readFileSync(abs, "utf8"));
    if (actual !== skill.checksum) {
      errors.push(`Checksum mismatch for ${skill.name}: expected ${skill.checksum}, got ${actual}`);
    }
  }

  const onDisk = [...listCommandFiles(ctx), ...listSkillFilesRecursive(ctx)];
  for (const p of onDisk) {
    if (!entryPaths.has(p)) {
      errors.push(`Orphan on disk (not in manifest): ${p}`);
    }
  }

  // DAG check — no cycles in dependencies[].
  const graph = new Map(manifest.skills.map((s) => [s.name, s.dependencies ?? []]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const name of graph.keys()) color.set(name, WHITE);
  function visit(name, stack) {
    if (color.get(name) === GRAY) {
      errors.push(`Dependency cycle: ${stack.concat(name).join(" -> ")}`);
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
