#!/usr/bin/env node
/**
 * dotclaude-handoff — five-form cross-agent / cross-machine handoff.
 *
 * Usage:
 *   dotclaude handoff                              print usage and exit 0 (#86)
 *   dotclaude handoff <query>                      local cross-agent: emit <handoff> block
 *   dotclaude handoff push [<query>] [--tag <label>]
 *   dotclaude handoff pull [<query>]
 *   dotclaude handoff list [--local|--remote] [--from <cli>] [--since <ISO>] [--limit <N>|--all]
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
import { version } from "../src/index.mjs";
import {
  // subprocess primitives
  runScript,
  // extraction
  extractMeta,
  extractPrompts,
  extractTurns,
  // rendering
  renderHandoffBlock,
  mechanicalSummary,
  nextStepFor,
  // URL / path
  validateTransportUrl,
  isRepoMissingError,
  slugify,
  projectSlugFromCwd,
  monthBucket,
  v2BranchName,
  // metadata
  encodeDescription,
  decodeDescription,
  // bootstrap
  loadPersistedEnv,
  ghAvailable,
  ghAuthenticated,
  bootstrapTransportRepo,
  requireTransportRepo,
  requireTransportRepoStrict,
  // remote I/O
  pushRemote,
  pullRemote,
  fetchRemoteBranch,
  listRemoteCandidates,
  enrichWithDescriptions,
  matchesQuery,
  // constants
  CONFIG_FILE,
  V1_BRANCH_RE,
  V2_BRANCH_RE,
  parseHandoffBranch,
} from "../src/lib/handoff-remote.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

const POWER_SUBS = new Set(["resolve", "describe", "digest", "file"]);
const CLIS = new Set(["claude", "copilot", "codex"]);

const META = {
  name: "dotclaude-handoff",
  synopsis:
    "dotclaude handoff [<query>|push|pull|list|doctor|remote-list|search] [args...] [--from <cli>] [--to <cli>] [--tag <label>] [--cli <cli>] [--since <ISO>] [--limit <N>] [--verify]",
  description:
    "Cross-agent and cross-machine session handoff. Bare <query> emits a <handoff> block for local cross-agent. push/pull/list handle the remote transport (a user-owned private git repo named by DOTCLAUDE_HANDOFF_REPO). push/pull auto-run a preflight check (cached 5 min); --verify forces re-run.",
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
    verify: { type: "boolean" },
    "force-collision": { type: "boolean" },
    all: { type: "boolean" },
  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolvePath(__dirname, "..", "scripts");
const RESOLVE_SH = join(SCRIPTS, "handoff-resolve.sh");
const DOCTOR_SH = join(SCRIPTS, "handoff-doctor.sh");

// Local fail — mirrors the library's internal helper so bin-side usage
// doesn't depend on the library exporting it. Kept trivial on purpose.
function fail(code, msg) {
  if (msg) process.stderr.write(`dotclaude-handoff: ${msg}\n`);
  process.exit(code);
}

// --since <ISO> → epoch ms, or the default-N-days fallback when raw is
// absent. Pass `defaultDays: null` for "no filter" (used by `list`).
// Exits USAGE on non-ISO input.
function parseSinceOrFail(raw, { defaultDays = null } = {}) {
  if (!raw) {
    return defaultDays === null
      ? null
      : Date.now() - defaultDays * 24 * 60 * 60 * 1000;
  }
  const ms = Date.parse(String(raw));
  if (Number.isNaN(ms)) fail(EXIT_CODES.USAGE, `--since must be ISO-8601, got: ${raw}`);
  return ms;
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

// ---- describe renderer (bin-only) --------------------------------------

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

// ---- search (bin-only) -------------------------------------------------

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
  const sinceMs = parseSinceOrFail(since, { defaultDays: 30 });
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

// Centralizes the "latest" precedence (--from > detectedHost > union)
// so push and bare <query> can't drift. Returns {hit, note}; note is
// always populated because every branch emits a stderr diff-aid.
async function resolveLatestWithHostScope({ fromCli, detectedHost }) {
  const narrowTo = fromCli ?? (detectedHost !== "unknown" ? detectedHost : null);
  if (narrowTo) {
    const hit = resolveNarrowed(narrowTo, "latest");
    const shortId = shortIdFromPath(hit.path);
    const prefix = fromCli ? `using --from ${narrowTo} override, ` : "";
    return { hit, note: `${prefix}latest ${narrowTo} session: ${shortId}` };
  }
  const hit = await resolveAny("latest");
  const shortId = shortIdFromPath(hit.path);
  return { hit, note: `host not detected, using latest across all clis: ${shortId}` };
}

async function main() {
  if (argv.positional.length === 0) {
    process.stdout.write(helpText(META) + "\n");
    process.exit(EXIT_CODES.OK);
  }

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
    const sinceMs = parseSinceOrFail(argv.flags.since, { defaultDays: 30 });
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
    const sinceMs = parseSinceOrFail(argv.flags.since);
    const listCap = argv.flags.all ? Infinity : Number(limit);
    const showLocal = !argv.flags.remote;
    const showRemote = !argv.flags.local;
    const rows = [];

    if (showLocal) {
      for (const r of listAllLocalSessions()) {
        if (fromCli && r.cli !== fromCli) continue;
        if (sinceMs !== null && r.mtime * 1000 < sinceMs) continue;
        rows.push({ ...r, location: "local" });
      }
    }

    let remoteSkipped = false;
    if (showRemote) {
      if (!process.env.DOTCLAUDE_HANDOFF_REPO) {
        remoteSkipped = true;
        process.stderr.write(
          "dotclaude-handoff: list --remote: DOTCLAUDE_HANDOFF_REPO not set; skipping remote enumeration\n",
        );
      } else {
        try {
          for (const c of listRemoteCandidates()) {
            const parsed = parseHandoffBranch(c.branch);
            if (fromCli && parsed.cli !== fromCli) continue;
            rows.push({
              location: "remote",
              cli: parsed.cli,
              short_id: parsed.shortId,
              branch: c.branch,
              commit: c.commit,
              when: parsed.yearMonth,
            });
          }
        } catch (err) {
          process.stderr.write(`dotclaude-handoff: list --remote: ${err.message}\n`);
        }
      }
    }

    rows.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    const capped = Number.isFinite(listCap) ? rows.slice(0, listCap) : rows;

    if (argv.json) {
      process.stdout.write(JSON.stringify(capped, null, 2) + "\n");
      process.exit(EXIT_CODES.OK);
    }
    if (capped.length === 0) {
      // --remote + no transport env + no local rows = hard failure so
      // piped callers don't silently treat an empty list as success.
      if (argv.flags.remote && !argv.flags.local && remoteSkipped) process.exit(2);
      process.stdout.write("No sessions found\n");
      process.exit(EXIT_CODES.OK);
    }
    process.stdout.write("| Location | CLI     | Short UUID | When             |\n");
    process.stdout.write("| -------- | ------- | ---------- | ---------------- |\n");
    for (const r of capped) {
      process.stdout.write(
        `| ${r.location.padEnd(8)} | ${(r.cli ?? "").padEnd(7)} | ${(r.short_id ?? "").padEnd(10)} | ${(r.when ?? "").padEnd(16)} |\n`,
      );
    }
    process.exit(EXIT_CODES.OK);
  }

  if (first === "push") {
    const explicitQuery = second ?? null;
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
      ({ hit: sessionHit, note: fallbackNote } = await resolveLatestWithHostScope({
        fromCli,
        detectedHost,
      }));
    }
    if (fallbackNote) process.stderr.write(fallbackNote + "\n");

    const tag = argv.flags.tag ? String(argv.flags.tag) : null;
    const verify = Boolean(argv.flags.verify);
    const verbose = Boolean(argv.verbose);
    const force = Boolean(argv.flags["force-collision"]);
    try {
      const result = await pushRemote({
        cli: sessionHit.cli,
        path: sessionHit.path,
        tag,
        verify,
        verbose,
        force,
      });
      process.stdout.write(
        `${result.branch}\n${result.url}\n${result.description}\n[scrubbed ${result.scrubbedCount} secrets]\n`,
      );
      process.exit(EXIT_CODES.OK);
    } catch (err) {
      fail(2, `push failed: ${err.message}`);
    }
  }

  if (first === "pull") {
    const verify = Boolean(argv.flags.verify);
    const verbose = Boolean(argv.verbose);
    try {
      const hit = await pullRemote(second, fromCli, { verify, verbose });
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
  // `latest` is host-scoped (explicit UUIDs/aliases pass through — narrowing
  // them could hide a legitimate cross-agent match).
  const query = first;
  let hit, fallbackNote;
  if (query === "latest") {
    ({ hit, note: fallbackNote } = await resolveLatestWithHostScope({ fromCli, detectedHost }));
  } else {
    hit = await resolveAny(query);
  }
  if (fallbackNote) process.stderr.write(fallbackNote + "\n");
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
