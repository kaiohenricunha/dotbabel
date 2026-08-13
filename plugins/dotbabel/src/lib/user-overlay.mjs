/**
 * user-overlay.mjs — user-scope rule-floor overlay machinery for #228.
 *
 * Background. Pre-2.7.0, `~/.claude/CLAUDE.md` was a symlink straight to
 * dotbabel's repo `CLAUDE.md`. That made personal additions unsafe — any
 * edit went into dotbabel's source. This module replaces that symlink with
 * a generated file: `<canonical content>` followed by a marker-delimited
 * overlay block populated from `~/.config/dotbabel/local-rules.md`. Users
 * own the overlay file; bootstrap regenerates the merged user-scope file
 * on every run, backing up direct edits before overwriting.
 *
 * Exports:
 *   USER_OVERLAY_BEGIN / USER_OVERLAY_END  marker constants
 *   NO_OVERLAY_PLACEHOLDER                 rendered when no overlay content
 *   composeUserScopeClaudeMd               pure compose function
 *   resolveLocalRulesPath                  env -> overlay path
 *   writeUserScopeClaudeMd                 the bootstrap-side write driver
 *
 * @module lib/user-overlay
 */

import fs from "node:fs";
import path from "node:path";

/** Marker that opens the user-overlay block in `~/.claude/CLAUDE.md`. */
export const USER_OVERLAY_BEGIN = "<!-- dotbabel:user-overlay:begin -->";
/** Marker that closes the user-overlay block in `~/.claude/CLAUDE.md`. */
export const USER_OVERLAY_END = "<!-- dotbabel:user-overlay:end -->";
/**
 * Rendered between the user-overlay markers when no overlay content
 * applies (file absent, or empty/whitespace-only). All three "no real
 * overlay" states render identically so users see the same shape
 * regardless of whether they created an empty file or no file at all.
 */
export const NO_OVERLAY_PLACEHOLDER = "(no user overlay)";

/**
 * Compose the merged user-scope CLAUDE.md content from canonical + overlay.
 *
 * Contract:
 *   - The canonical content is emitted with its trailing whitespace trimmed
 *     so the overlay block sits below exactly one blank line.
 *   - If `overlay` is `null`, an empty string, or whitespace-only after
 *     trim, the user-overlay block contains the literal NO_OVERLAY_PLACEHOLDER
 *     ("(no user overlay)") on its own line. All three states render
 *     identically so users see the same shape regardless of whether they
 *     created an empty file or no file at all.
 *   - Otherwise, the trimmed overlay content sits between the markers,
 *     followed by exactly one trailing newline before the close marker.
 *   - Output ends with exactly one trailing `\n` so:
 *     `compose(canonical, x) === compose(canonical, x)` byte-equal across
 *     runs, and trim-equivalent overlays produce identical output.
 *
 * @param {string} canonical    Full content of dotbabel's repo CLAUDE.md.
 * @param {string|null|undefined} overlay  Contents of local-rules.md, or
 *   null/empty/whitespace-only when no overlay applies.
 * @returns {string}
 */
export function composeUserScopeClaudeMd(canonical, overlay) {
  const canonicalBody = canonical.replace(/\s+$/, "");
  const overlayTrimmed =
    overlay == null ? "" : overlay.replace(/^\s+|\s+$/g, "");
  const overlayBody =
    overlayTrimmed === "" ? NO_OVERLAY_PLACEHOLDER : overlayTrimmed;
  return `${canonicalBody}\n\n${USER_OVERLAY_BEGIN}\n${overlayBody}\n${USER_OVERLAY_END}\n`;
}

/**
 * Resolve the user-overlay source path from environment.
 *
 * Priority:
 *   1. `env.DOTBABEL_LOCAL_RULES` — explicit override (tests + power users).
 *   2. `${env.XDG_CONFIG_HOME ?? env.HOME + "/.config"}/dotbabel/local-rules.md`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}  Absolute path; the file may or may not exist.
 */
export function resolveLocalRulesPath(env) {
  if (env.DOTBABEL_LOCAL_RULES) return env.DOTBABEL_LOCAL_RULES;
  const configHome = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? "", ".config");
  return path.join(configHome, "dotbabel", "local-rules.md");
}

/**
 * @typedef {object} WriteResult
 * @property {'created'|'unchanged'|'migrated'|'regenerated'} action
 * @property {string} [bakPath]   Backup path (set when action === 'migrated' or 'regenerated')
 */

/**
 * Write `~/.claude/CLAUDE.md` (or the supplied target) as a generated file
 * containing the canonical content + user-overlay block. Backs up any
 * pre-existing real file or symlink before overwriting.
 *
 * @param {object} cfg
 * @param {string} cfg.canonicalSrc  Path to dotbabel's repo CLAUDE.md.
 * @param {string} cfg.target        Destination, typically `~/.claude/CLAUDE.md`.
 * @param {string} cfg.overlaySrc    Path to local-rules.md (may not exist).
 * @param {import('./output.mjs').Output} cfg.out
 * @param {string} cfg.timestamp     YYYYMMDD-HHmmss for backup suffix.
 * @returns {WriteResult}
 */
export function writeUserScopeClaudeMd({
  canonicalSrc,
  target,
  overlaySrc,
  out,
  timestamp,
}) {
  const canonical = fs.readFileSync(canonicalSrc, "utf8");
  const overlay = fs.existsSync(overlaySrc)
    ? fs.readFileSync(overlaySrc, "utf8")
    : null;
  const expected = composeUserScopeClaudeMd(canonical, overlay);

  let lstat = null;
  try {
    lstat = fs.lstatSync(target);
  } catch {
    // target doesn't exist
  }

  if (lstat === null) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, expected);
    out.pass(`generated: ${target}`);
    return { action: "created" };
  }

  if (lstat.isSymbolicLink()) {
    const bakPath = `${target}.bak-${timestamp}`;
    fs.renameSync(target, bakPath);
    fs.writeFileSync(target, expected);
    out.warn(`migrated symlink to generated file: ${target} (old at ${bakPath})`);
    return { action: "migrated", bakPath };
  }

  // Real file. Compare against expected.
  const actual = fs.readFileSync(target, "utf8");
  if (actual === expected) {
    out.pass(`ok: ${target}`);
    return { action: "unchanged" };
  }

  const bakPath = `${target}.bak-${timestamp}`;
  fs.renameSync(target, bakPath);
  fs.writeFileSync(target, expected);
  out.warn(`backed up + regenerated: ${target} (old at ${bakPath})`);
  return { action: "regenerated", bakPath };
}
