import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";
import { GIT_MAX_BUFFER } from "../lib/limits.mjs";
import { matchesGlob } from "../spec-harness-lib.mjs";

function walkTree(repoRoot) {
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

/**
 * True when the directory is inside a Git work tree.
 *
 * Probing beats matching stderr text, which Git translates. This runs only on
 * the failure path, so the extra process is off the hot path. When Git itself
 * is missing there is nothing to ask, so fall back to the presence of `.git`:
 * guessing "not a repository" there would return a `.gitignore`-blind list for
 * a real repository.
 */
function insideGitRepository(repoRoot) {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return fs.existsSync(path.join(repoRoot, ".git"));
    return false;
  }
}

/**
 * List every tracked and untracked repository file, or walk the tree when the
 * directory is not a Git repository.
 *
 * The walk is a last resort, not an error handler: it does not honour
 * `.gitignore`, so falling back to it inside a real repository would silently
 * promote build artifacts to repository files. Anything that is not a clean
 * "this is not a repository" therefore fails loud.
 *
 * @param {string} repoRoot Repository root.
 * @param {{ maxBuffer?: number }} [options] `maxBuffer` is an internal test seam.
 * @returns {string[]} Sorted repository-relative paths.
 */
export function listRepositoryFiles(repoRoot, { maxBuffer = GIT_MAX_BUFFER } = {}) {
  try {
    const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer });
    return [...new Set(tracked.split("\n").filter(Boolean))].sort();
  } catch (error) {
    // An overflow says nothing about whether this is a repository, and the
    // truncated list would be a wrong answer, so never probe past it.
    if (error?.code !== "ENOBUFS" && !insideGitRepository(repoRoot)) return walkTree(repoRoot);
    const overflow = error?.code === "ENOBUFS";
    const stderr = String(error?.stderr ?? "").trim().split("\n").filter(Boolean).at(-1);
    throw new ValidationError({
      code: ERROR_CODES.QUALITY_SCOPE_UNAVAILABLE,
      category: "quality",
      message: `git ls-files failed: ${overflow ? `the repository file list exceeded the ${GIT_MAX_BUFFER / 1024 / 1024} MiB read limit` : stderr || error?.message || "unknown failure"}`,
      hint: overflow
        ? "exclude vendored or generated trees from the repository, or raise the limit"
        : "run git ls-files -co --exclude-standard in the repository to see the full output",
    });
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
