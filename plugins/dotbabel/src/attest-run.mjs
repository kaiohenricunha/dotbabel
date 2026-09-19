/**
 * The run manifest: what `local-attest` learned during one matrix run, kept so
 * that a later tool can reuse it instead of learning it again.
 *
 * The invariant is the one the landing flow is built on: expensive
 * deterministic evidence is generated once per commit SHA and reused until that
 * SHA changes. The attestation comment already applies it at the merge
 * boundary. This applies it one level down, between the matrix legs of a single
 * run — `lint`, `test`, and a `quality` leg that internally re-ran both.
 *
 * Nothing here is a cache in the time-based sense. There is no expiry, no
 * mtime heuristic, and no "recent enough". A record is usable only when it is
 * provably about THIS tree:
 *
 *   - the manifest names the exact head the reader is on;
 *   - the working tree is clean, so the head describes what is on disk;
 *   - the leg it would stand in for actually passed;
 *   - every report file the reader would parse still hashes to the digest the
 *     leg recorded when it wrote it.
 *
 * Every refusal is the fail-safe direction. The reader runs the tool itself:
 * slower, never wrong. Reuse can therefore only ever remove redundant work; it
 * cannot turn an unrun check into a pass.
 *
 * Pure apart from the `node:fs` and `node:crypto` calls in the persistence and
 * hashing helpers. {@link decideReuse} takes its filesystem access as an
 * argument so the decision itself is testable without a disk.
 *
 * @typedef {object} ProducedReport
 * @property {string} path   Repository-relative, forward-slashed.
 * @property {string} sha256 `"sha256:<64 hex>"` of the file as the leg left it.
 *
 * @typedef {object} LegRecord
 * @property {string} mode
 * @property {string} status  A `legStatus()` value: pass | fail | advisory-fail | skipped | not-run.
 * @property {string} finished_at
 * @property {ProducedReport[]} produces
 *
 * @typedef {object} RunManifest
 * @property {1} schema_version
 * @property {string} head_sha
 * @property {string} started_at
 * @property {Record<string, LegRecord>} legs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The manifest's location relative to a repository's git directory.
 *
 * It lives INSIDE the git directory, not the working tree. An earlier version
 * wrote `.dotbabel/attest-run.json` into the working tree on the assumption
 * that `.dotbabel/` is gitignored. That holds in this repository and not in a
 * consumer's: there the untracked directory tripped `local-attest`'s own
 * post-matrix clean-tree check and aborted every run. A file under the git
 * directory can never appear in `git status`, whatever a repository ignores.
 */
export const ATTEST_RUN_FILE = "dotbabel/attest-run.json";

/**
 * Absolute path of the manifest for the repository containing `repoRoot`.
 *
 * `--absolute-git-dir` rather than `--git-path`: for a linked worktree it names
 * that worktree's own directory, so two worktrees at different heads keep
 * separate manifests instead of overwriting one shared file. Outside a git
 * repository there is no `git status` to pollute, so a plain `.dotbabel/`
 * directory is the fallback.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function attestRunPath(repoRoot) {
  try {
    const gitDir = execFileSync("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitDir !== "") return join(resolve(repoRoot, gitDir), ATTEST_RUN_FILE);
  } catch {
    // Not a git repository, or git is unavailable.
  }
  return join(repoRoot, ".dotbabel", "attest-run.json");
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Start an empty manifest for a run at `headSha`.
 *
 * @param {{ headSha: string, now?: Date }} input
 * @returns {RunManifest}
 */
export function createRunManifest({ headSha, now }) {
  return { schema_version: 1, head_sha: headSha, started_at: (now ?? new Date()).toISOString(), legs: {} };
}

/**
 * Return a copy of `manifest` with one leg's outcome recorded.
 *
 * Immutable so a caller holding the previous value cannot be surprised by a
 * later write, and last-write-wins per leg name so a re-run replaces rather
 * than accumulates.
 *
 * @param {RunManifest} manifest
 * @param {{ name: string, mode: string, status: string, produces?: ProducedReport[], now?: Date }} leg
 * @returns {RunManifest}
 */
