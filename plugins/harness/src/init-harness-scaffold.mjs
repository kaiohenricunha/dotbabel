import fs from "fs";
import path from "path";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

// Map template subtree prefixes to target prefixes
const PREFIX_MAP = [
  { from: "claude/", to: ".claude/" },
  { from: "docs/", to: "docs/" },
  { from: "workflows/", to: ".github/workflows/" },
];

function applyPrefixMap(relFromTemplates) {
  for (const { from, to } of PREFIX_MAP) {
    if (relFromTemplates.startsWith(from)) {
      return to + relFromTemplates.slice(from.length);
    }
  }
  // Fallback: keep as-is (shouldn't happen with well-formed templates/)
  return relFromTemplates;
}

function substitutePlaceholders(content, placeholders) {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(placeholders, key)
      ? placeholders[key]
      : match;
  });
}

/**
 * Walk a directory recursively, yielding file paths.
 * @param {string} dir - Absolute directory path to walk
 * @returns {string[]} Sorted list of absolute file paths
 */
function walkFiles(dir) {
  const results = [];
  const SKIP_DIRS = new Set([".git", "node_modules"]);

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(current, entry.name));
        }
      } else if (entry.isFile()) {
        results.push(path.join(current, entry.name));
      }
    }
  }

  walk(dir);
  return results.sort();
}

/**
 * Scaffold the harness template tree into a target repository.
 *
 * @param {{ templatesDir: string, targetDir: string, placeholders: object }} opts
 * @param {{ force?: boolean }} [options]
 * @returns {{ filesWritten: string[] }}
 */
export function scaffoldHarness(
  { templatesDir, targetDir, placeholders },
  { force = false } = {}
) {
  // Guard: refuse if already initialized
  if (!force) {
    const manifestPath = path.join(targetDir, ".claude", "skills-manifest.json");
    const specsPath = path.join(targetDir, "docs", "specs");
    if (fs.existsSync(manifestPath)) {
      throw new ValidationError({
        code: ERROR_CODES.SCAFFOLD_CONFLICT,
        category: "scaffold",
        file: manifestPath,
        message:
          `Repo already initialized: ${manifestPath} already exists. ` +
          `Use --force to overwrite.`,
        hint: "pass `{ force: true }` or remove .claude/skills-manifest.json",
      });
    }
    if (fs.existsSync(specsPath)) {
      throw new ValidationError({
        code: ERROR_CODES.SCAFFOLD_CONFLICT,
        category: "scaffold",
        file: specsPath,
        message:
          `Repo already initialized: ${specsPath} already exists. ` +
          `Use --force to overwrite.`,
        hint: "pass `{ force: true }` or remove docs/specs/",
      });
    }
  }

  const sourceFiles = walkFiles(templatesDir);
  const filesWritten = [];

  for (const srcAbs of sourceFiles) {
    const relFromTemplates = path.relative(templatesDir, srcAbs);
    const targetRel = applyPrefixMap(relFromTemplates);
    const destAbs = path.join(targetDir, targetRel);

    // Create parent directories
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });

    // Read, substitute, write
    const raw = fs.readFileSync(srcAbs, "utf8");
    const content = substitutePlaceholders(raw, placeholders);
    fs.writeFileSync(destAbs, content, "utf8");

    // Preserve executable bit from source
    const srcMode = fs.statSync(srcAbs).mode;
    if (srcMode & 0o111) {
      fs.chmodSync(destAbs, srcMode & 0o777);
    }

    filesWritten.push(targetRel);
  }

  return { filesWritten: filesWritten.sort() };
}
