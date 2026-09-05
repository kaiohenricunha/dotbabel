import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";

function git(repoRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function existsRevision(repoRoot, revision) {
  return Boolean(git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`], { allowFailure: true }));
}

/** Resolve the comparison base without a provider-specific requirement. */
export function resolveBaseRevision({ repoRoot, base, env = process.env, configuredBase } = {}) {
  const explicit = base ?? env.DOTBABEL_QUALITY_BASE ?? configuredBase;
  if (explicit !== undefined) {
    if (existsRevision(repoRoot, explicit)) return explicit;
    throw new ValidationError({
      code: ERROR_CODES.QUALITY_BASE_UNAVAILABLE,
      category: "quality",
      message: `base revision is unavailable: ${explicit}`,
      hint: "fetch enough Git history or select an existing revision",
    });
  }
  const originHead = git(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowFailure: true });
  for (const candidate of [originHead, "origin/main", "main", "master"].filter(Boolean)) {
    if (existsRevision(repoRoot, candidate)) return candidate;
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
export function resolveQualityScope({ repoRoot, base, head, env = process.env, configuredBase } = {}) {
  const baseRevision = resolveBaseRevision({ repoRoot, base, env, configuredBase });
  const headRevision = head ?? "HEAD";
  if (head && !existsRevision(repoRoot, head)) throw new ValidationError({ code: ERROR_CODES.QUALITY_BASE_UNAVAILABLE, category: "quality", message: `head revision is unavailable: ${head}` });
  const mergeBase = git(repoRoot, ["merge-base", baseRevision, headRevision]);
  const diffTarget = head ? [mergeBase, head] : [mergeBase];
  const names = parseNameStatus(git(repoRoot, ["diff", "--name-status", "--find-renames", ...diffTarget], { allowFailure: true }));
  const changedLines = parseChangedLines(git(repoRoot, ["diff", "--unified=0", "--find-renames", ...diffTarget], { allowFailure: true }));
  if (!head) {
    const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"], { allowFailure: true }).split("\n").filter(Boolean);
    for (const file of untracked) {
      names.files.push({ path: file, status: "untracked" });
      const absolute = path.join(repoRoot, file);
      const count = fs.lstatSync(absolute).isFile() ? fs.readFileSync(absolute, "utf8").split("\n").length - 1 : 0;
      changedLines[file] = Array.from({ length: count }, (_, index) => index + 1);
    }
  }
  const unique = [...new Map(names.files.map((file) => [file.path, file])).values()].sort((a, b) => a.path.localeCompare(b.path));
  return { baseRevision, headRevision: head ?? null, mergeBase, changedFiles: unique, changedLines, renames: names.renames };
}
