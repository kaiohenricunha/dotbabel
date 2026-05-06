/**
 * Shared remote handoff library — the transport-side surface used by both
 * `bin/dotbabel-handoff.mjs` and future callers (skill/agent dispatchers,
 * other CLIs). Owns session-data extraction (via the shell scripts),
 * digest rendering, scrubbing, bootstrap / doctor orchestration, branch
 * naming, metadata encoding, and the git transport operations themselves.
 *
 * The bin imports from here and re-exports the symbols that existing
 * vitest suites depend on, preserving the public-import surface without
 * copy-pasting implementation across the boundary.
 */

import { HandoffError, classifyGitError } from "./handoff-errors.mjs";
export { HandoffError } from "./handoff-errors.mjs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { scrubDigest } from "./handoff-scrub.mjs";
import { autoPreflight } from "./handoff-preflight.mjs";
import {
  configDir as legacyConfigDir,
  canonicalConfigDir,
  env as legacyEnv,
  setEnv as legacySetEnv,
  unsetEnv as legacyUnsetEnv,
} from "./legacy-compat.mjs";

// ---- constants ---------------------------------------------------------

/** Matches v2 handoff branch names: handoff/<project>/<cli>/<YYYY-MM>/<shortId>. */
export const V2_BRANCH_RE =
  /^handoff\/[a-z0-9-]+\/(claude|copilot|codex|gemini)\/\d{4}-\d{2}\/[0-9a-f]{8}$/;
/** Matches legacy v1 handoff branch names: handoff/<cli>/<shortId>. */
export const V1_BRANCH_RE = /^handoff\/(claude|copilot|codex|gemini)\/[0-9a-f]{8}$/;

/**
 * Decompose a handoff branch into `{version, cli, shortId, yearMonth}`.
 * Unrecognised shapes return `{version: null, cli: "?", shortId: "", yearMonth: ""}`
 * so list renderers degrade gracefully on branches that predate both schemes.
 * v1 branches have no `yearMonth`.
 */
export function parseHandoffBranch(branch) {
  const s = branch ?? "";
  if (V2_BRANCH_RE.test(s)) {
    const [, , cli, yearMonth, shortId] = s.split("/");
    return { version: 2, cli, shortId, yearMonth };
  }
  if (V1_BRANCH_RE.test(s)) {
    const [, cli, shortId] = s.split("/");
    return { version: 1, cli, shortId, yearMonth: "" };
  }
  return { version: null, cli: "?", shortId: "", yearMonth: "" };
}

// Callers that read state at run time (loadPersistedEnv,
// bootstrapTransportRepo) go through these helpers so an updated
// process.env.HOME / XDG_CONFIG_HOME takes effect without a module
// reload. The exported CONFIG_FILE constant below captures the path
// at library-init time and is kept only for the diagnostic display
// in `doctor` + the test-contract `typeof mod.CONFIG_FILE === "string"`.
// READ helpers — fall back to ~/.config/dotclaude/ if the canonical dir is
// absent so v1 users keep working through 2.x (one-time DOTBABEL_LEGACY_CONFIG
// warning per process). loadPersistedEnv() and other read paths use these.
function currentConfigDir() {
  return legacyConfigDir();
}
function currentConfigFile() {
  return join(currentConfigDir(), "handoff.env");
}

// WRITE helpers — canonical only, never the legacy dir. Bootstrap/persist
// uses these so a v1 user's new state lands in ~/.config/dotbabel/ and the
// legacy directory stays read-only (the migration rule is "writes always go
// to canonical"; the legacy dir must not gain new files in 2.x).
function bootstrapConfigDir() {
  return canonicalConfigDir();
}
function bootstrapConfigFile() {
  return join(bootstrapConfigDir(), "handoff.env");
}

/** Path to the persisted handoff env file; evaluated at library-init time. */
export const CONFIG_FILE = currentConfigFile();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolvePath(__dirname, "..", "..", "scripts");
const EXTRACT_SH = join(SCRIPTS, "handoff-extract.sh");
const DESCRIPTION_SH = join(SCRIPTS, "handoff-description.sh");

// ---- local fail helper ---------------------------------------------------
// Duplicate of the bin's `fail` — kept local so the library never reaches
// back into the bin (which would create a circular import).

function fail(code, msg) {
  if (msg) process.stderr.write(`dotbabel-handoff: ${msg}\n`);
  process.exit(code);
}

// ---- subprocess primitives ---------------------------------------------

/** Spawn a shell script via spawnSync, returning {status, stdout, stderr}. */
export function runScript(script, args, opts = {}) {
  const res = spawnSync(script, args, { encoding: "utf8", ...opts });
  return {
    status: res.status ?? 2,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Run git with spawnSync, returning the raw SpawnSyncReturns result. */
export function runGit(args, cwd) {
  return spawnSync("git", args, { encoding: "utf8", cwd });
}

/** Run git and throw a descriptive Error on non-zero exit. */
export function runGitOrThrow(args, cwd) {
  const r = runGit(args, cwd);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

// ---- session extraction ------------------------------------------------

/** Extract JSON session metadata via handoff-extract.sh meta. */
export function extractMeta(cli, file) {
  const r = runScript(EXTRACT_SH, ["meta", cli, file]);
  if (r.status !== 0) fail(2, r.stderr.trim() || `meta extraction failed for ${cli}`);
  try {
    return JSON.parse(r.stdout.trim());
  } catch (err) {
    fail(2, `meta returned non-JSON: ${err.message}`);
  }
}

/**
 * Extract JSON-encoded-per-line output via handoff-extract.sh <sub>.
 *
 * `prompts` and `turns` emit one JSON-encoded string per line so that
 * multi-line messages stay atomic — splitting on `\n` here would
 * regress #84 by turning one skill-body message into N bogus "prompts".
 * Lines that fail to parse are skipped (defensive — the script owns the
 * contract).
 */
export function extractLines(sub, cli, file, extra = []) {
  const r = runScript(EXTRACT_SH, [sub, cli, file, ...extra]);
  if (r.status !== 0) {
    if (r.stderr.trim()) process.stderr.write(`dotbabel-handoff: ${sub}: ${r.stderr.trim()}\n`);
    return [];
  }
  const out = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (typeof v === "string" && v.length > 0) out.push(v);
    } catch {
      // Script contract broken — skip the line rather than crash the digest.
    }
  }
  return out;
}

/** Extract user prompt lines from a session file. */
export const extractPrompts = (cli, file) => extractLines("prompts", cli, file);
/** Extract assistant turn lines from a session file (optionally capped; 0 = unbounded). */
export const extractTurns = (cli, file, limit) =>
  extractLines("turns", cli, file, limit == null ? [] : [String(limit)]);

// ---- rendering ---------------------------------------------------------

/** Return a target-CLI-specific continuation hint for the next-step text. */
export function nextStepFor(toCli) {
  if (toCli === "codex") {
    return "Read the prompts and assistant turns above, then continue the task using the file paths mentioned. Treat this as a task specification.";
  }
  if (toCli === "copilot") {
    return "Help me pick up where this session left off; reference the prompts and findings above.";
  }
  return "Continue from the last assistant turn using the same file scope and goals summarized above.";
}

/** Produce a one-sentence summary: first prompt + last assistant turn (clipped). */
export function mechanicalSummary(prompts, turns) {
  const first = prompts[0] ?? "(session contained no user prompts)";
  const last = turns[turns.length - 1] ?? "(session contained no assistant turns)";
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trim()}…` : s);
  return `Session opened with: "${clip(first, 160)}". Last assistant output (truncated): "${clip(last, 160)}". Full prompt log and assistant tail follow for context.`;
}

/** Render the full <handoff> block for push or standalone describe. */
export function renderHandoffBlock(meta, prompts, turns, toCli) {
  const summary = mechanicalSummary(prompts, turns);
  const promptsCapped = prompts.slice(-10);
  const turnsTail = turns.slice(-3);
  const next = nextStepFor(toCli);
  const lines = [];
  lines.push(
    `<handoff origin="${meta.cli}" session="${meta.short_id ?? ""}" cwd="${meta.cwd ?? ""}" target="${toCli}">`,
  );
  lines.push("");
  lines.push(`**Summary.** ${summary}`);
  lines.push("");
  lines.push("**User prompts (last 10, in order).**");
  lines.push("");
  if (promptsCapped.length === 0) lines.push("1. (session contained no user prompts)");
  else
    promptsCapped.forEach((p, i) => {
      const trimmed = p.length > 300 ? `${p.slice(0, 300).trim()}…` : p;
      lines.push(`${i + 1}. ${trimmed}`);
    });
  lines.push("");
  lines.push("**Last assistant turns (tail).**");
  lines.push("");
  if (turnsTail.length === 0) lines.push("_(session contained no assistant turns)_");
  else
    for (const t of turnsTail) {
      const trimmed = t.length > 400 ? `${t.slice(0, 400).trim()}…` : t;
      lines.push(`> ${trimmed.replace(/\n/g, "\n> ")}`);
      lines.push("");
    }
  lines.push("**Next step.** " + next);
  lines.push("");
  lines.push("</handoff>");
  return lines.join("\n");
}

// ---- URL / path primitives ---------------------------------------------

/**
 * Reject ext:: and other exec-triggering Git URL schemes (CVE-2017-1000117-class).
 * Allows: https://, http://, git@, ssh://, file://, and absolute paths.
 */
export function validateTransportUrl(url) {
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(url))
    fail(
      2,
      `DOTBABEL_HANDOFF_REPO must be an https://, git@, ssh://, file://, or absolute path (got: ${url})`,
    );
  return url;
}

