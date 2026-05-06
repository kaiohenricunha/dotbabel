/**
 * Legacy-compat layer for the v1 (dotclaude) → v2 (dotbabel) rename.
 *
 * Reads transparently fall back to the legacy paths and env vars when the
 * canonical ones are absent. Writes always target canonical. One deprecation
 * warning per process per (code, var-name) pair.
 *
 * Stable warning codes (public contract — match these in CI or downstream
 * deprecation linters):
 *   DOTBABEL_LEGACY_CONFIG  — read fell back to ~/.config/dotclaude/
 *   DOTBABEL_LEGACY_CACHE   — read fell back to ~/.cache/dotclaude/
 *   DOTBABEL_LEGACY_ENV     — env var read fell back to DOTCLAUDE_*
 *
 * Compat removed in 3.0.0.
 *
 * @module dotbabel/legacy-compat
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const _emitted = new Set();

/**
 * @param {string} dedupeKey  internal Set key (e.g. "DOTBABEL_LEGACY_ENV:HANDOFF_REPO")
 * @param {string} message    user-facing message text
 * @param {string} code       stable public warning code (no per-call suffix)
 */
function warnOnce(dedupeKey, message, code) {
  if (_emitted.has(dedupeKey)) return;
  _emitted.add(dedupeKey);
  process.emitWarning(message, { code, type: "DeprecationWarning" });
}

function xdgConfigHome() {
  return process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config");
}

function xdgCacheHome() {
  return process.env.XDG_CACHE_HOME || join(process.env.HOME || "", ".cache");
}

/**
 * Returns the dotbabel config directory path. If the canonical path is absent
 * AND the legacy `~/.config/dotclaude/` directory exists, returns the legacy
 * path and emits a one-time DOTBABEL_LEGACY_CONFIG deprecation warning. If
 * neither exists, returns the canonical path (suitable as a first-write target).
 *
 * **READ-only contract.** Use this for reading existing files. Writes must go
 * through {@link canonicalConfigDir} so a v1 user with `~/.config/dotclaude/`
 * doesn't have new bootstrap state written back into the legacy directory —
 * the legacy directory must stay read-only so the user actually graduates to
 * `~/.config/dotbabel/` over time.
 *
 * @returns {string}
 */
export function configDir() {
  const canonical = join(xdgConfigHome(), "dotbabel");
  if (existsSync(canonical)) return canonical;
  const legacy = join(xdgConfigHome(), "dotclaude");
  if (existsSync(legacy)) {
    warnOnce(
      "DOTBABEL_LEGACY_CONFIG",
      `Reading config from ${legacy}; rename to ${canonical} (removal in 3.0.0)`,
      "DOTBABEL_LEGACY_CONFIG",
    );
    return legacy;
  }
  return canonical;
}

/**
 * Returns the canonical dotbabel config directory path with no legacy fallback.
 * **Always** `${XDG_CONFIG_HOME:-$HOME/.config}/dotbabel`, regardless of whether
 * `~/.config/dotclaude/` exists.
 *
 * Use this for **write paths** (bootstrap, persist) so the legacy directory
 * stays read-only and v1 users actively migrate to the new location.
 *
 * @returns {string}
 */
export function canonicalConfigDir() {
  return join(xdgConfigHome(), "dotbabel");
}

/**
 * Canonical-only counterpart of {@link cacheDir}, for symmetry. Use for any
 * cache-write call sites that should never target the legacy directory.
 *
 * @returns {string}
 */
export function canonicalCacheDir() {
  return join(xdgCacheHome(), "dotbabel");
}

/**
 * Same fallback semantics as {@link configDir} but for the cache directory.
 *
 * @returns {string}
 */
export function cacheDir() {
  const canonical = join(xdgCacheHome(), "dotbabel");
  if (existsSync(canonical)) return canonical;
  const legacy = join(xdgCacheHome(), "dotclaude");
  if (existsSync(legacy)) {
    warnOnce(
      "DOTBABEL_LEGACY_CACHE",
      `Reading cache from ${legacy}; rename to ${canonical} (removal in 3.0.0)`,
      "DOTBABEL_LEGACY_CACHE",
    );
    return legacy;
  }
  return canonical;
}

/**
 * Reads `DOTBABEL_<name>` from process.env, falling back to `DOTCLAUDE_<name>`.
 * Emits a DOTBABEL_LEGACY_ENV deprecation warning the first time a fallback
 * fires for a given variable.
 *
 * @param {string} name  variable name without prefix (e.g. "HANDOFF_REPO")
 * @returns {string | undefined}
 */
export function env(name) {
  const canonical = process.env[`DOTBABEL_${name}`];
  if (canonical !== undefined) return canonical;
  const legacy = process.env[`DOTCLAUDE_${name}`];
  if (legacy !== undefined) {
    warnOnce(
      `DOTBABEL_LEGACY_ENV:${name}`,
      `DOTCLAUDE_${name} is deprecated; use DOTBABEL_${name} (removal in 3.0.0)`,
      "DOTBABEL_LEGACY_ENV",
    );
    return legacy;
  }
  return undefined;
}

/**
 * Sets `DOTBABEL_<name>` in process.env. Never writes to `DOTCLAUDE_<name>`.
 *
 * @param {string} name
 * @param {string} value
 */
export function setEnv(name, value) {
  process.env[`DOTBABEL_${name}`] = value;
}

/**
 * Clears both `DOTBABEL_<name>` and `DOTCLAUDE_<name>` from process.env.
 * Used by error-recovery code that needs to wipe stale state.
 *
 * @param {string} name
 */
export function unsetEnv(name) {
  delete process.env[`DOTBABEL_${name}`];
  delete process.env[`DOTCLAUDE_${name}`];
}
