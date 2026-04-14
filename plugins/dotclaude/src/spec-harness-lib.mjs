import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { debug } from "./lib/debug.mjs";

/**
 * Execution context threaded through every validator.
 *
 * @typedef {object} HarnessContext
 * @property {string} repoRoot       Absolute path to the repository root.
 * @property {string} specsRoot      Absolute path to `<repoRoot>/docs/specs`.
 * @property {string} manifestPath   Absolute path to `<repoRoot>/.claude/skills-manifest.json`.
 * @property {string} factsPath      Absolute path to `<repoRoot>/docs/repo-facts.json`.
 */

/**
 * Uniform shape returned by every validator.
 *
 * @typedef {object} ValidationResult
 * @property {boolean} ok            True when `errors.length === 0`.
 * @property {Array<import('./lib/errors.mjs').ValidationError>} errors
 */

/**
 * Build a {@link HarnessContext} by resolving the repository root through a
 * three-step fallback:
 *
 *   1. `repoRoot` option passed in.
 *   2. `DOTCLAUDE_REPO_ROOT` env var.
 *   3. `git rev-parse --show-toplevel` in the current working directory.
 *
 * Throws when none of the three produce a value (typically when running
 * outside a git repo with no env override).
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {HarnessContext}
 */
export function createHarnessContext({ repoRoot } = {}) {
  const root =
    repoRoot ??
    process.env.DOTCLAUDE_REPO_ROOT ??
    resolveRepoRootFromGit();
  if (!root) {
    throw new Error(
      "harness: repoRoot not provided; pass { repoRoot } or set DOTCLAUDE_REPO_ROOT, or run inside a git repo",
    );
  }
  return {
    repoRoot: root,
    specsRoot: path.join(root, "docs", "specs"),
    manifestPath: path.join(root, ".claude", "skills-manifest.json"),
    factsPath: path.join(root, "docs", "repo-facts.json"),
  };
}

function resolveRepoRootFromGit() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    debug("git:rev-parse", err.message);
    return null;
  }
}

/**
 * Convert a platform-native path (which may use `\` on Windows) to a POSIX
 * path so glob and prefix comparisons are stable across OSes.
 *
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/**
 * Read and parse a JSON file at `<repoRoot>/<relativePath>`.
 * Throws the raw SyntaxError when the file is not valid JSON.
 *
 * @param {HarnessContext} ctx
 * @param {string} relativePath
 * @returns {any}
 */
export function readJson(ctx, relativePath) {
  return JSON.parse(readFileSync(path.join(ctx.repoRoot, relativePath), "utf8"));
}

/**
 * Read a file at `<repoRoot>/<relativePath>` as UTF-8 text.
 *
 * @param {HarnessContext} ctx
 * @param {string} relativePath
 * @returns {string}
 */
export function readText(ctx, relativePath) {
  return readFileSync(path.join(ctx.repoRoot, relativePath), "utf8");
}

/**
 * Check whether `<repoRoot>/<relativePath>` exists on disk.
 *
 * @param {HarnessContext} ctx
 * @param {string} relativePath
 * @returns {boolean}
 */
export function pathExists(ctx, relativePath) {
  return existsSync(path.join(ctx.repoRoot, relativePath));
}

/**
 * Run `git <args>` with `cwd = ctx.repoRoot`, return trimmed stdout.
 * Lets the underlying error bubble on non-zero exit.
 *
 * @param {HarnessContext} ctx
 * @param {string[]} args
 * @returns {string}
 */
export function git(ctx, args) {
  return execFileSync("git", args, { cwd: ctx.repoRoot, encoding: "utf8" }).trim();
}

/**
 * Read the repository's authoritative facts file at `docs/repo-facts.json`.
 *
 * @param {HarnessContext} ctx
 * @returns {any}   Parsed repo-facts.json (shape is repo-specific; see `docs/repo-facts.json`).
 */
export function loadFacts(ctx) {
  return readJson(ctx, "docs/repo-facts.json");
}

/**
 * List every sub-directory under `docs/specs/` in the repo (spec ids).
 *
 * @param {HarnessContext} ctx
 * @returns {string[]}   Spec ids sorted alphabetically.
 */
export function listSpecDirs(ctx) {
  return readdirSync(ctx.specsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

const DEFAULT_IGNORED_TOP_LEVEL = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
]);
const DEFAULT_IGNORED_DIRS = new Set([
  ".claude/worktrees",
  "bin",
  "api/tmp",
  "test-results",
]);

/**
 * Recursively list every file under `ctx.repoRoot`, returning repo-relative
 * POSIX paths. Skips the conventional top-level noise directories (`.git`,
 * `node_modules`, `dist`, `coverage`) and a curated set of nested ones
 * (`.claude/worktrees`, `bin`, `api/tmp`, `test-results`).
 *
 * @param {HarnessContext} ctx
 * @param {{ ignoredTopLevel?: Set<string>, ignoredDirectories?: Set<string> }} [opts]
 * @returns {string[]}   Repo-relative POSIX paths sorted alphabetically.
 */
