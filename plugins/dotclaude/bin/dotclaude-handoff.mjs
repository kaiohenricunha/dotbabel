#!/usr/bin/env node
/**
 * dotclaude-handoff — five-form cross-agent / cross-machine handoff.
 *
 * Usage:
 *   dotclaude handoff                              push host's latest session
 *   dotclaude handoff <query>                      local cross-agent: emit <handoff> block
 *   dotclaude handoff push [<query>] [--tag <label>] [--via <transport>]
 *   dotclaude handoff pull [<query>] [--via <transport>]
 *   dotclaude handoff list [--local|--remote] [--via <transport>]
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
const TRANSPORTS = new Set(["git-fallback", "github"]);

const META = {
  name: "dotclaude-handoff",
  synopsis:
    "dotclaude handoff [<query>|push|pull|list] [<query>] [--from <cli>] [--to <cli>] [--tag <label>] [--via <transport>]",
  description:
    "Cross-agent and cross-machine session handoff. Bare <query> emits a <handoff> block for local cross-agent. push/pull/list handle the remote transport.",
  flags: {
    tag: { type: "string" },
    via: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    limit: { type: "string" },
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

// ---- transport: git-fallback -------------------------------------------

function requireTransportRepo() {
  const url = process.env.DOTCLAUDE_HANDOFF_REPO;
  if (!url) fail(2, "DOTCLAUDE_HANDOFF_REPO env var must be set for --via git-fallback");
  // Reject ext:: and other exec-triggering Git URL schemes (CVE-2017-1000117-class).
  // Allow: https://, http://, git@, ssh://, file://, and absolute paths (bare repos).
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(url))
    fail(2, `DOTCLAUDE_HANDOFF_REPO must be an https://, git@, ssh://, file://, or absolute path (got: ${url})`);
  return url;
}

function encodeDescription({ cli, shortId, project, host, tag }) {
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
  ];
  if (tag) args.push("--tag", tag);
  const r = runScript(DESCRIPTION_SH, args);
  if (r.status !== 0) fail(2, `description encode failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function projectSlugFromCwd(cwd) {
  if (!cwd) return "adhoc";
  const last = cwd.split("/").filter(Boolean).pop() || "adhoc";
  return last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || "adhoc";
}

function pushGitFallback({ cli, path: sessionFile, tag }) {
  const repoUrl = requireTransportRepo();
  const meta = extractMeta(cli, sessionFile);
  const prompts = extractPrompts(cli, sessionFile);
  const turns = extractTurns(cli, sessionFile);
  const toCli = meta.cli;
  const handoffBlock = renderHandoffBlock(meta, prompts, turns, toCli);

  const shortId = meta.short_id ?? "unknown";
  const host = hostname().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  const project = projectSlugFromCwd(meta.cwd);
  const description = encodeDescription({
    cli: meta.cli,
    shortId,
    project,
    host,
    tag: tag || null,
  });

  const metadata = {
    cli: meta.cli,
    session_id: meta.session_id,
    short_id: shortId,
    cwd: meta.cwd ?? null,
    hostname: host,
    created_at: new Date().toISOString(),
    scrubbed_count: 0,
    schema_version: "1",
    tag: tag || null,
  };

  const tmp = mkdtempSync(join(tmpdir(), "handoff-push-"));
  try {
    runGitOrThrow(["init", "-q"], tmp);
    runGitOrThrow(["remote", "add", "origin", repoUrl], tmp);
    runGitOrThrow(["config", "user.email", "handoff@dotclaude.local"], tmp);
    runGitOrThrow(["config", "user.name", "dotclaude-handoff"], tmp);
    const branch = `handoff/${meta.cli}/${shortId}`;
    runGitOrThrow(["checkout", "-q", "-b", branch], tmp);
    writeFileSync(join(tmp, "handoff.md"), handoffBlock + "\n");
    writeFileSync(join(tmp, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
    writeFileSync(join(tmp, "description.txt"), description + "\n");
    runGitOrThrow(["add", "."], tmp);
    runGitOrThrow(["commit", "-q", "-m", description], tmp);
    runGitOrThrow(["push", "-q", "-f", "origin", branch], tmp);
    return { branch, url: repoUrl, description };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * List remote handoffs from git-fallback as candidate objects.
 * Returns [{branch, description, commit}] — no content fetched.
 */
function listGitFallbackCandidates() {
  const repoUrl = requireTransportRepo();
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
function fetchGitFallbackBranch(branch) {
  const repoUrl = requireTransportRepo();
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
      const { description } = fetchGitFallbackBranch(c.branch);
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

async function pullGitFallback(query, fromCli = null) {
  let candidates = listGitFallbackCandidates();
  if (candidates.length === 0) fail(2, "no handoffs found on transport");

  // `--from <cli>` narrows the candidate set to one source-CLI. Branch
  // names are shaped `handoff/<cli>/<short-uuid>`, so the prefix match
  // is exact. Applied BEFORE any query match so short-UUID collisions
  // across CLIs can be resolved with --from.
  if (fromCli) {
    candidates = candidates.filter((c) => c.branch.startsWith(`handoff/${fromCli}/`));
    if (candidates.length === 0) fail(2, `no ${fromCli} handoffs found on transport`);
  }

  // Bare: pick the newest (for git-fallback we don't have a reliable remote
  // mtime; fall back to the lexically last branch, which is typically the
  // most recent since short IDs hash-distribute). The caller re-fetches
  // the branch contents via fetchGitFallbackBranch, so skipping the
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

// ---- main --------------------------------------------------------------

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

const via = (argv.flags.via ?? "github").toString();
if (!TRANSPORTS.has(via)) fail(EXIT_CODES.USAGE, `--via must be one of: ${[...TRANSPORTS].join(", ")}`);

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

function requireGitFallbackTransport(transport) {
  if (transport === "git-fallback") return;
  fail(
    EXIT_CODES.USAGE,
    `transport '${transport}' not yet implemented in the binary; use --via git-fallback (or invoke the /handoff skill inside Claude/Copilot for --via github)`
  );
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
    if (showRemote && via === "git-fallback" && process.env.DOTCLAUDE_HANDOFF_REPO) {
      try {
        for (const c of listGitFallbackCandidates()) {
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

    requireGitFallbackTransport(via);
    const tag = argv.flags.tag ? String(argv.flags.tag) : null;
    try {
      const result = pushGitFallback({ cli: sessionHit.cli, path: sessionHit.path, tag });
      process.stdout.write(`${result.branch}\n${result.url}\n${result.description}\n`);
      process.exit(EXIT_CODES.OK);
    } catch (err) {
      fail(2, `push failed: ${err.message}`);
    }
  }

  if (first === "pull") {
    requireGitFallbackTransport(via);
    try {
      const hit = await pullGitFallback(second, fromCli);
      const { content } = fetchGitFallbackBranch(hit.branch);
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
  detectHost,
  encodeDescription,
  mechanicalSummary,
  matchesQuery,
  nextStepFor,
  projectSlugFromCwd,
  requireTransportRepo,
  CLI_LAYOUTS,
  UUID_HEAD_RE,
};
