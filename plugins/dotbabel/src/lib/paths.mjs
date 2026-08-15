/**
 * Canonical XDG path resolution for dotbabel state.
 *
 * Both helpers are pure joins — no filesystem probe, no legacy fallback. The
 * v1 (`dotclaude`) read-fallback layer that used to live in
 * `lib/legacy-compat.mjs` was removed in 3.0.0; see `docs/upgrade-guide.md`
 * for the migration steps a v1 install still needs.
 *
 * @module dotbabel/paths
 */

import { join } from "node:path";

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function xdgConfigHome(env) {
  return env.XDG_CONFIG_HOME || join(env.HOME || "", ".config");
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function xdgCacheHome(env) {
  return env.XDG_CACHE_HOME || join(env.HOME || "", ".cache");
}

/**
 * Returns the dotbabel config directory: `${XDG_CONFIG_HOME:-$HOME/.config}/dotbabel`.
 *
 * Resolved on every call so a test (or a caller that rewrites `process.env.HOME`)
 * sees the change without a module reload.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment to resolve from. Defaults to
 *   `process.env`; pass an explicit object to keep a caller hermetic in tests.
 * @returns {string}
 */
export function configDir(env = process.env) {
  return join(xdgConfigHome(env), "dotbabel");
}

/**
 * Returns the dotbabel cache directory: `${XDG_CACHE_HOME:-$HOME/.cache}/dotbabel`.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment to resolve from. Defaults to
 *   `process.env`.
 * @returns {string}
 */
export function cacheDir(env = process.env) {
  return join(xdgCacheHome(env), "dotbabel");
}
