import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";
import { GIT_MAX_BUFFER } from "../lib/limits.mjs";
import { listRepositoryFiles, matchesPathScope } from "./paths.mjs";

function scopeFailure(args, error) {
  const overflow = error?.code === "ENOBUFS";
  const stderr = String(error?.stderr ?? "").trim().split("\n").filter(Boolean).at(-1);
  const reason = overflow
    ? `output exceeded the ${GIT_MAX_BUFFER / 1024 / 1024} MiB read limit`
    : stderr || error?.message || "unknown failure";
  return new ValidationError({
    code: ERROR_CODES.QUALITY_SCOPE_UNAVAILABLE,
    category: "quality",
    message: `git ${args.join(" ")} failed: ${reason}`,
    hint: overflow
      ? "compare against a nearer --base, or use --all to resolve scope from the file list instead of the diff"
      : "run the same git command in the repository to see the full output",
  });
}

/**
 * Run a read-only Git command inside the repository.
 *
 * `allowNonZeroExit` covers the one case where a non-zero exit is an *answer*
 * ("that revision does not exist"), never a failure to obtain one. A spawn
 * failure, a signal, or a buffer overflow is never an answer, so it always
 * throws: an empty diff exits 0 and returns "", which means returning "" on a
 * throw could only ever mask a real failure and pass a run that checked nothing.
 *
 * A spawn-level failure always sets a *string* `error.code` (`ENOBUFS`,
 * `ENOENT`), while a clean non-zero exit leaves it undefined and sets an
 * integer `error.status`. Checking `status` alone is not enough: a command
 * short enough to finish before Node kills it reports a buffer overflow as
 * `code: "ENOBUFS"` with `status: 0`.
 *
 * @param {string} repoRoot Repository root passed to `git -C`.
 * @param {string[]} args Git arguments.
 * @param {{ allowNonZeroExit?: boolean, maxBuffer?: number }} [options] `maxBuffer` is an internal test seam.
 * @returns {string} Trimmed stdout.
 */
function git(repoRoot, args, { allowNonZeroExit = false, maxBuffer = GIT_MAX_BUFFER } = {}) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer,
    }).trim();
  } catch (error) {
    const cleanExit = typeof error?.code !== "string" && Number.isInteger(error?.status);
    if (allowNonZeroExit && cleanExit) return "";
    throw scopeFailure(args, error);
  }
}

function existsRevision(repoRoot, revision, maxBuffer) {
  return Boolean(git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`], { allowNonZeroExit: true, maxBuffer }));
}

/** Resolve the comparison base without a provider-specific requirement. */
export function resolveBaseRevision({ repoRoot, base, env = process.env, configuredBase, maxBuffer } = {}) {
  const explicit = base ?? env.DOTBABEL_QUALITY_BASE ?? configuredBase;
  if (explicit !== undefined) {
    if (existsRevision(repoRoot, explicit, maxBuffer)) return explicit;
    throw new ValidationError({
      code: ERROR_CODES.QUALITY_BASE_UNAVAILABLE,
      category: "quality",
      message: `base revision is unavailable: ${explicit}`,
      hint: "fetch enough Git history or select an existing revision",
    });
  }
  const originHead = git(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowNonZeroExit: true, maxBuffer });
  for (const candidate of [originHead, "origin/main", "main", "master"].filter(Boolean)) {
    if (existsRevision(repoRoot, candidate, maxBuffer)) return candidate;
  }
  throw new ValidationError({
    code: ERROR_CODES.QUALITY_BASE_UNAVAILABLE,
    category: "quality",
    message: "base revision is unavailable",
    hint: "pass --base or fetch the repository default branch",
  });
}

function parseNameStatus(text) {
  const files = [];
  const renames = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const [status, first, second] = line.split("\t");
    if (status.startsWith("R")) {
      renames.push({ from: first, to: second });
      files.push({ path: second, status: "renamed", oldPath: first });
    } else {
      files.push({ path: first, status: status === "D" ? "deleted" : "changed" });
    }
  }
  return { files, renames };
}

function parseChangedLines(text) {
  const result = {};
  let current;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ b/")) current = line.slice(6);
    if (!current || !line.startsWith("@@")) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    result[current] ??= [];
    for (let index = 0; index < count; index++) result[current].push(start + index);
  }
  return result;
}

/** Resolve Git change scope, hunks, and rename information. */
export function resolveQualityScope({ repoRoot, base, head, env = process.env, configuredBase, paths = [], all = false, maxBuffer } = {}) {
  if (all) {
    // Whole-repository mode reads no diff, so it needs no base revision and
    // works on a shallow clone, a detached HEAD, and a repository with no
    // default branch. Every line counts as changed so changed-scope rules
    // evaluate across the repository.
    const files = listRepositoryFiles(repoRoot).filter((file) => matchesPathScope(paths, file));
    const changedLines = {};
    const changedFiles = [];
    for (const file of files) {
      const absolute = path.join(repoRoot, file);
      let count = 0;
      try { count = fs.lstatSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8").split("\n").length - 1 : 0; } catch { continue; }
      changedFiles.push({ path: file, status: "changed" });
      changedLines[file] = Array.from({ length: count }, (_, index) => index + 1);
    }
    return { baseRevision: null, headRevision: null, mergeBase: null, changedFiles, changedLines, renames: [], paths, all: true };
  }
  const baseRevision = resolveBaseRevision({ repoRoot, base, env, configuredBase, maxBuffer });
  const headRevision = head ?? "HEAD";
  if (head && !existsRevision(repoRoot, head, maxBuffer)) throw new ValidationError({ code: ERROR_CODES.QUALITY_BASE_UNAVAILABLE, category: "quality", message: `head revision is unavailable: ${head}` });
  const mergeBase = git(repoRoot, ["merge-base", baseRevision, headRevision], { maxBuffer });
  const diffTarget = head ? [mergeBase, head] : [mergeBase];
  const names = parseNameStatus(git(repoRoot, ["diff", "--name-status", "--find-renames", ...diffTarget], { maxBuffer }));
  const changedLines = parseChangedLines(git(repoRoot, ["diff", "--unified=0", "--find-renames", ...diffTarget], { maxBuffer }));
  if (!head) {
    const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"], { maxBuffer }).split("\n").filter(Boolean);
    for (const file of untracked) {
      names.files.push({ path: file, status: "untracked" });
      const absolute = path.join(repoRoot, file);
      const count = fs.lstatSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8").split("\n").length - 1 : 0;
      changedLines[file] = Array.from({ length: count }, (_, index) => index + 1);
    }
  }
  const unique = [...new Map(names.files.map((file) => [file.path, file])).values()]
    .filter((file) => matchesPathScope(paths, file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const file of Object.keys(changedLines)) if (!matchesPathScope(paths, file)) delete changedLines[file];
  // Keep a rename when either side is in scope: evaluate.mjs resolves a
  // baseline metric through renames, so dropping a rename whose source sits
  // outside the filter would make a file moved into scope look brand new.
  const renames = names.renames.filter((item) => matchesPathScope(paths, item.to) || matchesPathScope(paths, item.from));
  return { baseRevision, headRevision: head ?? null, mergeBase, changedFiles: unique, changedLines, renames, paths, all: false };
}
