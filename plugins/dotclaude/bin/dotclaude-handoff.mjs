#!/usr/bin/env node
/**
 * dotclaude-handoff — five-form cross-agent / cross-machine handoff.
 *
 * Usage:
 *   dotclaude handoff                              push host's latest session
 *   dotclaude handoff <query>                      local cross-agent: emit <handoff> block
 *   dotclaude handoff push [<query>] [--tag <label>]
 *   dotclaude handoff pull [<query>]
 *   dotclaude handoff list [--local|--remote]
 *   dotclaude handoff doctor
 *   dotclaude handoff remote-list [--cli <cli>] [--since <ISO>] [--limit <N>]
 *   dotclaude handoff search <query> [--cli <cli>] [--since <ISO>] [--limit <N>]
 *
 * Remote transport is always git: push/pull commit a `handoff/<cli>/<short>`
 * branch into the user-owned private repo named by `DOTCLAUDE_HANDOFF_REPO`.
 *
 * Power-user sub-commands (still work):
 *   resolve   <cli> <id>         print resolved session file path
 *   describe  <cli> <id>         inline summary (markdown or --json)
 *   digest    <cli> <id>         full <handoff> block for paste
 *   file      <cli> <id>         write markdown handoff doc to disk
 *
 * `<query>` resolves across all three CLIs (claude, copilot, codex):
 * full UUID, short UUID (first 8 hex), `latest`, or a named alias
 * (Claude customTitle, Codex thread_name).
 *
 * Exits: 0 ok, 2 not-found / runtime error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { scrubDigest } from "../src/lib/handoff-scrub.mjs";
import { version } from "../src/index.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { createInterface } from "node:readline";

const POWER_SUBS = new Set(["resolve", "describe", "digest", "file"]);
const CLIS = new Set(["claude", "copilot", "codex"]);

// Branch shape written by `push`. The store is unceremonial — there is
// no schema pin on `main`, no `init` step, no server-side enforcement;
// the binary is the only writer and reader, so consistency comes from
// shipping a single version of this regex everywhere.
const V2_BRANCH_RE =
  /^handoff\/[a-z0-9-]+\/(claude|copilot|codex)\/\d{4}-\d{2}\/[0-9a-f]{8}$/;
const V1_BRANCH_RE = /^handoff\/(claude|copilot|codex)\/[0-9a-f]{8}$/;

// Persisted config lives under $XDG_CONFIG_HOME (~/.config by default).
// Shell-sourceable `.env`-style; one KEY=VALUE per line. Created by
// the first successful bootstrap so subsequent pushes don't re-prompt.
const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config"),
  "dotclaude"
);
const CONFIG_FILE = join(CONFIG_DIR, "handoff.env");

const META = {
  name: "dotclaude-handoff",
  synopsis:
    "dotclaude handoff [<query>|push|pull|list|doctor|remote-list|search] [args...] [--from <cli>] [--to <cli>] [--tag <label>] [--cli <cli>] [--since <ISO>] [--limit <N>]",
  description:
    "Cross-agent and cross-machine session handoff. Bare <query> emits a <handoff> block for local cross-agent. push/pull/list handle the remote transport (a user-owned private git repo named by DOTCLAUDE_HANDOFF_REPO).",
  flags: {
    tag: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    limit: { type: "string" },
    since: { type: "string" },
    cli: { type: "string" },
    "out-dir": { type: "string" },
    local: { type: "boolean" },
    remote: { type: "boolean" },
  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolvePath(__dirname, "..", "scripts");
const RESOLVE_SH = join(SCRIPTS, "handoff-resolve.sh");
const EXTRACT_SH = join(SCRIPTS, "handoff-extract.sh");
const DESCRIPTION_SH = join(SCRIPTS, "handoff-description.sh");
const DOCTOR_SH = join(SCRIPTS, "handoff-doctor.sh");

function fail(code, msg) {
  if (msg) process.stderr.write(`dotclaude-handoff: ${msg}\n`);
  process.exit(code);
}

function runScript(script, args, opts = {}) {
  const res = spawnSync(script, args, { encoding: "utf8", ...opts });
  return { status: res.status ?? 2, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function runGit(args, cwd) {
  return spawnSync("git", args, { encoding: "utf8", cwd });
}

function runGitOrThrow(args, cwd) {
  const r = runGit(args, cwd);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

// ---- resolver / extractor bridge ---------------------------------------

/**
 * @typedef {{cli: string, sessionId: string, path: string, query: string}} Candidate
 */

/**
 * Call `handoff-resolve.sh any <query>`. Handles the collision contract:
 *   - 0 hits: exits 2 (bubble up)
 *   - 1 hit:  returns {cli, path}
 *   - >1 hit: on TTY prompt the user to pick; non-TTY emits candidates
 *             and exits 2.
 *
 * @param {string} query
 * @returns {Promise<{cli: string, path: string}>}
 */
async function resolveAny(query) {
  const r = runScript(RESOLVE_SH, ["any", query]);
  if (r.status === 0) {
    const path = r.stdout.trim();
    const cli = cliFromPath(path);
    return { cli, path };
  }
  // status != 0. If stderr begins with "multiple sessions match", it is a
  // collision. Otherwise it's "no session matches" or an env error.
  const stderr = r.stderr;
  if (!stderr.includes("multiple sessions match")) {
    fail(r.status === 64 ? EXIT_CODES.USAGE : 2, stderr.trim() || `no session matches: ${query}`);
  }
  // Parse candidate TSV lines (4 fields: cli\tsid\tpath\tquery).
  const candidates = [];
  for (const line of stderr.split("\n")) {
    const parts = line.split("\t");
    if (parts.length === 4) {
      candidates.push({ cli: parts[0], sessionId: parts[1], path: parts[2], query: parts[3] });
    }
  }
  if (process.stdin.isTTY) {
    return await promptCollisionChoice(query, candidates);
  }
  // Non-TTY: pass through the script's stderr and exit 2.
  process.stderr.write(stderr);
  process.exit(2);
}

