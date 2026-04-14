import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";
import { debug } from "./lib/debug.mjs";

export function createHarnessContext({ repoRoot } = {}) {
  const root =
    repoRoot ??
    process.env.HARNESS_REPO_ROOT ??
    resolveRepoRootFromGit();
  if (!root) {
    throw new Error(
      "harness: repoRoot not provided; pass { repoRoot } or set HARNESS_REPO_ROOT, or run inside a git repo",
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

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

export function readJson(ctx, relativePath) {
  return JSON.parse(readFileSync(path.join(ctx.repoRoot, relativePath), "utf8"));
}

export function readText(ctx, relativePath) {
  return readFileSync(path.join(ctx.repoRoot, relativePath), "utf8");
}

export function pathExists(ctx, relativePath) {
  return existsSync(path.join(ctx.repoRoot, relativePath));
}

export function git(ctx, args) {
  return execFileSync("git", args, { cwd: ctx.repoRoot, encoding: "utf8" }).trim();
}

export function loadFacts(ctx) {
  return readJson(ctx, "docs/repo-facts.json");
}

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

export function escapeRegex(v) {
  return v.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

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

export function matchesGlob(pattern, value) {
  return globToRegExp(pattern).test(value);
}

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
export function extractTemplateSection(body, heading) {
  if (!body) return "";
  const rx = new RegExp(
    `##\\s*${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "i",
  );
  const m = body.match(rx);
  return m ? m[1].trim() : "";
}

export function isMeaningfulSection(section) {
  if (!section) return false;
  const cleaned = section.replace(/<!--[\s\S]*?-->/g, "").trim();
  return cleaned.length > 0;
}

export function getPullRequestContext() {
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const isPullRequest = event === "pull_request";
  const body = process.env.PR_BODY ?? "";
  const actor = process.env.GITHUB_ACTOR ?? "";
  return { isPullRequest, body, actor };
}

const BOT_AUTHORS = new Set(["dependabot[bot]", "github-actions[bot]"]);
export function isBotActor(actor) {
  return BOT_AUTHORS.has(actor);
}

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