/**
 * Redact `user:token@` credentials from URLs embedded in a string before it
 * goes to stderr. Guards against CWE-532 leaks when a user sets
 * DOTBABEL_HANDOFF_REPO=https://user:token@host/... and git echoes the
 * full URL on transport failure.
 */
function redactUrlSecrets(s) {
  if (typeof s !== "string") return s;
  return s.replace(/(\bhttps?:\/\/|\bssh:\/\/)[^\s/@]+@/gu, "$1***@");
}

/**
 * Return true if stderr matches the union of "repo missing / auth failed"
 * messages from GitHub, GitLab, Gitea, and plain SSH.
 */
export function isRepoMissingError(stderr) {
  const s = (stderr || "").toLowerCase();
  return (
    s.includes("repository not found") ||
    s.includes("could not read from remote") ||
    s.includes("remote: not found") ||
    s.includes("project you were looking for could not be found") ||
    s.includes("permission denied") ||
    s.includes("does not appear to be a git repository")
  );
}

/**
 * Lowercase, replace non-alphanumeric runs with dashes, trim edges, cap at 40 chars.
 * Mirrors handoff-description.sh slugify so JS and shell agree on edge cases.
 */
export function slugify(s) {
  if (!s) return "adhoc";
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.slice(0, 40) || "adhoc";
}

/**
 * Slugify to GitHub-acceptable repo name: [a-z0-9-], no leading/trailing dashes,
 * max 100 chars.
 */
export function slugifyRepoName(input) {
  const s = (input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 100);
}

/**
 * Return the slugified top-level git repo name for `cwd`, or the basename.
 * A session inside ~/foo/services/api groups under "foo", not "api".
 */
export function projectSlugFromCwd(cwd) {
  if (!cwd) return "adhoc";
  const r = runGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
  const root = r.status === 0 ? r.stdout.trim() : "";
  const last = (root || cwd).split("/").filter(Boolean).pop() || "adhoc";
  return slugify(last);
}