/**
 * Resolve `<id>` against a single CLI's root. Thin wrapper over the
 * per-CLI entry point of handoff-resolve.sh — no collision handling
 * because the per-CLI resolvers return at most one hit.
 *
 * @param {string} cli    one of CLIS
 * @param {string} id     uuid | short-uuid | "latest" | alias
 * @returns {{cli: string, path: string}}
 */
function resolveNarrowed(cli, id) {
  const r = runScript(RESOLVE_SH, [cli, id]);
  if (r.status !== 0) {
    fail(r.status === 64 ? EXIT_CODES.USAGE : 2, r.stderr.trim() || `no ${cli} session matches: ${id}`);
  }
  return { cli, path: r.stdout.trim() };
}

async function promptCollisionChoice(query, candidates) {
  process.stderr.write(`dotclaude-handoff: multiple sessions match "${query}":\n`);
  candidates.forEach((c, i) => {
    process.stderr.write(`  [${i + 1}] ${c.cli.padEnd(8)} ${c.sessionId}  ${c.path}\n`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ans = await new Promise((resolve) => {
    rl.question("Pick [1..N], or any other input to abort: ", resolve);
  });
  rl.close();
  const n = Number.parseInt(ans.trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
    process.exit(2);
  }
  const chosen = candidates[n - 1];
  return { cli: chosen.cli, path: chosen.path };
}

function cliFromPath(path) {
  if (path.includes("/.claude/projects/")) return "claude";
  if (path.includes("/.copilot/session-state/")) return "copilot";
  if (path.includes("/.codex/sessions/")) return "codex";
  return "claude";
}

function extractMeta(cli, file) {
  const r = runScript(EXTRACT_SH, ["meta", cli, file]);
  if (r.status !== 0) fail(2, r.stderr.trim() || `meta extraction failed for ${cli}`);
  try {
    return JSON.parse(r.stdout.trim());
  } catch (err) {
    fail(2, `meta returned non-JSON: ${err.message}`);
  }
}

function extractLines(sub, cli, file, extra = []) {
  const r = runScript(EXTRACT_SH, [sub, cli, file, ...extra]);
  if (r.status !== 0) {
    if (r.stderr.trim()) process.stderr.write(`dotclaude-handoff: ${sub}: ${r.stderr.trim()}\n`);
    return [];
  }
  return r.stdout.split("\n").filter((line) => line.trim().length > 0);
}

const extractPrompts = (cli, file) => extractLines("prompts", cli, file);
const extractTurns = (cli, file, limit) =>
  extractLines("turns", cli, file, limit ? [String(limit)] : []);

// ---- rendering ---------------------------------------------------------

function nextStepFor(toCli) {
  if (toCli === "codex") {
    return "Read the prompts and assistant turns above, then continue the task using the file paths mentioned. Treat this as a task specification.";
  }
  if (toCli === "copilot") {
    return "Help me pick up where this session left off; reference the prompts and findings above.";
  }
  return "Continue from the last assistant turn using the same file scope and goals summarized above.";
}

function mechanicalSummary(prompts, turns) {
  const first = prompts[0] ?? "(no user prompts captured)";
  const last = turns[turns.length - 1] ?? "(no assistant turns captured)";
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trim()}…` : s);
  return `Session opened with: "${clip(first, 160)}". Last assistant output (truncated): "${clip(last, 160)}". Full prompt log and assistant tail follow for context.`;
}

function renderDescribeMarkdown(meta, prompts) {
  const lines = [];
  lines.push(
    `**${meta.cli}** \`${meta.short_id ?? "?"}\` — \`${meta.cwd ?? "(cwd unknown)"}\` — ${meta.started_at ?? ""}`
  );
  lines.push("");
  lines.push("**User prompts:**");
  lines.push("");
  const toShow = prompts.slice(0, 10);
  if (toShow.length === 0) lines.push("- (no user prompts captured)");
  else for (const p of toShow) lines.push(`- ${p.length > 200 ? `${p.slice(0, 200).trim()}…` : p}`);
  if (prompts.length > 10) lines.push(`- …and ${prompts.length - 10} more (truncated)`);
  lines.push("");
  lines.push(`**Prompt count:** ${prompts.length}`);
  return lines.join("\n");
}

function renderHandoffBlock(meta, prompts, turns, toCli) {
  const summary = mechanicalSummary(prompts, turns);
  const promptsCapped = prompts.slice(-10);
  const turnsTail = turns.slice(-3);
  const next = nextStepFor(toCli);
  const lines = [];
  lines.push(
    `<handoff origin="${meta.cli}" session="${meta.short_id ?? ""}" cwd="${meta.cwd ?? ""}" target="${toCli}">`
  );
  lines.push("");
  lines.push(`**Summary.** ${summary}`);
  lines.push("");
  lines.push("**User prompts (last 10, in order).**");
  lines.push("");
  if (promptsCapped.length === 0) lines.push("1. (no user prompts captured)");
  else
    promptsCapped.forEach((p, i) => {
      const trimmed = p.length > 300 ? `${p.slice(0, 300).trim()}…` : p;
      lines.push(`${i + 1}. ${trimmed}`);
    });
  lines.push("");
  lines.push("**Last assistant turns (tail).**");
  lines.push("");
  if (turnsTail.length === 0) lines.push("_(no assistant output captured)_");
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

// ---- local session enumeration (list --local) --------------------------

const UUID_HEAD_RE = /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const CLI_LAYOUTS = {
  claude: {
    root: (home) => join(home, ".claude", "projects"),
    walk: 1,
    match: (name) => name.endsWith(".jsonl"),
  },
  copilot: {
    root: (home) => join(home, ".copilot", "session-state"),
    walk: 1,
    match: (name) => name === "events.jsonl",
  },
  codex: {
    root: (home) => join(home, ".codex", "sessions"),
    walk: 3,
    match: (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
  },
};

function collectSessionFiles(root, walk, match) {
  const files = [];
  const recur = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < walk) recur(full, depth + 1);
      } else if (ent.isFile() && match(ent.name)) {
        files.push(full);
      }
    }
  };
  recur(root, 0);
  return files;
}