export function recordLeg(manifest, { name, mode, status, produces = [], now }) {
  return {
    ...manifest,
    legs: {
      ...manifest.legs,
      [name]: { mode, status, finished_at: (now ?? new Date()).toISOString(), produces },
    },
  };
}

/**
 * SHA-256 of a file's bytes, in the `sha256:<hex>` form the manifest records.
 * Throws when the file is unreadable — an unhashable report is not one that
 * matches, and swallowing the error would read as "no change".
 *
 * @param {string} absolutePath
 * @returns {string}
 */
export function sha256File(absolutePath) {
  return `sha256:${createHash("sha256").update(readFileSync(absolutePath)).digest("hex")}`;
}

/**
 * Persist a manifest atomically, into the git directory (see {@link ATTEST_RUN_FILE}).
 *
 * Written to a sibling temporary file and renamed into place, so a reader
 * racing a leg that finishes mid-run sees the previous complete manifest or the
 * new complete one, never a torn one. A half-written file would parse as junk
 * and be refused anyway, but "refused" costs the caller a full re-run.
 *
 * @param {string} repoRoot
 * @param {RunManifest} manifest
 * @returns {void}
 */
export function writeRunManifest(repoRoot, manifest) {
  const target = attestRunPath(repoRoot);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temp, target);
}

/**
 * Read the manifest, or null when there is none worth trusting.
 *
 * Absent, unparseable, wrong-versioned and structurally wrong all collapse to
 * null on purpose: the caller's only sound response to any of them is to run
 * the tool itself, so distinguishing them would only invite handling one
 * differently.
 *
 * @param {string} repoRoot
 * @returns {RunManifest|null}
 */
export function readRunManifest(repoRoot) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(attestRunPath(repoRoot), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.schema_version !== 1) return null;
  if (typeof parsed.head_sha !== "string" || !SHA_RE.test(parsed.head_sha)) return null;
  if (parsed.legs === null || typeof parsed.legs !== "object" || Array.isArray(parsed.legs)) return null;
  return /** @type {RunManifest} */ (parsed);
}

/**
 * Decide whether a leg's recorded result may stand in for running a tool.
 *
 * Checks run cheapest and most decisive first, and the filesystem is touched
 * only once every check that does not need it has passed.
 *
 * @param {{ manifest: RunManifest|null, headSha: string, treeClean: boolean|undefined,
 *           leg: string, reportPaths: string[], hashFile: (repoRelativePath: string) => string }} input
 * @returns {{ ok: true, headSha: string, leg: string } | { ok: false, reason: string }}
 */
export function decideReuse({ manifest, headSha, treeClean, leg, reportPaths, hashFile }) {
  if (manifest === null || manifest === undefined) return { ok: false, reason: "NO_MANIFEST" };
  // Full-SHA equality: an abbreviation can match more than one commit.
  if (manifest.head_sha.toLowerCase() !== String(headSha).toLowerCase()) return { ok: false, reason: "HEAD_MISMATCH" };
  // Strictly `true`. An unknown tree state is not a clean one.
  if (treeClean !== true) return { ok: false, reason: "DIRTY_TREE" };

  const record = manifest.legs[leg];
  if (record === undefined) return { ok: false, reason: "LEG_MISSING" };
  if (record.status !== "pass") return { ok: false, reason: "LEG_NOT_PASSED" };

  const produced = new Map((record.produces ?? []).map((p) => [p.path, p.sha256]));
  for (const path of reportPaths) {
    if (!produced.has(path)) return { ok: false, reason: "REPORT_NOT_PRODUCED" };
  }
  for (const path of reportPaths) {
    let actual;
    try {
      actual = hashFile(path);
    } catch {
      return { ok: false, reason: "REPORT_UNREADABLE" };
    }
    if (actual !== produced.get(path)) return { ok: false, reason: "REPORT_CHANGED" };
  }
  return { ok: true, headSha: manifest.head_sha, leg };
}