/** Return YYYY-MM for an ISO timestamp, or for the current UTC month if null/invalid. */
export function monthBucket(isoOrNull) {
  const d = isoOrNull ? new Date(isoOrNull) : new Date();
  if (Number.isNaN(d.getTime())) return monthBucket(null);
  const yyyy = d.getUTCFullYear().toString();
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/** Assemble the canonical v2 branch name from {project, cli, month, shortId}. */
export function v2BranchName({ project, cli, month, shortId }) {
  return `handoff/${slugify(project)}/${cli}/${month}/${shortId}`;
}

/** Return true when both stdin and stderr are interactive TTYs. */
export function isTty() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

// ---- metadata encoding / decoding --------------------------------------

/** Encode handoff metadata into an opaque description string via handoff-description.sh. */
export function encodeDescription({ cli, shortId, project, host, month, tag }) {
  const args = [
    "encode",
    "--cli",
    cli,
    "--short-id",
    shortId,
    "--project",
    project || "adhoc",
    "--hostname",
    host || "unknown",
    "--month",
    month,
  ];
  if (tag) args.push("--tag", tag);
  const r = runScript(DESCRIPTION_SH, args);
  if (r.status !== 0) fail(2, `description encode failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/**
 * Read tags from a metadata object, transparently handling both the
 * v0 single-string `tag` field (deployed before #91 Gap 7) and the
 * current `tags: string[]` array. Returns [] when neither is set.
 *
 * Array shape always wins when present (even if empty) so an explicit
 * empty array does NOT fall back to legacy `tag`.
 */
export function tagsFromMeta(meta) {
  if (Array.isArray(meta?.tags)) return meta.tags;
  if (typeof meta?.tag === "string" && meta.tag.length > 0) return [meta.tag];
  return [];
}

/**
 * Extract the tag list from the description-string segment-8 (or v1
 * segment-7) without round-tripping through `decodeDescription`. The
 * tag segment is comma-joined per #91 Gap 7; a single-tag segment with
 * no comma is read as a one-element list. Returns [] on shape mismatch.
 *
 * This stays in sync with the description.txt encoder so list/pull
 * filters can avoid an extra `metadata.json` fetch per branch.
 */
export function parseTagsFromDescription(desc) {
  if (typeof desc !== "string" || desc.length === 0) return [];
  const parts = desc.split(":");
  // v2: handoff:v2:<project>:<cli>:<YYYY-MM>:<short>:<host>[:<tag>]
  // v1: handoff:v1:<cli>:<short>:<project>:<host>[:<tag>]
  let tagSeg = "";
  if (parts[0] === "handoff" && parts[1] === "v2" && parts.length === 8) {
    tagSeg = parts[7];
  } else if (parts[0] === "handoff" && parts[1] === "v1" && parts.length === 7) {
    tagSeg = parts[6];
  } else {
    return [];
  }
  if (!tagSeg) return [];
  return tagSeg.split(",").filter((t) => t.length > 0);
}

/** Decode a handoff description string back into a metadata object, or null on failure. */
export function decodeDescription(desc) {
  if (!desc) return null;
  if (!desc.startsWith("handoff:v1:") && !desc.startsWith("handoff:v2:")) return null;
  const r = runScript(DESCRIPTION_SH, ["decode", desc]);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// ---- persisted env / bootstrap helpers --------------------------------

/**
 * Source ~/.config/dotbabel/handoff.env if present, seeding any missing env var.
 * Shell rc users can `source` the same file; bypass via an explicit env var.
 */
export function loadPersistedEnv() {
  const configFile = currentConfigFile();
  if (!existsSync(configFile)) return;
  let contents;
  try {
    contents = readFileSync(configFile, "utf8");
  } catch {
    return;
  }
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

/** Return true if `gh` is on PATH and exits 0. */
export function ghAvailable() {
  const r = spawnSync("gh", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/** Return true if `gh auth status` exits 0 (authenticated to github.com). */
export function ghAuthenticated() {
  const r = spawnSync("gh", ["auth", "status", "-h", "github.com"], {
    encoding: "utf8",
  });
  return r.status === 0;
}

/** Return the authenticated GitHub username, or null on failure. */
export function ghLogin() {
  const r = spawnSync("gh", ["api", "user", "-q", ".login"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Print a manual-setup hint block to stderr when auto-bootstrap can't proceed.
 * Triggered for non-TTY, missing gh, or user abort.
 */
export function printManualSetupBlock(reason) {
  const msg = [
    "",
    `Can't auto-bootstrap the handoff store: ${reason}`,
    "",
    "Set it up manually:",
    "  1. gh repo create <you>/dotbabel-handoff-store --private",
    "  2. export DOTBABEL_HANDOFF_REPO=git@github.com:<you>/dotbabel-handoff-store.git",
    "  3. dotbabel handoff push   # retries",
    "",
    "Alternative providers (GitLab, Gitea, self-hosted) work too — set",
    "DOTBABEL_HANDOFF_REPO to any ssh://, git@, https://, file://, or absolute path.",
    "",
  ];
  process.stderr.write(msg.join("\n"));
}

/**
 * Async readline prompt via createInterface; returns the trimmed answer.
 * Returns "" for empty input.
 */
export async function promptLine(message) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((resolve) => {
      rl.question(message, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

/**
 * Ensure the transport repo has `main` as its default branch so the first
 * handoff push doesn't get pinned as HEAD (issue #180). Idempotent: safe
 * to run on a fresh repo, an already-seeded repo, or a buggy repo whose
 * current default is a `handoff/*` ref.
 *
 * Steps:
 *   1. Probe `git ls-remote --heads <url> refs/heads/main`. If absent,
 *      build an inert `main` in a tmp repo (init -b main, README, commit,
 *      push) so the next step has a valid target.
 *   2. PATCH the GitHub repo's default_branch to `main` unconditionally.
 *      The PATCH is the remediation hook for already-bootstrapped buggy
 *      repos that already have `main` but still default to a handoff ref.
 *
 * The PATCH is non-fatal: a failed flip leaves the repo functional but
 * still bug-prone, so we surface a one-line warning and let the caller
 * print remediation steps. Push failure is fatal — without `main` the
 * default-branch flip would silently target a missing ref.
 *
 * @param {string} login    GitHub username from `gh api user`
 * @param {string} name     repo name (e.g. "dotbabel-handoff-store")
 * @param {string} repoUrl  ssh URL from `gh repo view`
 * @returns {{ seeded: boolean, defaultBranchPatched: boolean, warning?: string }}
 */
export function seedTransportDefaultBranch(login, name, repoUrl) {
  let seeded = false;
  const probe = runGit(["ls-remote", "--heads", repoUrl, "refs/heads/main"], process.cwd());
  if (probe.status !== 0 || !probe.stdout.trim()) {
    const tmp = mkdtempSync(join(tmpdir(), "handoff-bootstrap-seed-"));
    try {
      runGitOrThrow(["init", "-q", "-b", "main"], tmp);
      writeFileSync(
        join(tmp, "README.md"),
        "# dotbabel handoff transport store\n\nManaged by `dotbabel handoff`. Do not edit by hand.\n",
      );
      runGitOrThrow(["add", "README.md"], tmp);
      runGitOrThrow(
        [
          "-c",
          "user.email=dotbabel@local",
          "-c",
          "user.name=dotbabel",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "chore: seed default branch",
          "-q",
        ],
        tmp,
      );
      runGitOrThrow(["push", "-q", repoUrl, "main"], tmp);
      seeded = true;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const patch = spawnSync(
    "gh",
    ["api", "-X", "PATCH", `repos/${login}/${name}`, "-f", "default_branch=main"],
    { encoding: "utf8" },
  );
  if (patch.status !== 0) {
    const detail =
      (patch.stderr || patch.stdout || "").trim().split("\n")[0] ||
      `gh exited ${patch.status ?? "?"}`;
    return {
      seeded,
      defaultBranchPatched: false,
      warning: `could not set default branch to main (${detail}); run \`gh api -X PATCH repos/${login}/${name} -f default_branch=main\` to remediate`,
    };
  }
  return { seeded, defaultBranchPatched: true };
}

/**
 * Interactively create a private GitHub repo for handoff storage via `gh`.
 * Writes the URL to the persisted env file and sets DOTBABEL_HANDOFF_REPO.
 * Exits 2 with a manual-setup block when non-TTY, gh missing, or user aborts.
 */
export async function bootstrapTransportRepo() {
  if (!isTty()) {
    printManualSetupBlock("not running in an interactive terminal");
    process.exit(2);
  }
  if (!ghAvailable()) {
    printManualSetupBlock("`gh` CLI is not on PATH — install it from https://cli.github.com/");
    process.exit(2);
  }
  if (!ghAuthenticated()) {
    printManualSetupBlock("`gh` is not authenticated — run `gh auth login` (scopes: repo)");
    process.exit(2);
  }
  const login = ghLogin();
  if (!login) {
    printManualSetupBlock("could not read GitHub username via `gh api user`");
    process.exit(2);
  }

  // Bootstrap is a write path — show and use the canonical-only target so
  // a v1 user's new state lands in ~/.config/dotbabel/ rather than being
  // written back into ~/.config/dotclaude/ (migration rule: writes always
  // go to canonical; legacy dir is read-only fallback).
  const configFile = bootstrapConfigFile();
  process.stderr.write(
    [
      "",
      "DOTBABEL_HANDOFF_REPO is not set — dotbabel can set this up for you.",
      "",
      `  Detected: gh CLI authenticated as @${login}.`,
      `  Plan: create private repo  ${login}/<name>`,
      `        persist URL to       ${configFile}`,
      "",
    ].join("\n"),
  );

  let name = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const input = await promptLine("  Repo name? [dotbabel-handoff-store] ");
    const candidate = input === "" ? "dotbabel-handoff-store" : slugifyRepoName(input);
    if (/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/.test(candidate)) {
      name = candidate;
      break;
    }
    process.stderr.write(
      "  Name must be 1-100 chars of [a-z0-9-], no leading/trailing dash. Try again.\n",
    );
  }
  if (!name) {
    process.stderr.write("  Gave up after 3 invalid names. Aborting.\n");
    process.exit(2);
  }

  const confirm = await promptLine(`  Create ${login}/${name} and proceed? [y/N] `);
  if (!/^y(es)?$/i.test(confirm)) {
    process.stderr.write("  Aborted.\n");
    process.exit(1);
  }

  const create = spawnSync(
    "gh",
    ["repo", "create", `${login}/${name}`, "--private", "--description", "dotbabel handoff store"],
    { encoding: "utf8" },
  );
  if (create.status !== 0) {
    const stderr = (create.stderr || "").toLowerCase();
    // Idempotent: an existing repo is not a failure — we'll push to it.
    if (
      !stderr.includes("already exists") &&
      !stderr.includes("name already exists on this account")
    ) {
      process.stderr.write(`  gh repo create failed:\n${create.stderr}\n`);
      process.exit(2);
    }
    process.stderr.write(`  ✓ repo ${login}/${name} already exists — reusing\n`);
  } else {
    process.stderr.write(`  ✓ created ${login}/${name}\n`);
  }

  const view = spawnSync(
    "gh",
    ["repo", "view", `${login}/${name}`, "--json", "sshUrl,url", "-q", ".sshUrl"],
    { encoding: "utf8" },
  );
  const url =
    view.status === 0 && view.stdout.trim()
      ? view.stdout.trim()
      : `git@github.com:${login}/${name}.git`;

  // Seed `main` as the default branch BEFORE any handoff push lands, so
  // GitHub doesn't pin the first handoff ref as HEAD (issue #180).
  // Idempotent — re-running bootstrap on a buggy already-bootstrapped
  // repo also remediates it.
  const seed = seedTransportDefaultBranch(login, name, url);
  if (seed.seeded) {
    process.stderr.write("  ✓ seeded `main` as default branch\n");
  } else {
    process.stderr.write("  ✓ default branch already initialized\n");
  }
  if (seed.warning) {
    process.stderr.write(`  ⚠ ${seed.warning}\n`);
  }

  mkdirSync(bootstrapConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(
    configFile,
    `# Written by dotbabel handoff on ${new Date().toISOString()}\n` +
      `# Sourceable from your shell rc:  source ${configFile}\n` +
      `export DOTBABEL_HANDOFF_REPO=${url}\n`,
    { mode: 0o600 },
  );
  process.stderr.write(`  ✓ wrote ${configFile}\n`);
  process.stderr.write(
    `    (add \`source ${configFile}\` to ~/.bashrc or ~/.zshrc to persist across shells)\n`,
  );

  legacySetEnv("HANDOFF_REPO", url);
  return url;
}

/**
 * Return a validated transport URL, bootstrapping interactively if the env var
 * is missing. Call site for push/pull/list/doctor.
 */
export async function requireTransportRepo() {
  const existing = legacyEnv("HANDOFF_REPO");
  if (existing) return validateTransportUrl(existing);
  const fresh = await bootstrapTransportRepo();
  return validateTransportUrl(fresh);
}

/**
 * Synchronous variant: return a validated transport URL or fail hard.
 * Use for read-only paths (list, doctor) that cannot trigger interactive bootstrap.
 */
export function requireTransportRepoStrict() {
  const url = legacyEnv("HANDOFF_REPO");
  if (!url)
    throw new HandoffError({
      stage: "preflight",
      cause: "transport not configured",
      fix: "Run `dotbabel handoff push` to auto-bootstrap, or set DOTBABEL_HANDOFF_REPO manually",
      retry: "dotbabel handoff push",
    });
  return validateTransportUrl(url);
}

// ---- remote I/O --------------------------------------------------------

/**
 * Init a throwaway bare repo, shallow-fetch the given refspecs, run `fn`
 * against the tmp path, and clean up. Throws on init/fetch failure with
 * a message prefixed for caller matching. Callers that want a soft
 * fallback (e.g. `sortByCommitterDate`) wrap the call in try/catch.
 *
 * @template T
 * @param {string} slug         mkdtemp prefix, e.g. "probe" or "sort"
 * @param {string} repoUrl
 * @param {string[]} refspecs
 * @param {(tmp: string) => T} fn
 * @returns {T}
 */
function withShallowFetch(slug, repoUrl, refspecs, fn) {
  const tmp = mkdtempSync(join(tmpdir(), `handoff-${slug}-`));
  try {
    const init = runGit(["init", "-q", "--bare"], tmp);
    if (init.status !== 0) {
      throw new Error(`git init failed: ${init.stderr.trim()}`);
    }
    const fetched = runGit(["fetch", "--depth=1", "--no-tags", "-q", repoUrl, ...refspecs], tmp);
    if (fetched.status !== 0) {
      throw new Error(`fetch failed: ${fetched.stderr.trim()}`);
    }
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Read `metadata.json` from the tip of a remote handoff branch.
 * Throws on transport, missing metadata (legacy branch), or parse failure.
 * The thrown message includes the underlying git/JSON error text but no
 * structured type — callers treat all three conservatively.
 *
 * @param {string} branch
 * @param {string} repoUrl
 * @returns {{ session_id: string|null, [k: string]: any }}
 */
export function fetchRemoteMetadata(branch, repoUrl) {
  return withShallowFetch(
    "probe",
    repoUrl,
    [`+refs/heads/${branch}:refs/heads/${branch}`],
    (tmp) => {
      const shown = runGit(["show", `refs/heads/${branch}:metadata.json`], tmp);
      if (shown.status !== 0) {
        // Most common path here is "path 'metadata.json' does not exist" —
        // a legacy branch predating the session_id invariant. Surface the
        // underlying git message so the caller can match on it.
        throw new Error(`metadata.json missing: ${shown.stderr.trim()}`);
      }
      try {
        return JSON.parse(shown.stdout);
      } catch (err) {
        throw new Error(`metadata.json parse failed: ${err.message}`);
      }
    },
  );
}

/**
 * Pre-push collision probe. Returns `{ mode: "create" | "update" | "force" }`.
 * Fails closed (exit 2) on ls-remote errors, missing/unreadable remote
 * metadata, or session_id mismatch, unless `force` is true — in which
 * case the same conditions emit a stderr warning and return mode:"force".
 *
 * @param {string} repoUrl
 * @param {string} branch
 * @param {string|null|undefined} localSessionId
 * @param {{ force?: boolean }} [opts]
 * @returns {{ mode: "create" | "update" | "force" }}
 */
export function probeCollision(repoUrl, branch, localSessionId, { force = false } = {}) {
  const forceOrFail = (closedMsg, warnMsg = closedMsg) => {
    if (!force) fail(2, closedMsg);
    process.stderr.write(`dotbabel-handoff: ${warnMsg}; forcing\n`);
    return { mode: /** @type {const} */ ("force") };
  };
  if (!localSessionId) {
    // session_id should always be populated via extractMeta, but the
    // schema allows null — refuse rather than silently match-on-null.
    return forceOrFail(
      "collision probe refused: local session_id is missing; rerun with --force-collision to override",
    );
  }
  const ls = runGit(["ls-remote", repoUrl, `refs/heads/${branch}`]);
  if (ls.status !== 0) {
    return forceOrFail(`collision probe failed: ls-remote: ${redactUrlSecrets(ls.stderr.trim())}`);
  }
  if (ls.stdout.trim() === "") {
    return { mode: "create" };
  }
  let remote;
  try {
    remote = fetchRemoteMetadata(branch, repoUrl);
  } catch (err) {
    const safeMsg = redactUrlSecrets(err.message);
    return forceOrFail(
      `short-id collision on ${branch}: existing branch has no provable owner (${safeMsg}); rerun with --force-collision to override`,
      `collision probe failed: ${safeMsg}`,
    );
  }
  const remoteSessionId = typeof remote?.session_id === "string" ? remote.session_id : null;
  if (remoteSessionId === localSessionId) {
    return { mode: "update" };
  }
  const ownerHint = remoteSessionId
    ? `remote-session=${remoteSessionId}`
    : "remote-session=unknown";
  return forceOrFail(
    `short-id collision on ${branch}: local-session=${localSessionId} ${ownerHint}; rerun with --force-collision to override`,
  );
}

/** Push a local session to the transport repo as a handoff branch. */
export async function pushRemote({
  cli,
  path: sessionFile,
  tag,
  tags,
  verify = false,
  verbose = false,
  force = false,
  dryRun = false,
}) {
  // #91 Gap 7: accept either `tags: string[]` (new, multi-tag) or the legacy
  // `tag: string` (single). Internally everything below works on `tagList`.
  const tagList = Array.isArray(tags)
    ? tags.filter((t) => typeof t === "string" && t.length > 0)
    : tag
      ? [tag]
      : [];
  // Dry-run must stay fully offline — no interactive bootstrap, no preflight
  // probe. The bin's emitRemoteError formats the HandoffError thrown here
  // when the env var is unset.
  let repoUrl = dryRun ? requireTransportRepoStrict() : await requireTransportRepo();
  if (!dryRun) autoPreflight({ repo: repoUrl, verify, verbose });
  const meta = extractMeta(cli, sessionFile);
  const prompts = extractPrompts(cli, sessionFile);
  const turns = extractTurns(cli, sessionFile);
  const toCli = meta.cli;
  const handoffBlock = renderHandoffBlock(meta, prompts, turns, toCli);

  // Scrub before the digest ever leaves the machine. Thrown errors
  // propagate out of pushRemote — the outer try/catch in main() maps
  // them to `push failed: <message>` with exit 2, so an unscrubbed
  // digest can never reach the remote.
  const { scrubbed, count: scrubbedCount } = scrubDigest(handoffBlock);

  const shortId = meta.short_id ?? "unknown";
  const host = slugify(hostname());
  const project = projectSlugFromCwd(meta.cwd);
  const month = monthBucket();
  // Pass tags pre-joined with commas; the encode script splits, slugifies
  // each token, validates, and rejoins so single-tag input stays
  // backward-compatible with the v0 single-tag segment shape.
  const description = encodeDescription({
    cli: meta.cli,
    shortId,
    project,
    host,
    month,
    tag: tagList.length > 0 ? tagList.join(",") : null,
  });

  const metadata = {
    cli: meta.cli,
    session_id: meta.session_id,
    short_id: shortId,
    cwd: meta.cwd ?? null,
    project,
    month,
    hostname: host,
    created_at: new Date().toISOString(),
    scrubbed_count: scrubbedCount,
    tags: tagList,
  };

  const branch = v2BranchName({ project, cli: meta.cli, month, shortId });

  if (dryRun) {
    return {
      dryRun: true,
      branch,
      url: repoUrl,
      description,
      scrubbedCount,
      digestBytes: Buffer.byteLength(scrubbed, "utf8"),
      metadata,
      tags: tagList,
    };
  }

  // Pre-push collision probe: compare the remote branch's
  // metadata.session_id (if any) against the local session_id. Without
  // this, two sessions with the same 8-hex-char short_id prefix would
  // silently force-push over each other (issue #90 Gap 3).
  const attemptPush = (url, mode) => {
    const tmp = mkdtempSync(join(tmpdir(), "handoff-push-"));
    try {
      runGitOrThrow(["init", "-q"], tmp);
      runGitOrThrow(["remote", "add", "origin", url], tmp);
      runGitOrThrow(["config", "user.email", "handoff@dotbabel.local"], tmp);
      runGitOrThrow(["config", "user.name", "dotbabel-handoff"], tmp);
      runGitOrThrow(["checkout", "-q", "-b", branch], tmp);
      writeFileSync(join(tmp, "handoff.md"), scrubbed + "\n");
      writeFileSync(join(tmp, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
      writeFileSync(join(tmp, "description.txt"), description + "\n");
      runGitOrThrow(["add", "."], tmp);
      runGitOrThrow(["commit", "-q", "-m", description], tmp);
      // `create` pushes without -f so a racing session that claimed the
      // short-id between our probe and our push produces a non-fast-forward
      // error rather than a silent clobber. `update`/`force` keep -f because
      // every push writes an orphan commit (no shared history with the
      // existing ref), so a fast-forward is structurally impossible — but
      // the probe has already proven either same-session ownership or an
      // explicit user override.
      runGitOrThrow(
        mode === "create"
          ? ["push", "-q", "origin", branch]
          : ["push", "-q", "-f", "origin", branch],
        tmp,
      );
      return { dryRun: false, branch, url, description, scrubbedCount, tags: tagList };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  const RACE_RE = /non-fast-forward|fetch first|\(fetch first\)|rejected.*non-fast|already exists/i;

  const doPush = (url) => {
    const mode = probeCollision(url, branch, meta.session_id, { force }).mode;
    try {
      return attemptPush(url, mode);
    } catch (err) {
      // TOCTOU: in create mode, someone may have claimed the branch
      // between the probe (ls-remote) and our push. Git reports that as
      // a non-fast-forward rejection. Re-probe once and retry with the
      // fresh decision — this closes the race without ever force-pushing
      // over a verifiably-different session.
      if (mode !== "create" || !RACE_RE.test(err.message ?? "")) throw err;
      const retryMode = probeCollision(url, branch, meta.session_id, { force }).mode;
      return attemptPush(url, retryMode);
    }
  };

  try {
    return doPush(repoUrl);
  } catch (err) {
    // Retry once after bootstrap if the remote is gone or unauthorized
    // — handles stale config (repo deleted) and first-run with a pre-set
    // env var that points at a non-existent repo. Second failure is fatal.
    if (!isRepoMissingError(err.message)) throw err;
    if (!isTty()) {
      printManualSetupBlock(
        `configured repo is unreachable (${legacyEnv("HANDOFF_REPO")}) and we can't prompt in non-interactive mode`,
      );
      throw err;
    }
    process.stderr.write(
      `\n  The configured repo (${legacyEnv("HANDOFF_REPO")}) is unreachable.\n`,
    );
    const again = await promptLine("  Re-bootstrap (create a new one)? [y/N] ");
    if (!/^y(es)?$/i.test(again)) throw err;
    // Clear the stale URL so bootstrapTransportRepo() doesn't short-circuit.
    legacyUnsetEnv("HANDOFF_REPO");
    const fresh = await bootstrapTransportRepo();
    return doPush(validateTransportUrl(fresh));
  }
}

/**
 * Sort remote handoff candidates newest-first by commit date.
 *
 * `git ls-remote --sort=committerdate` is documented to fail with
 * "missing object" for refs whose objects have not yet been fetched
 * (see git-ls-remote(1)), so we can't sort server-side. Instead, do
 * one bulk shallow fetch into a throwaway bare repo and run
 * `for-each-ref --sort=-committerdate` locally.
 *
 * Cost: one `fetch --depth=1` round-trip; O(N) commit-tip objects.
 *
 * If the sort fetch fails (network blip, auth hiccup between the
 * ls-remote that built `candidates` and this call), emit a stderr
 * warning and return null. The caller falls back to the pre-fix
 * selection (last ls-remote entry) so the degraded path is stable.
 *
 * @param {Array<{branch: string, commit: string, description: string}>} candidates
 * @param {string} repoUrl
 * @returns {Array<{branch: string, commit: string, description: string}>|null}
 */
function sortByCommitterDate(candidates, repoUrl) {
  if (candidates.length <= 1) return candidates;
  const warnAndFallback = (reason) => {
    const msg = String(reason).trim().replace(/\s+/gu, " ") || "unknown error";
    process.stderr.write(
      `dotbabel-handoff: committer-date sort skipped (${msg}); using ls-remote order\n`,
    );
    return null;
  };
  const refspecs = candidates.map((c) => `+refs/heads/${c.branch}:refs/heads/${c.branch}`);
  try {
    return withShallowFetch("sort", repoUrl, refspecs, (tmp) => {
      const fer = runGit(
        [
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname:short)",
          "refs/heads/handoff/",
        ],
        tmp,
      );
      if (fer.status !== 0) {
        throw new Error(`for-each-ref failed: ${fer.stderr.trim()}`);
      }
      const byBranch = new Map(candidates.map((c) => [c.branch, c]));
      const sorted = [];
      for (const line of fer.stdout.split("\n")) {
        const ref = line.trim();
        if (!ref) continue;
        const c = byBranch.get(ref);
        if (c) sorted.push(c);
      }
      if (sorted.length !== candidates.length) {
        throw new Error(`partial sort (${sorted.length}/${candidates.length} refs resolved)`);
      }
      return sorted;
    });
  } catch (err) {
    return warnAndFallback(err.message);
  }
}

/**
 * List handoff branches on the remote as candidate objects.
 * Returns [{branch, description, commit}] — no content fetched.
 */
export function listRemoteCandidates() {
  const repoUrl = requireTransportRepoStrict();
  const r = runGit(["ls-remote", repoUrl, "refs/heads/handoff/*"]);
  if (r.status !== 0)
    throw new HandoffError({
      stage: "preflight",
      cause: "repo unreachable",
      fix: `Run \`dotbabel handoff doctor\` to diagnose — ls-remote failed: ${r.stderr.trim()}`,
      retry: "dotbabel handoff doctor",
    });
  const rows = [];
  for (const line of r.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const commit = parts[0];
    const ref = parts[1];
    const branch = ref.replace(/^refs\/heads\//, "");
    rows.push({ commit, branch, description: "" });
  }
  return rows;
}

/**
 * Fetch a specific handoff branch and return its `handoff.md` content.
 */
export function fetchRemoteBranch(branch) {
  const repoUrl = requireTransportRepoStrict();
  const tmp = mkdtempSync(join(tmpdir(), "handoff-pull-"));
  try {
    const r = runGit(["clone", "-q", "--depth", "1", "--branch", branch, repoUrl, "."], tmp);
    if (r.status !== 0) {
      const raw = `clone --branch ${branch} failed: ${r.stderr.trim()}`;
      throw classifyGitError(raw, "fetch", {});
    }
    const handoffPath = join(tmp, "handoff.md");
    if (!existsSync(handoffPath)) {
      throw new Error(`handoff.md missing in branch ${branch}`);
    }
    const content = readFileSync(handoffPath, "utf8");
    const descPath = join(tmp, "description.txt");
    const description = existsSync(descPath) ? readFileSync(descPath, "utf8").trim() : "";
    return { content, description };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Enrich candidates with their description (requires per-branch fetch).
 */
export function enrichWithDescriptions(candidates) {
  return candidates.map((c) => {
    try {
      const { description } = fetchRemoteBranch(c.branch);
      return { ...c, description };
    } catch {
      return c;
    }
  });
}

/** Return true if a candidate {branch, description, commit} matches the query string. */
export function matchesQuery(candidate, query) {
  const q = query.toLowerCase();
  if (candidate.branch.toLowerCase().includes(q)) return true;
  if (candidate.description && candidate.description.toLowerCase().includes(q)) return true;
  if (candidate.commit && candidate.commit.toLowerCase().startsWith(q)) return true;
  return false;
}

// ---- prune (#91 Gap 5) -------------------------------------------------

const PRUNE_DURATION_RE = /^(\d+)([dmy])$/;
const PRUNE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Skip-bucket keys for `listPruneCandidates` — single source of truth so
 * the renderer in the bin and the unit tests can reference the same names
 * without typo drift.
 */
export const PRUNE_SKIP_BUCKETS = Object.freeze({
  byHost: "byHost",
  byMissingMeta: "byMissingMeta",
  byFromCli: "byFromCli",
  byAge: "byAge",
});

/**
 * Parse a duration into a cutoff epoch (ms). Branches whose committer-date
 * is ≤ this value are eligible for prune.
 *
 * Accepts:
 *   "Nd"          → N days back from now (N ≥ 0)
 *   "Nm"          → N × 30 days back (months are a 30-day approximation)
 *   "Ny"          → N × 365 days back
 *   "YYYY-MM-DD"  → midnight UTC of that ISO date
 *
 * @param {string} raw
 * @returns {number} epoch ms cutoff
 */
export function parseDuration(raw) {
  if (raw == null) throw new Error("duration is required");
  const s = String(raw).trim();
  if (!s) throw new Error("duration is required");
  const rel = PRUNE_DURATION_RE.exec(s);
  if (rel) {
    const n = Number.parseInt(rel[1], 10);
    const unit = rel[2];
    const days = unit === "d" ? n : unit === "m" ? n * 30 : n * 365;
    return Date.now() - days * DAY_MS;
  }
  if (PRUNE_DATE_RE.test(s)) {
    const ms = Date.parse(`${s}T00:00:00Z`);
    if (!Number.isFinite(ms)) throw new Error(`invalid date: ${s}`);
    return ms;
  }
  throw new Error(`expected Nd | Nm | Ny | YYYY-MM-DD, got: ${s}`);
}

/**
 * Find handoff branches eligible for prune.
 *
 * One ls-remote inventory + one bulk shallow fetch (the inventory is needed
 * because a wildcard `git fetch refs/heads/handoff/*:...` errors out on
 * empty transports, so we'd lose the happy zero-candidate path). The
 * shallow fetch then services BOTH the per-branch committer date and the
 * per-branch metadata.json read in a single network round trip.
 *
 * `commit` in the returned candidates is sourced from `for-each-ref` *after*
 * the fetch (not from ls-remote), so we report the SHA we actually pulled —
 * any ref that moved between ls-remote and fetch surfaces the post-fetch
 * tip, never a stale one.
 *
 * Filters (applied in order):
 *   1. committer date ≤ olderThanMs
 *   2. metadata.hostname === slugify(hostname()) — own-host only
 *   3. metadata.cli === fromCli (when fromCli is provided)
 *
 * Skip-bucket semantics (we never prune without provable ownership):
 *   byMissingMeta — committer date missing, metadata.json missing /
 *                   unparseable, or metadata lacks a string `hostname` field
 *   byHost        — metadata.hostname is a string but ≠ ownHost
 *   byFromCli     — metadata.cli ≠ fromCli (only when fromCli is set)
 *   byAge         — branch is younger than the cutoff
 *
 * @param {{ olderThanMs: number, fromCli?: string|null, repoUrl: string }} opts
 * @returns {{ candidates: Array<{branch:string,commit:string,committedAt:number,hostname:string,cli:string|null}>,
 *             skipped: { byHost:number, byMissingMeta:number, byFromCli:number, byAge:number },
 *             total: number }}
 */
export function listPruneCandidates({ olderThanMs, fromCli = null, repoUrl }) {
  const inventory = listRemoteCandidates();
  const skipped = Object.fromEntries(Object.values(PRUNE_SKIP_BUCKETS).map((k) => [k, 0]));
  if (inventory.length === 0) {
    return { candidates: [], skipped, total: 0 };
  }
  const ownHost = slugify(hostname());
  const refspecs = inventory.map((c) => `+refs/heads/${c.branch}:refs/heads/${c.branch}`);
  const candidates = withShallowFetch("prune", repoUrl, refspecs, (tmp) => {
    const fer = runGit(
      [
        "for-each-ref",
        "--format=%(refname:short)|%(objectname)|%(committerdate:unix)",
        "refs/heads/handoff/",
      ],
      tmp,
    );
    if (fer.status !== 0) {
      throw new Error(`for-each-ref failed: ${fer.stderr.trim()}`);
    }
    const out = [];
    for (const line of fer.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [branch, commit, t] = trimmed.split("|");
      const committedAt = Number.parseInt(t, 10) * 1000;
      if (!Number.isFinite(committedAt)) {
        skipped.byMissingMeta += 1;
        continue;
      }
      if (committedAt > olderThanMs) {
        skipped.byAge += 1;
        continue;
      }
      const shown = runGit(["show", `refs/heads/${branch}:metadata.json`], tmp);
      if (shown.status !== 0) {
        skipped.byMissingMeta += 1;
        continue;
      }
      let meta;
      try {
        meta = JSON.parse(shown.stdout);
      } catch {
        skipped.byMissingMeta += 1;
        continue;
      }
      if (typeof meta?.hostname !== "string") {
        skipped.byMissingMeta += 1;
        continue;
      }
      if (meta.hostname !== ownHost) {
        skipped.byHost += 1;
        continue;
      }
      if (fromCli && meta.cli !== fromCli) {
        skipped.byFromCli += 1;
        continue;
      }
      out.push({
        branch,
        commit,
        committedAt,
        hostname: meta.hostname,
        cli: meta.cli ?? null,
      });
    }
    return out;
  });
  return { candidates, skipped, total: inventory.length };
}

/**
 * Escape a branch name for embedding in a RegExp. Branch names contain `/`
 * and digits; `.` and `+` are theoretically possible.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse `git push --porcelain --delete` stdout into per-ref outcomes for
 * the input branches. Each status line is tab-delimited:
 *
 *   <flag>\t<from>:<to>\t<summary>[ (<reason>)]
 *
 * For deletes, `<from>:<to>` is `:refs/heads/<branch>`. Recognized
 * combinations:
 *
 *   -\t:<ref>\t[deleted]
 *   !\t:<ref>\t[remote rejected] (<reason>)
 *   !\t:<ref>\t[rejected] (<reason>)
 *   !\t:<ref>\t[error] (<reason>)
 *
 * Porcelain is the preferred classification path because the format is
 * stable across git versions and machine-readable. A branch matched by
 * no line is returned in `unclassified` so the caller can fall back to
 * stderr parsing or a per-ref retry.
 *
 * @param {string} stdout
 * @param {string[]} branches
 * @returns {{ deleted: string[], failures: Array<{branch: string, reason: string}>, unclassified: string[] }}
 */
export function parsePushDeletePorcelain(stdout, branches) {
  const text = stdout || "";
  const deleted = [];
  const failures = [];
  const unclassified = [];
  for (const branch of branches) {
    const refPattern = `(?:refs/heads/)?${escapeRegExp(branch)}`;
    const deletedRe = new RegExp(`^-\\t:${refPattern}\\t\\[deleted\\]`, "m");
    const rejectedRe = new RegExp(
      `^!\\t:${refPattern}\\t\\[(?:remote rejected|rejected|error)\\](?:\\s+\\((.*)\\))?`,
      "m",
    );
    if (deletedRe.test(text)) {
      deleted.push(branch);
      continue;
    }
    const m = text.match(rejectedRe);
    if (m) {
      const reason = redactUrlSecrets((m[1] || "").trim()) || "rejected";
      failures.push({ branch, reason });
      continue;
    }
    unclassified.push(branch);
  }
  return { deleted, failures, unclassified };
}

/**
 * Parse `git push --delete` stderr into per-ref outcomes for the input
 * branches. Recognized line shapes (modern git, human format):
 *
 *   - [deleted]         <ref>
 *   ! [remote rejected] <ref> (<reason>)
 *   ! [rejected]        <ref> (<reason>)
 *   ! [error]           <ref> (<reason>)
 *
 * Used as a fallback when `--porcelain` stdout is missing/incomplete.
 * `<ref>` may appear with or without the `refs/heads/` prefix.
 *
 * @param {string} stderr
 * @param {string[]} branches
 * @returns {{ deleted: string[], failures: Array<{branch: string, reason: string}>, unclassified: string[] }}
 */
export function parsePushDeleteStderr(stderr, branches) {
  const text = stderr || "";
  const deleted = [];
  const failures = [];
  const unclassified = [];
  for (const branch of branches) {
    const refPattern = `(?:refs/heads/)?${escapeRegExp(branch)}`;
    const deletedRe = new RegExp(`^\\s*-\\s*\\[deleted\\]\\s+${refPattern}\\s*$`, "m");
    const rejectedRe = new RegExp(
      `^\\s*!\\s*\\[(?:remote rejected|rejected|error)\\]\\s+${refPattern}\\s+\\((.*)\\)\\s*$`,
      "m",
    );
    if (deletedRe.test(text)) {
      deleted.push(branch);
      continue;
    }
    const m = text.match(rejectedRe);
    if (m) {
      const reason = redactUrlSecrets((m[1] || "").trim()) || "rejected";
      failures.push({ branch, reason });
      continue;
    }
    unclassified.push(branch);
  }
  return { deleted, failures, unclassified };
}

/**
 * Delete N remote branches in one `git push --delete` call. Works from a
 * throwaway tmp git repo — no working tree, no commits required.
 *
 * On non-zero overall exit, parse `git push --delete` per-ref status from
 * stderr to partition the input into deleted vs. rejected. Branches the
 * parser cannot classify are retried one by one (bounded), so a corrupt
 * or unfamiliar stderr never causes us to lose a per-ref outcome silently.
 * If the parser produces no signal at all, fall back to the legacy
 * "all-failed with raw stderr" behavior so the operator still sees the
 * underlying error.
 *
 * @param {string} repoUrl
 * @param {string[]} branches
 * @returns {{ deleted: string[], failures: Array<{branch: string, reason: string}> }}
 */
export function deleteRemoteBranches(repoUrl, branches) {
  if (branches.length === 0) return { deleted: [], failures: [] };
  const tmp = mkdtempSync(join(tmpdir(), "handoff-prune-delete-"));
  try {
    const init = runGit(["init", "-q"], tmp);
    if (init.status !== 0) {
      throw new Error(`git init failed: ${init.stderr.trim()}`);
    }
    const refs = branches.map((b) => `refs/heads/${b}`);
    const r = runGit(["push", "--porcelain", repoUrl, "--delete", ...refs], tmp);
    if (r.status === 0) {
      return { deleted: branches.slice(), failures: [] };
    }
    const stdout = r.stdout || "";
    const stderr = r.stderr || "";
    const fromPorcelain = parsePushDeletePorcelain(stdout, branches);
    const fromStderr = parsePushDeleteStderr(stderr, fromPorcelain.unclassified);
    const deleted = [...fromPorcelain.deleted, ...fromStderr.deleted];
    const failures = [...fromPorcelain.failures, ...fromStderr.failures];
    for (const branch of fromStderr.unclassified) {
      const rr = runGit(["push", "--porcelain", repoUrl, "--delete", `refs/heads/${branch}`], tmp);
      if (rr.status === 0) {
        deleted.push(branch);
        continue;
      }
      const rrPorcelain = parsePushDeletePorcelain(rr.stdout || "", [branch]);
      if (rrPorcelain.deleted.length === 1) {
        deleted.push(branch);
        continue;
      }
      if (rrPorcelain.failures.length === 1) {
        failures.push(rrPorcelain.failures[0]);
        continue;
      }
      const rrText = (rr.stderr || rr.stdout || "").trim();
      const rrStderr = parsePushDeleteStderr(rrText, [branch]);
      if (rrStderr.failures.length === 1) {
        failures.push(rrStderr.failures[0]);
        continue;
      }
      const firstLine = redactUrlSecrets(rrText).split("\n")[0].trim();
      failures.push({ branch, reason: firstLine || "unknown error" });
    }
    if (deleted.length === 0 && failures.length === 0) {
      const raw = stderr.trim() || stdout.trim();
      const reason = redactUrlSecrets(raw) || "unknown error";
      return { deleted: [], failures: branches.map((branch) => ({ branch, reason })) };
    }
    return { deleted, failures };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Resolve a remote handoff branch by query, pick interactively on collision. */
export async function pullRemote(query, fromCli = null, { verify = false, verbose = false } = {}) {
  const repoUrl = requireTransportRepoStrict();
  autoPreflight({ repo: repoUrl, verify, verbose });
  let candidates = listRemoteCandidates();
  if (candidates.length === 0)
    throw new HandoffError({
      stage: "resolve",
      cause: "no handoffs on transport",
      fix: "Push a session first: `dotbabel handoff push`",
      retry: "dotbabel handoff push",
    });

  // v2 carries the CLI in segment 2 (handoff/<project>/<cli>/...);
  // v1 legacy carries it in segment 1 (handoff/<cli>/<short>).
  if (fromCli) {
    candidates = candidates.filter((c) => {
      const segs = c.branch.split("/");
      return segs[2] === fromCli || segs[1] === fromCli;
    });
    if (candidates.length === 0)
      throw new HandoffError({
        stage: "resolve",
        cause: `no ${fromCli} handoffs on transport`,
        fix: `Push a ${fromCli} session first: \`dotbabel handoff push\``,
        retry: `dotbabel handoff fetch --from ${fromCli}`,
      });
  }

  // Bare: pick the newest by commit date. Short UUIDs are 8 hex chars
  // of a v4 random UUID, so lexical order is random with respect to
  // push time — the previous implementation could return a stale
  // branch silently. sortByCommitterDate pays one shallow fetch to
  // get a correct answer, and falls back to ls-remote order on
  // transient failure with a stderr warning.
  if (!query) {
    const sorted = sortByCommitterDate(candidates, repoUrl);
    return sorted ? sorted[0] : candidates[candidates.length - 1];
  }

  // Cheap pass: filter by branch name (no description fetch). Preserves the
  // O(1)-network behavior for `pull <short-uuid>` against large transports.
  const cheap = candidates.filter((c) => matchesQuery(c, query));
  // Description-side tags are always slugified by handoff-description.sh,
  // so slugify the query once here. Lets `fetch "Foo Bar!"` match a branch
  // tagged `foo-bar` instead of silently failing the exact-match pre-pass.
  const querySlug = slugify(query);
  let hits;
  if (cheap.length === 1) {
    // Unambiguous cheap hit — return without enriching. Saves one
    // description fetch on the common `fetch <short-uuid>` path.
    hits = cheap;
  } else if (cheap.length > 1) {
    // Multiple cheap hits — enrich for the collision UI and prefer exact-tag
    // matches within (#91 Gap 7).
    const enriched = enrichWithDescriptions(cheap);
    const tagHits = enriched.filter((c) =>
      parseTagsFromDescription(c.description).includes(querySlug),
    );
    hits = tagHits.length > 0 ? tagHits : enriched;
  } else {
    // No cheap match — enrich everyone, try exact-tag first (#91 Gap 7),
    // fall back to description substring.
    const enriched = enrichWithDescriptions(candidates);
    const tagHits = enriched.filter((c) =>
      parseTagsFromDescription(c.description).includes(querySlug),
    );
    hits = tagHits.length > 0 ? tagHits : enriched.filter((c) => matchesQuery(c, query));
  }

  if (hits.length === 0) {
    throw new HandoffError({
      stage: "resolve",
      cause: fromCli ? `no ${fromCli} handoffs match: ${query}` : `no handoffs match: ${query}`,
      fix: "Run `dotbabel handoff remote-list` to see what's available",
      retry: `dotbabel handoff fetch ${query}`,
    });
  }
  if (hits.length === 1) return hits[0];

  // Collision.
  if (process.stdin.isTTY) {
    process.stderr.write(`dotbabel-handoff: multiple handoffs match "${query}":\n`);
    hits.forEach((h, i) => {
      process.stderr.write(`  [${i + 1}] ${h.branch}  ${h.description}\n`);
    });
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ans = await new Promise((resolve) => {
      rl.question("Pick [1..N], or any other input to abort: ", resolve);
    });
    rl.close();
    const n = Number.parseInt(ans.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > hits.length) process.exit(2);
    return hits[n - 1];
  }
  process.stderr.write(`dotbabel-handoff: multiple handoffs match "${query}":\n`);
  for (const h of hits) process.stderr.write(`  ${h.branch}\t${h.description}\n`);
  process.exit(2);
}