function listLocalSessions(cli) {
  const layout = CLI_LAYOUTS[cli];
  if (!layout) return [];
  const root = layout.root(process.env.HOME ?? "");
  if (!existsSync(root)) return [];
  const rows = [];
  for (const file of collectSessionFiles(root, layout.walk, layout.match)) {
    let mtime;
    try {
      mtime = statSync(file).mtimeMs / 1000;
    } catch {
      continue;
    }
    const m = file.match(UUID_HEAD_RE);
    const shortId = m ? m[1] : "?";
    const when = new Date(mtime * 1000).toISOString().replace("T", " ").slice(0, 16);
    rows.push({ location: "local", cli, short_id: shortId, file, mtime, when });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

function listAllLocalSessions() {
  return [...listLocalSessions("claude"), ...listLocalSessions("copilot"), ...listLocalSessions("codex")].sort(
    (a, b) => b.mtime - a.mtime
  );
}

// ---- remote transport (git, the only transport since v0.9.0) ----------

// Reject ext:: and other exec-triggering Git URL schemes (CVE-2017-1000117-class).
// Allow: https://, http://, git@, ssh://, file://, and absolute paths (bare repos).
function validateTransportUrl(url) {
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(url))
    fail(2, `DOTCLAUDE_HANDOFF_REPO must be an https://, git@, ssh://, file://, or absolute path (got: ${url})`);
  return url;
}

// Source ~/.config/dotclaude/handoff.env if present, seeding any missing
// env var. Shell rc users can `source` the same file; bypass is trivial
// via an explicit `DOTCLAUDE_HANDOFF_REPO=...` on the command line.
function loadPersistedEnv() {
  if (!existsSync(CONFIG_FILE)) return;
  let contents;
  try {
    contents = readFileSync(CONFIG_FILE, "utf8");
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

// Best-effort slugify matching what `gh repo create` will accept. Stricter
// than handoff-description.sh's slugify because GitHub repo names reject
// leading/trailing dashes and double-dashes.
function slugifyRepoName(input) {
  const s = (input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 100);
}

function isTty() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

// Three-line manual-setup block. Printed when we can't (or shouldn't)
// auto-create — non-TTY, no `gh`, or user declines the prompt.
function printManualSetupBlock(reason) {
  const msg = [
    "",
    `Can't auto-bootstrap the handoff store: ${reason}`,
    "",
    "Set it up manually:",
    "  1. gh repo create <you>/dotclaude-handoff-store --private",
    "  2. export DOTCLAUDE_HANDOFF_REPO=git@github.com:<you>/dotclaude-handoff-store.git",
    "  3. dotclaude handoff push   # retries",
    "",
    "Alternative providers (GitLab, Gitea, self-hosted) work too — set",
    "DOTCLAUDE_HANDOFF_REPO to any ssh://, git@, https://, file://, or absolute path.",
    "",
  ];
  process.stderr.write(msg.join("\n"));
}

function ghAvailable() {
  const r = spawnSync("gh", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

function ghAuthenticated() {
  const r = spawnSync("gh", ["auth", "status", "-h", "github.com"], { encoding: "utf8" });
  return r.status === 0;
}

function ghLogin() {
  const r = spawnSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

// Synchronous readline prompt that mirrors the existing collision-prompt
// pattern (createInterface + rl.question + close). Returns the trimmed
// answer, or "" for empty input.
async function promptLine(message) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((resolve) => {
      rl.question(message, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

// Interactive repo creation. Prompts for a name (default
// `dotclaude-handoff-store`), confirms, runs `gh repo create --private`,
// writes the URL to ~/.config/dotclaude/handoff.env, and exports it
// in-process so the current run continues without re-reading.
//
// Exits 2 with a manual-setup block when we can't proceed:
//   - no TTY (cron/CI)
//   - `gh` missing or unauthenticated
//   - the user aborts
async function bootstrapTransportRepo() {
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

  process.stderr.write(
    [
      "",
      "DOTCLAUDE_HANDOFF_REPO is not set — dotclaude can set this up for you.",
      "",
      `  Detected: gh CLI authenticated as @${login}.`,
      `  Plan: create private repo  ${login}/<name>`,
      `        persist URL to       ${CONFIG_FILE}`,
      "",
    ].join("\n")
  );

  let name = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const input = await promptLine("  Repo name? [dotclaude-handoff-store] ");
    const candidate = input === "" ? "dotclaude-handoff-store" : slugifyRepoName(input);
    if (/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/.test(candidate)) {
      name = candidate;
      break;
    }
    process.stderr.write(
      "  Name must be 1-100 chars of [a-z0-9-], no leading/trailing dash. Try again.\n"
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
    ["repo", "create", `${login}/${name}`, "--private", "--description", "dotclaude handoff store"],
    { encoding: "utf8" }
  );
  if (create.status !== 0) {
    const stderr = (create.stderr || "").toLowerCase();
    // Idempotent: an existing repo is not a failure — we'll push to it.
    if (!stderr.includes("already exists") && !stderr.includes("name already exists on this account")) {
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
    { encoding: "utf8" }
  );
  const url = view.status === 0 && view.stdout.trim()
    ? view.stdout.trim()
    : `git@github.com:${login}/${name}.git`;

  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    CONFIG_FILE,
    `# Written by dotclaude handoff on ${new Date().toISOString()}\n` +
      `# Sourceable from your shell rc:  source ${CONFIG_FILE}\n` +
      `export DOTCLAUDE_HANDOFF_REPO=${url}\n`,
    { mode: 0o600 }
  );
  process.stderr.write(`  ✓ wrote ${CONFIG_FILE}\n`);
  process.stderr.write(
    `    (add \`source ${CONFIG_FILE}\` to ~/.bashrc or ~/.zshrc to persist across shells)\n`
  );

  process.env.DOTCLAUDE_HANDOFF_REPO = url;
  return url;
}

// Public entry point: return a validated transport URL, bootstrapping
// interactively if the env var is missing. Called by push/pull/list/
// doctor, i.e. anywhere the remote is required.
async function requireTransportRepo() {
  const existing = process.env.DOTCLAUDE_HANDOFF_REPO;
  if (existing) return validateTransportUrl(existing);
  const fresh = await bootstrapTransportRepo();
  return validateTransportUrl(fresh);
}

// Synchronous variant for read-only paths (list, remote-list, doctor
// shell script) that can't meaningfully trigger an interactive bootstrap
// mid-command. Fails hard instead.
function requireTransportRepoStrict() {
  const url = process.env.DOTCLAUDE_HANDOFF_REPO;
  if (!url) fail(2, "DOTCLAUDE_HANDOFF_REPO is not set — run `dotclaude handoff push` to auto-bootstrap, or set it manually");
  return validateTransportUrl(url);
}

function encodeDescription({ cli, shortId, project, host, month, tag }) {
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

// Mirror of the shell `slugify` in handoff-description.sh so JS-side
// encoders and the shell decoder agree on the edge cases (dash-run
// collapse, trimmed edges, "" → "adhoc" fallback).
function slugify(s) {
  if (!s) return "adhoc";
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.slice(0, 40) || "adhoc";
}

// Walk up to the git-repo root so a session deep in `~/foo/services/api`
// groups under `foo`, not `api`. Falls back to the cwd basename outside
// a git repo.
function projectSlugFromCwd(cwd) {
  if (!cwd) return "adhoc";
  const r = runGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
  const root = r.status === 0 ? r.stdout.trim() : "";
  const last = (root || cwd).split("/").filter(Boolean).pop() || "adhoc";
  return slugify(last);
}

function monthBucket(isoOrNull) {
  const d = isoOrNull ? new Date(isoOrNull) : new Date();
  if (Number.isNaN(d.getTime())) return monthBucket(null);
  const yyyy = d.getUTCFullYear().toString();
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function v2BranchName({ project, cli, month, shortId }) {
  return `handoff/${slugify(project)}/${cli}/${month}/${shortId}`;
}

// Detect the "remote repo doesn't exist / auth failed" class of errors
// from `git push` stderr. GitHub, GitLab, Gitea and plain SSH all phrase
// it slightly differently, so match on the union.
function isRepoMissingError(stderr) {
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

async function pushRemote({ cli, path: sessionFile, tag }) {
  let repoUrl = await requireTransportRepo();
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
  const description = encodeDescription({
    cli: meta.cli,
    shortId,
    project,
    host,
    month,
    tag: tag || null,
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
    tag: tag || null,
  };

  const doPush = (url) => {
    const tmp = mkdtempSync(join(tmpdir(), "handoff-push-"));
    try {
      runGitOrThrow(["init", "-q"], tmp);
      runGitOrThrow(["remote", "add", "origin", url], tmp);
      runGitOrThrow(["config", "user.email", "handoff@dotclaude.local"], tmp);
      runGitOrThrow(["config", "user.name", "dotclaude-handoff"], tmp);
      const branch = v2BranchName({ project, cli: meta.cli, month, shortId });
      runGitOrThrow(["checkout", "-q", "-b", branch], tmp);
      writeFileSync(join(tmp, "handoff.md"), scrubbed + "\n");
      writeFileSync(join(tmp, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
      writeFileSync(join(tmp, "description.txt"), description + "\n");
      runGitOrThrow(["add", "."], tmp);
      runGitOrThrow(["commit", "-q", "-m", description], tmp);
      runGitOrThrow(["push", "-q", "-f", "origin", branch], tmp);
      return { branch, url, description, scrubbedCount };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
        `configured repo is unreachable (${process.env.DOTCLAUDE_HANDOFF_REPO}) and we can't prompt in non-interactive mode`
      );
      throw err;
    }
    process.stderr.write(
      `\n  The configured repo (${process.env.DOTCLAUDE_HANDOFF_REPO}) is unreachable.\n`
    );
    const again = await promptLine("  Re-bootstrap (create a new one)? [y/N] ");
    if (!/^y(es)?$/i.test(again)) throw err;
    // Clear the stale URL so bootstrapTransportRepo() doesn't short-circuit.
    delete process.env.DOTCLAUDE_HANDOFF_REPO;
    const fresh = await bootstrapTransportRepo();
    return doPush(validateTransportUrl(fresh));
  }
}

/**
 * List handoff branches on the remote as candidate objects.
 * Returns [{branch, description, commit}] — no content fetched.
 */
function listRemoteCandidates() {
  const repoUrl = requireTransportRepoStrict();
  const r = runGit(["ls-remote", repoUrl, "refs/heads/handoff/*"]);
  if (r.status !== 0) fail(2, `ls-remote failed: ${r.stderr.trim()}`);
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
function fetchRemoteBranch(branch) {
  const repoUrl = requireTransportRepoStrict();
  const tmp = mkdtempSync(join(tmpdir(), "handoff-pull-"));
  try {
    const r = runGit(["clone", "-q", "--depth", "1", "--branch", branch, repoUrl, "."], tmp);
    if (r.status !== 0) {
      throw new Error(`clone --branch ${branch} failed: ${r.stderr.trim()}`);
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
function enrichWithDescriptions(candidates) {
  return candidates.map((c) => {
    try {
      const { description } = fetchRemoteBranch(c.branch);
      return { ...c, description };
    } catch {
      return c;
    }
  });
}

function matchesQuery(candidate, query) {
  const q = query.toLowerCase();
  if (candidate.branch.toLowerCase().includes(q)) return true;
  if (candidate.description && candidate.description.toLowerCase().includes(q)) return true;
  if (candidate.commit && candidate.commit.toLowerCase().startsWith(q)) return true;
  return false;
}

async function pullRemote(query, fromCli = null) {
  let candidates = listRemoteCandidates();
  if (candidates.length === 0) fail(2, "no handoffs found on transport");

  // v2 carries the CLI in segment 2 (handoff/<project>/<cli>/...);
  // v1 legacy carries it in segment 1 (handoff/<cli>/<short>).
  if (fromCli) {
    candidates = candidates.filter((c) => {
      const segs = c.branch.split("/");
      return segs[2] === fromCli || segs[1] === fromCli;
    });
    if (candidates.length === 0) fail(2, `no ${fromCli} handoffs found on transport`);
  }

  // Bare: pick the newest. We don't have a reliable remote mtime, so
  // fall back to the lexically last branch, which is typically the
  // most recent since short IDs hash-distribute. The caller re-fetches
  // the branch contents via fetchRemoteBranch, so skipping the
  // enrichment pass saves N shallow clones.
  if (!query) {
    return candidates[candidates.length - 1];
  }

  // Cheap pass: filter by branch name.
  let hits = candidates.filter((c) => matchesQuery(c, query));
  if (hits.length === 0) {
    // Expensive pass: enrich with descriptions and re-match.
    const enriched = enrichWithDescriptions(candidates);
    hits = enriched.filter((c) => matchesQuery(c, query));
  } else {
    hits = enrichWithDescriptions(hits);
  }

  if (hits.length === 0) {
    fail(2, fromCli ? `no ${fromCli} handoffs match: ${query}` : `no handoffs match: ${query}`);
  }
  if (hits.length === 1) return hits[0];

  // Collision.
  if (process.stdin.isTTY) {
    process.stderr.write(`dotclaude-handoff: multiple handoffs match "${query}":\n`);
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
  process.stderr.write(`dotclaude-handoff: multiple handoffs match "${query}":\n`);
  for (const h of hits) process.stderr.write(`  ${h.branch}\t${h.description}\n`);
  process.exit(2);
}

// ---- host session detection --------------------------------------------

/**
 * Best-effort identification of the agentic CLI the binary is running
 * inside. Returns "claude" | "copilot" | "codex" | "unknown".
 *
 * All four signals below are UNCONFIRMED in the dotclaude codebase:
 * neither the repo nor the upstream CLIs document stable env-var
 * contracts. The probes are intentionally cheap — a false positive
 * only steers `bare push` into a narrower root than `resolveAny`,
 * which still succeeds when sessions exist there. A false negative
 * falls back to "unknown" and the union resolver.
 *
 * Probe order matters when multiple probes fire: claude probes run
 * first, then codex, then copilot. The realistic multi-signal case
 * is env inheritance — e.g. `dotclaude-handoff` invoked inside a
 * Codex session that was launched from a Claude Code bash shell
 * inherits `CLAUDECODE=1`. In that case "claude wins", which is a
 * sensible default because the outer shell is typically the source
 * of truth; callers who want the inner CLI should pass `--from`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"claude" | "copilot" | "codex" | "unknown"}
 */
function detectHost(env = process.env) {
  // UNCONFIRMED: Claude Code is widely believed to set CLAUDECODE=1
  // in its bash tool. Treated as the primary signal.
  if (env.CLAUDECODE === "1") return "claude";
  // UNCONFIRMED: anecdotal fallback for Claude Code; the SSE port is
  // set in some launch paths but not others.
  if (env.CLAUDE_CODE_SSE_PORT) return "claude";
  // UNCONFIRMED: Codex CLI env-var contract is undocumented. Probe
  // the CODEX_ prefix first so codex wins deterministically over
  // copilot regardless of env iteration order.
  for (const k in env) {
    if (k.startsWith("CODEX_")) return "codex";
  }
  // UNCONFIRMED: Copilot CLI markers. Both prefixes are checked to
  // avoid guessing which GitHub tooling variant is in use.
  for (const k in env) {
    if (k.startsWith("GITHUB_COPILOT_") || k.startsWith("COPILOT_")) return "copilot";
  }
  return "unknown";
}

// ---- doctor / remote-list / search (binary-side parity with SKILL.md) --

/**
 * Decode a `handoff:v1:...` description string by shelling out to
 * handoff-description.sh — keeps the schema owner in one place.
 */
function decodeDescription(desc) {
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

/**
 * Truncate `s` to `max` chars, appending `…` when it gets clipped.
 * Used by `search` to keep snippet cells at a sane width.
 */
function truncate(s, max) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Port of SKILL.md's `search` algorithm (L258-324 in v0.8.0). Walks
 * each CLI's session roots, mtime-prefilters against `--since`,
 * matches the raw JSONL via a case-insensitive regex, then refines
 * the hit against the extracted user prompts so matches in
 * tool-use / metadata noise are dropped.
 *
 * Returns a newest-first array of {cli, short_id, cwd, mtime,
 * snippet} objects capped at `limit`. The binary caller handles
 * table rendering vs `--json` serialization.
 */
function searchSessions({ query, cli, since, limit }) {
  const re = new RegExp(query, "i");
  const sinceMs = since
    ? Date.parse(since)
    : Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (Number.isNaN(sinceMs)) fail(EXIT_CODES.USAGE, `--since must be ISO-8601, got: ${since}`);
  const clis = cli ? [cli] : Object.keys(CLI_LAYOUTS);
  const out = [];
  for (const c of clis) {
    const layout = CLI_LAYOUTS[c];
    if (!layout) continue;
    const root = layout.root(process.env.HOME ?? "");
    if (!existsSync(root)) continue;
    for (const file of collectSessionFiles(root, layout.walk, layout.match)) {
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < sinceMs) continue;
      let raw;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!re.test(raw)) continue;
      const prompts = extractPrompts(c, file);
      const hit = prompts.find((p) => re.test(p));
      if (!hit) continue;
      const meta = extractMeta(c, file);
      const m = file.match(UUID_HEAD_RE);
      out.push({
        cli: c,
        short_id: m ? m[1] : "?",
        cwd: meta.cwd ?? null,
        mtime: stat.mtimeMs,
        snippet: truncate(`user: ${hit}`, 80),
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, Number.parseInt(limit ?? "20", 10));
}

// ---- main --------------------------------------------------------------

// Seed env vars from the persisted config before anything else reads
// process.env. Idempotent; skipped when the file is absent.
loadPersistedEnv();

let argv;
try {
  argv = parse(process.argv.slice(2), META.flags);
} catch (err) {
  fail(EXIT_CODES.USAGE, err.message);
}

if (argv.help) {
  process.stdout.write(`${helpText(META)}\n\nSee skills/handoff/SKILL.md for the full reference.\n`);
  process.exit(EXIT_CODES.OK);
}
if (argv.version) {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

// Note: `--via` was removed in v0.9.0 along with the gist transports.
// The argv parser rejects it as an unknown option; no explicit guard
// needed here. Bats coverage for the rejection lives in
// dotclaude-handoff-five-form.bats.

const limit = argv.flags.limit ?? "20";
if (!/^\d+$/.test(limit.toString())) fail(EXIT_CODES.USAGE, `--limit must be a non-negative integer, got: ${limit}`);

const detectedHost = detectHost();
const toCli = (argv.flags.to ?? (detectedHost === "unknown" ? "claude" : detectedHost)).toString();
if (!CLIS.has(toCli)) fail(EXIT_CODES.USAGE, `--to must be one of: ${[...CLIS].join(", ")}`);

const fromCli = argv.flags.from ? String(argv.flags.from) : null;
if (fromCli !== null && !CLIS.has(fromCli)) {
  fail(EXIT_CODES.USAGE, `--from must be one of: ${[...CLIS].join(", ")}`);
}

const [first, second, third] = argv.positional;

function shortIdFromPath(path) {
  const m = path?.match(UUID_HEAD_RE);
  return m ? m[1] : "?";
}

async function main() {
  // ---- breaking-change shim ---------------------------------------------
  // A lone CLI name is never a valid query under the new surface, so
  // catch `push/pull claude|copilot|codex` (with or without a trailing
  // positional) and point the user at --from.
  if ((first === "push" || first === "pull") && CLIS.has(second)) {
    fail(
      EXIT_CODES.USAGE,
      `${first} no longer takes a <cli> positional; use --from ${second} or drop it entirely`
    );
  }

  // ---- doctor / remote-list / search -------------------------------------
  // These were previously skill-interpreted (Claude/Copilot read SKILL.md
  // and ran the steps by hand). Porting them into the binary closes the
  // Codex parity gap — Codex's bash tool can call them directly.

  if (first === "doctor") {
    const r = runScript(DOCTOR_SH, []);
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    // Enrich the shell script's output with one line each for: persisted
    // config, gh usable as bootstrap fallback, and the current repo URL.
    // These are diagnostics, not gates — no exit-code change.
    const configLoaded = existsSync(CONFIG_FILE);
    process.stdout.write(
      `config: ${configLoaded ? CONFIG_FILE : "(not written yet — first push will create it)"}\n`
    );
    process.stdout.write(
      `gh: ${ghAvailable() ? (ghAuthenticated() ? "authenticated" : "installed, not authenticated") : "not installed"}\n`
    );
    process.stdout.write(
      `DOTCLAUDE_HANDOFF_REPO: ${process.env.DOTCLAUDE_HANDOFF_REPO || "(unset — will bootstrap on first push)"}\n`
    );
    process.exit(r.status !== 0 ? r.status : EXIT_CODES.OK);
  }

  if (first === "remote-list") {
    requireTransportRepoStrict();
    let candidates;
    try {
      candidates = listRemoteCandidates();
    } catch (err) {
      fail(2, `remote-list failed: ${err.message}`);
    }
    const enriched = enrichWithDescriptions(candidates);
    const sinceMs = argv.flags.since
      ? Date.parse(String(argv.flags.since))
      : Date.now() - 30 * 24 * 60 * 60 * 1000;
    if (Number.isNaN(sinceMs)) {
      fail(EXIT_CODES.USAGE, `--since must be ISO-8601, got: ${argv.flags.since}`);
    }
    const filterCli = argv.flags.cli ? String(argv.flags.cli) : null;
    if (filterCli !== null && !CLIS.has(filterCli)) {
      fail(EXIT_CODES.USAGE, `--cli must be one of: ${[...CLIS].join(", ")}`);
    }
    const rows = [];
    for (const c of enriched) {
      const decoded = decodeDescription(c.description);
      if (!decoded) continue;
      if (filterCli && decoded.cli !== filterCli) continue;
      rows.push({
        branch: c.branch,
        cli: decoded.cli,
        short_id: decoded.short_id,
        project: decoded.project,
        hostname: decoded.hostname,
        tag: decoded.tag ?? null,
        commit: c.commit,
      });
    }
    const capped = rows.slice(0, Number.parseInt(limit.toString(), 10));
    if (argv.json) {
      process.stdout.write(JSON.stringify(capped, null, 2) + "\n");
      process.exit(EXIT_CODES.OK);
    }
    if (capped.length === 0) {
      process.stdout.write("No handoffs found\n");
      process.exit(EXIT_CODES.OK);
    }
    process.stdout.write("| Branch                               | CLI     | Short UUID | Project                  | Hostname                 | Tag                      |\n");
    process.stdout.write("| ------------------------------------ | ------- | ---------- | ------------------------ | ------------------------ | ------------------------ |\n");
    for (const r of capped) {
      process.stdout.write(
        `| ${r.branch.padEnd(36)} | ${r.cli.padEnd(7)} | ${r.short_id.padEnd(10)} | ${(r.project ?? "").padEnd(24)} | ${(r.hostname ?? "").padEnd(24)} | ${(r.tag ?? "").padEnd(24)} |\n`
      );
    }
    process.exit(EXIT_CODES.OK);
  }

  if (first === "search") {
    const query = second;
    if (!query) fail(EXIT_CODES.USAGE, "search requires a <query> argument");
    const filterCli = argv.flags.cli ? String(argv.flags.cli) : null;
    if (filterCli !== null && !CLIS.has(filterCli)) {
      fail(EXIT_CODES.USAGE, `--cli must be one of: ${[...CLIS].join(", ")}`);
    }
    const hits = searchSessions({
      query,
      cli: filterCli,
      since: argv.flags.since ? String(argv.flags.since) : null,
      limit: limit.toString(),
    });
    if (argv.json) {
      process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
      process.exit(EXIT_CODES.OK);
    }
    if (hits.length === 0) {
      process.stdout.write(`No sessions matching '${query}'\n`);
      process.exit(EXIT_CODES.OK);
    }
    process.stdout.write("| CLI     | Short UUID | cwd                                   | Last modified       | Match                                    |\n");
    process.stdout.write("| ------- | ---------- | ------------------------------------- | ------------------- | ---------------------------------------- |\n");
    for (const h of hits) {
      const when = new Date(h.mtime).toISOString().replace("T", " ").slice(0, 19);
      process.stdout.write(
        `| ${h.cli.padEnd(7)} | ${h.short_id.padEnd(10)} | ${(h.cwd ?? "").padEnd(37)} | ${when.padEnd(19)} | ${h.snippet.padEnd(40)} |\n`
      );
    }
    process.stdout.write("\nDrill in with `dotclaude handoff describe <cli> <short-uuid>`.\n");
    process.exit(EXIT_CODES.OK);
  }

  // ---- top-level subs: push / pull / list --------------------------------
  if (first === "list") {
    const showLocal = !argv.flags.remote;
    const showRemote = !argv.flags.local;
    const rows = [];
    if (showLocal) {
      for (const r of listAllLocalSessions()) {
        rows.push({ ...r, location: "local" });
      }
    }
    if (showRemote && process.env.DOTCLAUDE_HANDOFF_REPO) {
      try {
        for (const c of listRemoteCandidates()) {
          rows.push({ location: "remote", branch: c.branch, commit: c.commit });
        }
      } catch (err) {
        process.stderr.write(`dotclaude-handoff: list --remote: ${err.message}\n`);
      }
    }
    if (argv.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      process.exit(EXIT_CODES.OK);
    }
    if (rows.length === 0) {
      process.stdout.write("No sessions found\n");
      process.exit(EXIT_CODES.OK);
    }
    process.stdout.write("| Location | CLI / Branch                         | Short UUID | When / Commit    |\n");
    process.stdout.write("| -------- | ------------------------------------ | ---------- | ---------------- |\n");
    for (const r of rows) {
      if (r.location === "local") {
        process.stdout.write(`| local    | ${r.cli.padEnd(36)} | ${r.short_id.padEnd(10)} | ${r.when.padEnd(16)} |\n`);
      } else {
        const shortCommit = (r.commit ?? "").slice(0, 10);
        process.stdout.write(`| remote   | ${r.branch.padEnd(36)} | ${"".padEnd(10)} | ${shortCommit.padEnd(16)} |\n`);
      }
    }
    process.exit(EXIT_CODES.OK);
  }

  // Bare `dotclaude-handoff` (no positionals) is an alias for `push`.
  // Aligns the binary with SKILL.md's "zero-arg = push host's latest
  // session" contract.
  const isPush = first === "push" || argv.positional.length === 0;
  if (isPush) {
    const explicitQuery = first === "push" ? second : null;
    let sessionHit;
    let fallbackNote;
    if (explicitQuery) {
      // Explicit query: only narrow when the user explicitly asked
      // via --from. A detected-host probe must NOT override an
      // explicit query — it would silently mis-route a user who
      // typed `push <codex-alias>` from inside a Claude Code session.
      sessionHit = fromCli
        ? resolveNarrowed(fromCli, explicitQuery)
        : await resolveAny(explicitQuery);
    } else {
      // No query: pick a default session. Prefer --from, then the
      // detected host, then the union resolver. Each fallback emits
      // a one-line stderr note so the user can diff two runs and
      // see why the pick changed.
      const narrowTo = fromCli ?? (detectedHost !== "unknown" ? detectedHost : null);
      if (narrowTo) {
        sessionHit = resolveNarrowed(narrowTo, "latest");
        const shortId = shortIdFromPath(sessionHit.path);
        fallbackNote = fromCli
          ? `using --from ${narrowTo} override, latest session: ${shortId}`
          : `no current-session signal in ${narrowTo}, using latest ${narrowTo} session: ${shortId}`;
      } else {
        sessionHit = await resolveAny("latest");
        const shortId = shortIdFromPath(sessionHit.path);
        fallbackNote = `host not detected, using latest across all clis: ${shortId}`;
      }
    }
    if (fallbackNote) process.stderr.write(fallbackNote + "\n");

    const tag = argv.flags.tag ? String(argv.flags.tag) : null;
    try {
      const result = await pushRemote({ cli: sessionHit.cli, path: sessionHit.path, tag });
      process.stdout.write(
        `${result.branch}\n${result.url}\n${result.description}\n[scrubbed ${result.scrubbedCount} secrets]\n`,
      );
      process.exit(EXIT_CODES.OK);
    } catch (err) {
      fail(2, `push failed: ${err.message}`);
    }
  }

  if (first === "pull") {
    try {
      const hit = await pullRemote(second, fromCli);
      const { content } = fetchRemoteBranch(hit.branch);
      process.stdout.write(content.endsWith("\n") ? content : content + "\n");
      process.exit(EXIT_CODES.OK);
    } catch (err) {
      fail(2, `pull failed: ${err.message}`);
    }
  }

  // ---- power-user sub-commands (resolve/describe/digest/file) -----------
  if (POWER_SUBS.has(first)) {
    const sub = first;
    const cli = second;
    const id = third;
    if (!cli) fail(EXIT_CODES.USAGE, `${sub} requires <cli>`);
    if (!CLIS.has(cli)) fail(EXIT_CODES.USAGE, `cli must be one of: ${[...CLIS].join(", ")}`);
    if (!id) fail(EXIT_CODES.USAGE, `${sub} requires an identifier after <cli>`);
    const { path } = resolveNarrowed(cli, id);
    if (sub === "resolve") {
      process.stdout.write(`${path}\n`);
      process.exit(EXIT_CODES.OK);
    }
    const meta = extractMeta(cli, path);
    const prompts = extractPrompts(cli, path);
    if (sub === "describe") {
      if (argv.json) {
        process.stdout.write(JSON.stringify({ origin: meta, user_prompts: prompts }, null, 2) + "\n");
        process.exit(EXIT_CODES.OK);
      }
      process.stdout.write(renderDescribeMarkdown(meta, prompts) + "\n");
      process.exit(EXIT_CODES.OK);
    }
    const turns = extractTurns(cli, path, limit);
    if (sub === "digest") {
      process.stdout.write(renderHandoffBlock(meta, prompts, turns, toCli) + "\n");
      process.exit(EXIT_CODES.OK);
    }
    if (sub === "file") {
      const outDir = argv.flags["out-dir"];
      let target;
      if (outDir) {
        target = resolvePath(outDir.toString());
      } else {
        const gitRes = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
        target =
          gitRes.status === 0 && gitRes.stdout.trim()
            ? join(gitRes.stdout.trim(), "docs", "handoffs")
            : join(process.env.HOME ?? "", ".claude", "handoffs");
      }
      mkdirSync(target, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const shortId = meta.short_id ?? "unknown";
      const outPath = join(target, `${today}-${meta.cli}-${shortId}.md`);
      const body = [
        `# Handoff: ${meta.cli} → ${toCli}`,
        "",
        `_Generated: ${new Date().toISOString()}_`,
        `_Origin session: \`${meta.session_id ?? "?"}\` (cwd: \`${meta.cwd ?? "?"}\`)_`,
        "",
        renderHandoffBlock(meta, prompts, turns, toCli),
        "",
        "---",
        "",
        "## Full user prompt log",
        "",
        ...prompts.map((p, i) => `${i + 1}. ${p}`),
        "",
        "## Notes",
        "",
        `- Source transcript: \`${path}\``,
        `- Prompts: ${prompts.length} (verbatim); assistant turns summarized in the <handoff> block.`,
      ].join("\n");
      writeFileSync(outPath, body + "\n");
      process.stdout.write(`${outPath}\n`);
      process.exit(EXIT_CODES.OK);
    }
  }

  // ---- bare <query>: local cross-agent (implicit digest) -----------------
  const query = first;
  const hit = await resolveAny(query);
  const meta = extractMeta(hit.cli, hit.path);
  const prompts = extractPrompts(hit.cli, hit.path);
  const turns = extractTurns(hit.cli, hit.path, limit);
  process.stdout.write(renderHandoffBlock(meta, prompts, turns, toCli) + "\n");
  process.exit(EXIT_CODES.OK);
}

// Only execute the CLI when invoked directly; stay import-safe for unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => fail(2, err.message));
}

export {
  cliFromPath,
  collectSessionFiles,
  decodeDescription,
  detectHost,
  encodeDescription,
  mechanicalSummary,
  matchesQuery,
  monthBucket,
  nextStepFor,
  projectSlugFromCwd,
  requireTransportRepo,
  requireTransportRepoStrict,
  validateTransportUrl,
  searchSessions,
  slugify,
  truncate,
  v2BranchName,
  loadPersistedEnv,
  bootstrapTransportRepo,
  isRepoMissingError,
  CLI_LAYOUTS,
  UUID_HEAD_RE,
  V1_BRANCH_RE,
  V2_BRANCH_RE,
  CONFIG_FILE,
};
