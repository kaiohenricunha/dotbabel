/**
 * Auto-preflight caching for handoff push/pull.
 *
 * Wraps the existing `plugins/dotclaude/scripts/handoff-doctor.sh` script with
 * a 5-minute TTL cache so users don't pay the preflight cost on every push and
 * so `push`/`pull` fail early with the doctor's structured remediation block
 * on misconfiguration, instead of emitting a cryptic `gh` / `git` error.
 *
 * Cache file: `$XDG_CACHE_HOME/dotclaude/handoff-doctor.json` (fallback
 * `$HOME/.cache/dotclaude/handoff-doctor.json`). Invalidated when the recorded
 * `repo` no longer matches `process.env.DOTCLAUDE_HANDOFF_REPO`, when the TTL
 * has expired, when the cache schema version differs, when the file is
 * corrupt or missing, or when the caller passes `verify: true`.
 *
 * The `doctor` verb still invokes the shell script directly for on-demand
 * diagnostics — it does not read or write this cache.
 */

import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { PreflightHandledError } from "./handoff-errors.mjs";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { runScript } from "./handoff-remote.mjs";
import { debug } from "./debug.mjs";

/** Cache schema version — increment to invalidate all existing entries. */
export const CACHE_SCHEMA_VERSION = 1;

/** 5 minutes per rollout-doc acceptance (docs/plans/handoff-issue-rollout.md). */
export const DOCTOR_CACHE_TTL_MS = 5 * 60 * 1000;

// SCRIPTS is duplicated from handoff-remote.mjs on purpose: handoff-remote.mjs
// imports from this module, so we can't import a non-hoisted `const` back
// without hitting a cyclic-init TDZ error.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolvePath(__dirname, "..", "..", "scripts");
/** Absolute path to the bundled `handoff-doctor.sh` preflight script. */
export const DOCTOR_SH = join(SCRIPTS, "handoff-doctor.sh");

/**
 * Resolve the doctor script to run. Honors `DOTCLAUDE_DOCTOR_SH` so the bats
 * suite can swap in a counter-shim without patching the shipped script. Any
 * production path leaves this unset and gets the bundled `handoff-doctor.sh`.
 */
function resolveDoctorScript() {
  const override = process.env.DOTCLAUDE_DOCTOR_SH;
  return override && override.length > 0 ? override : DOCTOR_SH;
}

/** Returns the directory that holds the preflight cache, honoring XDG_CACHE_HOME. */
export function currentCacheDir() {
  return join(process.env.XDG_CACHE_HOME || join(process.env.HOME || "", ".cache"), "dotclaude");
}

/** Returns the absolute path to the preflight cache file. */
export function currentCacheFile() {
  return join(currentCacheDir(), "handoff-doctor.json");
}

/** Returns `null` on any failure (missing, unreadable, unparseable) — treated as miss. */
export function readCache() {
  try {
    const raw = readFileSync(currentCacheFile(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code !== "ENOENT") debug("preflight:readCache", err);
    return null;
  }
}

/**
 * Returns true when a cache entry is valid and within the TTL window.
 * @param {unknown} entry - parsed JSON from the cache file, or null
 * @param {string} repo - the current transport repo URL
 * @param {number} now - `Date.now()` at call time
 */
export function isFresh(entry, repo, now) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.version !== CACHE_SCHEMA_VERSION) return false;
  if (entry.repo !== repo) return false;
  if (entry.status !== "ok") return false;
  const ts = Date.parse(entry.timestamp);
  if (!Number.isFinite(ts)) return false;
  return now - ts <= DOCTOR_CACHE_TTL_MS;
}

/**
 * Writes to a sibling tmp file and renames into place so a concurrent reader
 * never sees a half-written JSON blob.
 */
export function writeCacheAtomic(entry) {
  const final = currentCacheFile();
  mkdirSync(currentCacheDir(), { recursive: true });
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(entry) + "\n", "utf8");
    renameSync(tmp, final);
  } catch (err) {
    // Best-effort cleanup. Stray tmp files are self-healing — the next
    // successful preflight overwrites them.
    try {
      unlinkSync(tmp);
    } catch (cleanupErr) {
      if (cleanupErr?.code !== "ENOENT") debug("preflight:writeCacheAtomic:cleanup", cleanupErr);
    }
    throw err;
  }
}

/**
 * Auto-preflight before a push/pull. Returns silently when the cache is warm
 * (one informational line to stderr under `verbose`). Runs `handoff-doctor.sh`
 * otherwise; on failure, streams the doctor's remediation block to stderr
 * and throws. Throwing lets the bin's existing catch map it to exit 2.
 *
 * @param {{ repo: string, verify?: boolean, verbose?: boolean }} opts
 */
export function autoPreflight({ repo, verify = false, verbose = false }) {
  if (!verify) {
    const entry = readCache();
    const now = Date.now();
    if (isFresh(entry, repo, now)) {
      if (verbose) {
        const ageSec = Math.floor((now - Date.parse(entry.timestamp)) / 1000);
        process.stderr.write(`preflight: cache hit (age ${ageSec}s)\n`);
      }
      return;
    }
  }

  if (verbose) process.stderr.write("preflight: running handoff-doctor.sh\n");
  const r = runScript(resolveDoctorScript(), []);

  if (r.status !== 0) {
    // Always surface the remediation block — that's the whole point of doctor.
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    throw new PreflightHandledError();
  }

  if (verbose) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }

  writeCacheAtomic({
    version: CACHE_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    repo,
    status: "ok",
  });
}
