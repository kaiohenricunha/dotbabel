/**
 * Locate the nearest `package.json` above a starting directory.
 *
 * @module dotbabel/package-root
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Walk up from `startDir` to the nearest `package.json`, rather than a fixed
 * count of `".."` segments: a caller's own depth under the package root is an
 * implementation detail, and a fixed count is silently wrong (not a thrown
 * error) whenever that depth changes or the tree is nested unusually deeply,
 * such as inside a git worktree checked out under another worktree.
 *
 * @param {string} startDir
 * @returns {string} Absolute path to the nearest `package.json`.
 * @throws {Error} when no `package.json` exists above `startDir`.
 */
export function findPackageJson(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json found above ${startDir}`);
    dir = parent;
  }
}
