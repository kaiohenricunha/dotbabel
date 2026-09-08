import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { matchesGlob } from "../spec-harness-lib.mjs";

/** List every tracked and untracked repository file, or walk the tree without Git. */
export function listRepositoryFiles(repoRoot) {
  try {
    const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(tracked.split("\n").filter(Boolean))].sort();
  } catch {
    const files = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", ".venv", "vendor"].includes(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile()) files.push(path.relative(repoRoot, absolute).replaceAll(path.sep, "/"));
      }
    }
    walk(repoRoot);
    return files.sort();
  }
}

/**
 * Normalize CLI path-scope patterns into repository-relative POSIX patterns.
 * Throws a plain Error so a caller can exit with a usage code.
 */
export function normalizePathScope(values = []) {
  const result = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) throw new Error("--path must be a non-empty repository-relative path");
    if (path.isAbsolute(value)) throw new Error(`--path must be repository-relative: ${value}`);
    const normalized = path.posix.normalize(value.replaceAll("\\", "/")).replace(/\/+$/, "");
    if (normalized === ".." || normalized.startsWith("../")) throw new Error(`--path must not escape the repository: ${value}`);
    if (normalized === "" || normalized === ".") continue;
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

/**
 * Return true when a file is inside the path scope.
 * A glob-free pattern is a directory prefix; a pattern with `*` or `?` is a glob.
 */
export function matchesPathScope(patterns = [], file) {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => (/[*?]/.test(pattern) ? matchesGlob(pattern, file) : file === pattern || file.startsWith(`${pattern}/`)));
}