export function listRepoPaths(ctx, { ignoredTopLevel, ignoredDirectories } = {}) {
  const topSkip = ignoredTopLevel ?? DEFAULT_IGNORED_TOP_LEVEL;
  const dirSkip = ignoredDirectories ?? DEFAULT_IGNORED_DIRS;
  const out = [];

  function walk(relativeDir = "") {
    const absoluteDir = path.join(ctx.repoRoot, relativeDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (!relativeDir && topSkip.has(entry.name)) continue;
      const rel = toPosix(path.join(relativeDir, entry.name));
      if (dirSkip.has(rel)) continue;
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      out.push(rel);
    }
  }

  walk();
  return out.sort();
}

/**
 * Escape every regex metacharacter in `v` so it can be dropped into a
 * `new RegExp(...)` literal match.
 *
 * @param {string} v
 * @returns {string}
 */
export function escapeRegex(v) {
  return v.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

/**
 * Compile a glob pattern (`**`, `*`, `?`) into a `RegExp` anchored `^…$`.
 * Uses POSIX semantics — no brace expansion, no character classes.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let regex = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    const n = glob[i + 1];
    if (c === "*" && n === "*") {
      regex += ".*";
      i += 1;
      continue;
    }
    if (c === "*") {
      regex += "[^/]*";
      continue;
    }
    if (c === "?") {
      regex += ".";
      continue;
    }
    regex += escapeRegex(c);
  }
  return new RegExp(regex + "$");
}

/**
 * Check whether `value` matches the glob `pattern`.
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function matchesGlob(pattern, value) {
  return globToRegExp(pattern).test(value);
}

/**
 * Resolve a `pattern` against an array of candidate paths. Treats bare
 * (glob-free) patterns as prefix matches so `docs/specs/foo` covers
 * `docs/specs/foo/spec.json` etc.
 *
 * @param {string} pattern
 * @param {string[]} paths
 * @returns {boolean}
 */
export function anyPathMatches(pattern, paths) {
  const normalized = toPosix(pattern);
  if (!normalized.includes("*") && !normalized.includes("?")) {
    return (
      paths.includes(normalized) ||
      paths.some((c) => c.startsWith(`${normalized}/`))
    );
  }
  const rx = globToRegExp(normalized);
  return paths.some((c) => rx.test(c));
}

// ---- PR context helpers (unchanged from squadranks) ----

/**
 * Extract the body of a markdown H2 section named `heading` (e.g.
 * `## Spec ID`) from a PR body, case-insensitive. Returns `""` when the
 * section is absent.
 *
 * @param {string} body
 * @param {string} heading
 * @returns {string}
 */
export function extractTemplateSection(body, heading) {
  if (!body) return "";
  const rx = new RegExp(
    `##\\s*${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "i",
  );
  const m = body.match(rx);
  return m ? m[1].trim() : "";
}

/**
 * A section is "meaningful" when it contains at least one non-comment, non-whitespace
 * character. Strips `<!-- ... -->` HTML comments before the length check.
 *
 * @param {string} section
 * @returns {boolean}
 */
export function isMeaningfulSection(section) {
  if (!section) return false;
  const cleaned = section.replace(/<!--[\s\S]*?-->/g, "").trim();
  return cleaned.length > 0;
}

/**
 * Pull-request execution context from the GitHub Actions environment.
 *
 * @typedef {object} PullRequestContext
 * @property {boolean} isPullRequest   Derived from `GITHUB_EVENT_NAME === "pull_request"`.
 * @property {string} body             `PR_BODY` env — populated by workflows that pipe PR text in.
 * @property {string} actor            `GITHUB_ACTOR` env.
 */

/**
 * Read pull-request metadata from the standard GitHub Actions env vars.
 *
 * @returns {PullRequestContext}
 */
export function getPullRequestContext() {
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const isPullRequest = event === "pull_request";
  const body = process.env.PR_BODY ?? "";
  const actor = process.env.GITHUB_ACTOR ?? "";
  return { isPullRequest, body, actor };
}

const BOT_AUTHORS = new Set(["dependabot[bot]", "github-actions[bot]"]);

/**
 * Report whether `actor` is one of the recognized bot authors that bypasses
 * the PR-body spec/rationale contract.
 *
 * @param {string} actor
 * @returns {boolean}
 */
export function isBotActor(actor) {
  return BOT_AUTHORS.has(actor);
}

/**
 * Resolve the list of files changed in the current PR. Prefers
 * `HARNESS_CHANGED_FILES` (CSV) when set; otherwise falls back to
 * `git diff --name-only origin/<base>...HEAD`, defaulting `base` to
 * `GITHUB_BASE_REF || "main"`. Returns `[]` on git failure — the failure is
 * surfaced via `debug("git:diff", …)` when `DOTCLAUDE_DEBUG=1`.
 *
 * @returns {string[]}
 */
export function getChangedFiles() {
  const csv = process.env.HARNESS_CHANGED_FILES;
  if (csv) return csv.split(",").filter(Boolean);
  const base = process.env.GITHUB_BASE_REF || "main";
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", `origin/${base}...HEAD`],
      { encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch (err) {
    debug("git:diff", err.message);
    return [];
  }
}
