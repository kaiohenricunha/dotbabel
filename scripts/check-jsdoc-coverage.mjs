#!/usr/bin/env node
/**
 * Verifies every `export` in the target directory tree is preceded by a
 * JSDoc block (`/** … *\/`). Re-exports (`export { foo } from "./x"`) and
 * the barrel's type-import helpers are treated as already-documented.
 *
 * Usage:
 *   node scripts/check-jsdoc-coverage.mjs [dir ...]
 *
 * Defaults to `plugins/dotclaude/src/` when no argument is passed. Exits 0 on
 * full coverage, 1 on any uncovered export.
 *
 * Intentionally dependency-free — mirrors the zero-runtime-deps promise in
 * `package.json` and ADR-0002.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";

const argv = process.argv.slice(2);
const roots = argv.length > 0 ? argv : ["plugins/dotclaude/src"];

/**
 * Walk a directory recursively, yielding every `.mjs` file.
 * @param {string} dir
 * @returns {string[]}
 */
function walkMjs(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMjs(abs));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Scan one `.mjs` file and return each uncovered export location.
 *
 * An export is "covered" when the immediately-preceding non-blank line
 * belongs to a JSDoc block (`/** …` … ` *\/`). Re-exports and export
 * declarations that wrap a re-export (`export { … } from …`) are skipped —
 * the original declaration (in the referenced module) is what needs JSDoc.
 *
 * @param {string} file
 * @returns {{ line: number, snippet: string }[]}
 */
function findUncoveredExports(file) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  /** @type {{ line: number, snippet: string }[]} */
  const uncovered = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith("export ")) continue;

    // Skip pure re-exports: `export { foo } from "./x";` and `export * from …`.
    if (/^export\s+\{[^}]*\}\s+from\s+/.test(trimmed)) continue;
    if (/^export\s+\*\s+from\s+/.test(trimmed)) continue;
    if (/^export\s+\{[^}]*\};?\s*$/.test(trimmed)) continue;
    if (/^export\s+default\b/.test(trimmed) && !/^export\s+default\s+(function|class)/.test(trimmed)) continue;

    // Only named declarations that introduce a symbol count.
    if (!/^export\s+(async\s+)?(function|class|const|let|var)\b/.test(trimmed)) continue;

    // Walk backwards past blank lines to find the preceding non-empty line.
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j -= 1;
    const prev = j >= 0 ? lines[j].trim() : "";

    if (prev.endsWith("*/")) continue;

    uncovered.push({ line: i + 1, snippet: trimmed });
  }
  return uncovered;
}

let total = 0;
let uncoveredTotal = 0;
/** @type {string[]} */
const report = [];

for (const root of roots) {
  const abs = resolve(root);
  let files;
  try {
    if (!statSync(abs).isDirectory()) {
      files = [abs];
    } else {
      files = walkMjs(abs);
    }
  } catch (err) {
    process.stderr.write(`check-jsdoc-coverage: cannot scan ${root}: ${err.message}\n`);
    process.exit(2);
  }
  for (const file of files) {
    total += 1;
    const uncovered = findUncoveredExports(file);
    if (uncovered.length === 0) continue;
    uncoveredTotal += uncovered.length;
    const rel = relative(process.cwd(), file).split(sep).join("/");
    for (const { line, snippet } of uncovered) {
      report.push(`  ${rel}:${line}  ${snippet}`);
    }
  }
}

if (uncoveredTotal === 0) {
  process.stdout.write(`check-jsdoc-coverage: ok — ${total} file(s) scanned, every export documented.\n`);
  process.exit(0);
}

process.stderr.write(`check-jsdoc-coverage: ${uncoveredTotal} export(s) missing JSDoc across ${total} file(s):\n`);
for (const row of report) process.stderr.write(`${row}\n`);
process.exit(1);
