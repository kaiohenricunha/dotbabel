#!/usr/bin/env node
/**
 * dotclaude-handoff — five-verb cross-agent / cross-machine handoff (#87).
 *
 * Usage:
 *   dotclaude handoff                              print usage and exit 0 (#86)
 *   dotclaude handoff pull <query> [--summary] [-o <path|auto|->] [--from <cli>]
 *                                                  render a local session: <handoff> block (default),
 *                                                  --summary for inline markdown, -o to write to disk.
 *   dotclaude handoff fetch [<query>] [--from <cli>] [--verify]
 *                                                  fetch a remote handoff branch from DOTCLAUDE_HANDOFF_REPO.
 *   dotclaude handoff push [<query>] [--tag <label>] [--from <cli>]
 *                                                  commit a local session as a handoff branch to the transport repo.
 *   dotclaude handoff list [--local|--remote] [--from <cli>] [--since <ISO>] [--limit <N>|--all]
 *   dotclaude handoff search <query> [--from <cli>] [--since <ISO>] [--limit <N>] [--fixed] [--json]
 *   dotclaude handoff prune --older-than <30d|6m|1y|YYYY-MM-DD> [--yes] [--dry-run]
 *   dotclaude handoff doctor
 *
 * `<id>` / `<query>` resolves across all three CLIs (claude, copilot, codex):
 * full UUID, short UUID (first 8 hex), `latest`, or a named alias
 * (Claude customTitle/aiTitle, Codex thread_name, Copilot workspace.yaml:name).
 * Aliases use case-insensitive exact match. `latest` is host-scoped (#85).
 * Resolution precedence: UUID > short-UUID > latest > alias (no fall-through).
 *
 * Exits: 0 ok, 2 not-found / runtime error, 64 usage error.
 */

import {
  HandoffError,
  PreflightHandledError,
  classifyGitError,
  formatHandoffError,
} from "../src/lib/handoff-errors.mjs";
import { parse, helpText } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { autoPreflight } from "../src/lib/handoff-preflight.mjs";
import { version, escapeRegex } from "../src/index.mjs";
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
  // tags first-class (#91 Gap 7) — for list --tag filter and --tags histogram
  parseTagsFromDescription,
  // prune (#91 Gap 5)
  parseDuration,
  listPruneCandidates,
  deleteRemoteBranches,
  PRUNE_SKIP_BUCKETS,
  // io helpers shared with bootstrap/push paths — exported for downstream
  // bin-callers that need the same TTY/prompt semantics
  isTty,
  promptLine,
  // error class (re-exported for tests)
  HandoffError as _HandoffError,
  // constants
  CONFIG_FILE,
  V1_BRANCH_RE,
  V2_BRANCH_RE,
  parseHandoffBranch,
} from "../src/lib/handoff-remote.mjs";
export { _HandoffError as HandoffError };
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const CLIS = new Set(["claude", "copilot", "codex"]);

const META = {
  name: "dotclaude-handoff",
  synopsis:
    "dotclaude handoff [pull|fetch|list|search|push|prune|doctor] [args...] [--from <cli>] [--summary] [-o <path>] [--tag <label>...] [--tags] [--since <ISO>] [--limit <N>] [--verify] [--dry-run] [--older-than <30d|6m|1y|YYYY-MM-DD>] [--yes]",
  description:
    "Cross-agent and cross-machine session handoff. `pull <id>` renders a local session as <handoff> block (or --summary / -o <path>). push/fetch handle the remote transport (a user-owned private git repo named by DOTCLAUDE_HANDOFF_REPO). push/fetch auto-run a preflight check (cached 5 min); --verify forces re-run.\n\nFor push without a query, --from <cli> is required. Omitting --from exits 64 with a usage hint.\n\nA `<query>` resolves by full UUID, short UUID (first 8 hex), `latest`, or a deliberate-label alias: claude `customTitle`/`aiTitle`, codex `thread_name`, or copilot `workspace.yaml:name`. Aliases match case-insensitively. Resolution precedence: UUID > short-UUID > `latest` > alias (no fall-through on miss).",
  flags: {
    // #91 Gap 7: tag is multi-valued for push (--tag foo --tag bar) and a
    // single-value filter on `list --remote --tag <name>`. argv.mjs always
    // hands back an array when multiple is true.
    tag: { type: "string", multiple: true },
    // Boolean flag for `list --remote --tags` histogram mode.
    tags: { type: "boolean" },
    from: { type: "string" },
    limit: { type: "string" },
    since: { type: "string" },
    output: { type: "string", short: "o" },
    local: { type: "boolean" },
    remote: { type: "boolean" },
    verify: { type: "boolean" },
    "force-collision": { type: "boolean" },
    all: { type: "boolean" },
    fixed: { type: "boolean", short: "F" },
    summary: { type: "boolean" },
    "dry-run": { type: "boolean" },
    "older-than": { type: "string" },
    yes: { type: "boolean" },
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
    return defaultDays === null ? null : Date.now() - defaultDays * 24 * 60 * 60 * 1000;
  }
  const ms = Date.parse(String(raw));
  if (Number.isNaN(ms)) fail(EXIT_CODES.USAGE, `--since must be ISO-8601, got: ${raw}`);
  return ms;
}

// ---- resolver / extractor bridge ---------------------------------------

/**
 * Strip the resolver-script's `handoff-resolve:` prefix from captured stderr
 * so the binary's own `dotclaude-handoff:` prefix doesn't double up (#135).
 * Returns the trimmed remainder.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripResolverPrefix(raw) {
  return raw.trim().replace(/^handoff-resolve:\s*/, "");
}

/**
 * Parse a 5-column TSV candidate list from a captured `handoff-resolve.sh` stderr
 * (collision case) and dispatch to TTY prompt or non-TTY stderr passthrough per
 * ARCH-3. Used by `resolveAny`, `resolveNarrowed`, and `resolveLocalForPull` —
 * single source of truth for the §5.3.5 5-column contract.
 *
 * Each candidate row has 5 tab-separated fields per §5.3.5:
 *   <cli> <short-id> <absolute-path> <matched-value> <matched-field>
 *
 * Edge case: if stderr contains the "multiple sessions match" header but no
 * lines parse as 5-tab-field rows (corrupted resolver output), fall through
 * to the non-TTY passthrough path — better to surface the raw stderr than to
 * prompt with an empty candidate list.
 *
 * @param {string} stderr  captured stderr from the resolver
 * @param {string} query   original user query (for the TTY prompt header)
 * @returns {Promise<{cli: string, path: string}>}  resolved on TTY pick
 */
async function parseCollisionAndDispatch(stderr, query) {
  const candidates = [];
  for (const line of stderr.split("\n")) {
    const parts = line.split("\t");
    if (parts.length === 5) {
      candidates.push({
        cli: parts[0],
        shortId: parts[1],
        path: parts[2],
        matchedValue: parts[3],
        matchedField: parts[4],
      });
    }
  }
  if (process.stdin.isTTY && candidates.length > 0) {
    return await promptCollisionChoice(query, candidates);
  }
  // Non-TTY OR corrupted stderr (header without parseable rows):
  // surface the raw resolver stderr verbatim and exit 2.
  process.stderr.write(stderr);
  process.exit(2);
}

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
  // collision (intra-CLI alias collision passed through, OR cross-CLI union of
  // alias hits). Otherwise it's "no session matches" or an env error.
  const stderr = r.stderr;
  if (!stderr.includes("multiple sessions match")) {
    fail(
      r.status === 64 ? EXIT_CODES.USAGE : 2,
      stripResolverPrefix(stderr) || `no session matches: ${query}`,
    );
  }
  return await parseCollisionAndDispatch(stderr, query);
}

/**
 * Resolve `<id>` against a single CLI's root. Thin wrapper over the per-CLI
 * entry point of handoff-resolve.sh. Collisions can occur on alias scans
 * (claude customTitle/aiTitle, codex thread_name, copilot name) when multiple
 * sessions share the same alias value within one CLI's root — handled via
 * parseCollisionAndDispatch (TTY prompt or non-TTY stderr passthrough).
 *
 * @param {string} cli    one of CLIS
 * @param {string} id     uuid | short-uuid | "latest" | alias
 * @returns {Promise<{cli: string, path: string}>}
 */
async function resolveNarrowed(cli, id) {
  const r = runScript(RESOLVE_SH, [cli, id]);
  if (r.status === 0) {
    return { cli, path: r.stdout.trim() };
  }
  // status != 0. Same dispatch as resolveAny: collision if "multiple sessions
  // match" prefix; otherwise a "not found"/env error.
  const stderr = r.stderr;
  if (stderr.includes("multiple sessions match")) {
    return await parseCollisionAndDispatch(stderr, id);
  }
  fail(
    r.status === 64 ? EXIT_CODES.USAGE : 2,
    stripResolverPrefix(stderr) || `no ${cli} session matches: ${id}`,
  );
}

/**
 * Local resolver variant for the `pull` verb. Mirrors resolveAny /
 * resolveNarrowed but intercepts the no-match path so the binary can append a
 * single stderr hint (`for remote handoffs use fetch <id>`) when a remote
 * transport is configured — without auto-forwarding. Collisions are dispatched
 * via parseCollisionAndDispatch in both narrowTo-given (per-CLI alias) and
 * null (cross-CLI union / per-CLI passed through resolve_any) paths.
 *
 * @param {string} id
 * @param {string|null} narrowTo   one of CLIS, or null for union lookup.
 * @returns {Promise<{cli: string, path: string}>}
 */
async function resolveLocalForPull(id, narrowTo) {
  const args = narrowTo ? [narrowTo, id] : ["any", id];
  const r = runScript(RESOLVE_SH, args);
  if (r.status === 0) {
    const path = r.stdout.trim();
    const cli = narrowTo ?? cliFromPath(path);
    return { cli, path };
  }
  const stderr = r.stderr;
  if (stderr.includes("multiple sessions match")) {
    // Collision in either narrowTo-given (per-CLI alias collision) or null
    // (cross-CLI union or per-CLI alias collision aggregated by resolve_any).
    return await parseCollisionAndDispatch(stderr, id);
  }
  // No-match path: emit "not found" with optional remote-handoff hint.
  const msg =
    stripResolverPrefix(stderr) ||
    (narrowTo ? `no ${narrowTo} session matches: ${id}` : `no session matches: ${id}`);
  process.stderr.write(`dotclaude-handoff: ${msg}\n`);
  if (process.env.DOTCLAUDE_HANDOFF_REPO) {
    process.stderr.write("for remote handoffs use `fetch <id>`\n");
  }
  process.exit(r.status === 64 ? EXIT_CODES.USAGE : 2);
}

/**
 * Render the collision candidate menu and prompt the user to pick one.
 * Each candidate is rendered on a single line with the (cli/matched-field)
 * disambiguation tag, the matched value (case as stored by the resolver,
 * soft-truncated at 80 chars for pathological lengths), and the short-id in
 * brackets for traceability. The path is omitted from the rendered line —
 * users pick by N, and short-id provides the unique identifier.
 *
 * @param {string} query  the original user query (header line)
 * @param {Array<{cli: string, shortId: string, path: string, matchedValue: string, matchedField: string}>} candidates
 * @returns {Promise<{cli: string, path: string}>}
 */
async function promptCollisionChoice(query, candidates) {
  process.stderr.write(`dotclaude-handoff: multiple sessions match "${query}":\n`);
  candidates.forEach((c, i) => {
    const tag = `(${c.cli}/${c.matchedField})`;
    const displayValue =
      c.matchedValue.length > 80 ? c.matchedValue.slice(0, 77) + "..." : c.matchedValue;
    process.stderr.write(
      `  [${i + 1}] ${tag.padEnd(22)} ${displayValue.padEnd(50)} [${c.shortId}]\n`,
    );
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

// ---- describe / digest renderers (bin-only) ---------------------------

/**
 * Structured equivalent of `renderHandoffBlock`. The block caps prompts/turns
 * for readability; the JSON returns full arrays so downstream tooling can
 * apply its own trimming. Fields mirror the issue #87 contract:
 *   {origin, user_prompts, assistant_turns, next_step_suggestion, to}
 */
function buildDigestJson(meta, prompts, turns, toCli) {
  return {
    origin: meta,
    user_prompts: prompts,
    assistant_turns: turns,
    next_step_suggestion: nextStepFor(toCli),
    to: toCli,
  };
}

/**
 * Route a rendered body to stdout, an auto-placed markdown file, or a
 * caller-specified path. Shared between `pull` (digest) and
 * `pull --summary` so both forms honor `-o <path|auto|->` identically.
 *
 * - `out === undefined` or `out === "-"` → stdout, caller provides trailing `\n`.
 * - `out === "auto"` → write a disk envelope to
 *   `<git-root>/docs/handoffs/<YYYY-MM-DD>-<cli>-<short>.md` (falls back to
 *   `$HOME/.claude/handoffs/` off-repo). `kind` switches the heading.
 * - any other string → absolute/relative path; body written verbatim.
 */
function writeOutput(body, out, meta, { kind, prompts, sourcePath, toCli }) {
  if (out === undefined || out === "-") {
    process.stdout.write(body.endsWith("\n") ? body : body + "\n");
    return;
  }
  if (out === "auto") {
    const gitRes = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    const target =
      gitRes.status === 0 && gitRes.stdout.trim()
        ? join(gitRes.stdout.trim(), "docs", "handoffs")
        : join(process.env.HOME ?? "", ".claude", "handoffs");
    mkdirSync(target, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const shortId = meta.short_id ?? "unknown";
    const outPath = join(target, `${today}-${meta.cli}-${shortId}.md`);
    const heading = kind === "summary" ? "Handoff summary" : "Handoff";
    const arrow = toCli ? ` → ${toCli}` : "";
    const envelope = [
      `# ${heading}: ${meta.cli}${arrow}`,
      "",
      `_Generated: ${new Date().toISOString()}_`,
      `_Origin session: \`${meta.session_id ?? "?"}\` (cwd: \`${meta.cwd ?? "?"}\`)_`,
      "",
      body,
      "",
      "---",
      "",
      "## Full user prompt log",
      "",
      ...(prompts ?? []).map((p, i) => `${i + 1}. ${p}`),
      "",
      "## Notes",
      "",
      `- Source transcript: \`${sourcePath ?? "?"}\``,
      `- Prompts: ${(prompts ?? []).length} (verbatim); assistant turns summarized above.`,
    ].join("\n");
    writeFileSync(outPath, envelope + "\n");
    process.stderr.write(`${outPath}\n`);
    return;
  }
  const outPath = resolvePath(out.toString());
  writeFileSync(outPath, body.endsWith("\n") ? body : body + "\n");
  process.stderr.write(`${outPath}\n`);
}

function renderDescribeMarkdown(meta, prompts) {
  const lines = [];
  lines.push(
    `**${meta.cli}** \`${meta.short_id ?? "?"}\` — \`${meta.cwd ?? "(cwd unknown)"}\` — ${meta.started_at ?? ""}`,
  );
  lines.push("");
  lines.push("**User prompts:**");
  lines.push("");
  const toShow = prompts.slice(0, 10);
  if (toShow.length === 0) lines.push("- (session contained no user prompts)");
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
  return [
    ...listLocalSessions("claude"),
    ...listLocalSessions("copilot"),
    ...listLocalSessions("codex"),
  ].sort((a, b) => b.mtime - a.mtime);
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
 * Two-pass search: fast raw-regex pass over JSONL to narrow candidates,
 * then a clean pass over extractPrompts + extractTurns output (tool-use
 * and env-context noise already stripped by handoff-extract.sh) to
 * confirm the hit. `fixed` escapes regex metachars for literal queries.
 *
 * Returns a newest-first array of {cli, short_id, session_id, path,
 * cwd, mtime, match_snippet} objects capped at `limit`. The binary
 * caller handles table rendering vs `--json` serialization.
 */
function searchSessions({ query, cli, since, limit, fixed }) {
  const re = new RegExp(fixed ? escapeRegex(query) : query, "i");
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
      const promptHit = extractPrompts(c, file).find((p) => re.test(p));
      const turnHit = promptHit ? null : extractTurns(c, file, 0).find((t) => re.test(t));
      if (!promptHit && !turnHit) continue;
      const snippet = promptHit
        ? truncate(`user: ${promptHit}`, 80)
        : truncate(`assistant: ${turnHit}`, 80);
      const meta = extractMeta(c, file);
      const m = file.match(UUID_HEAD_RE);
      out.push({
        cli: c,
        short_id: m ? m[1] : "?",
        session_id: meta.session_id ?? null,
        path: file,
        cwd: meta.cwd ?? null,
        mtime: stat.mtimeMs,
        match_snippet: snippet,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, Number.parseInt(limit ?? "20", 10));
}

// ---- helpers -----------------------------------------------------------

function emitRemoteError(err, verb, context) {
  if (err instanceof PreflightHandledError) return;
  const structured =
    err instanceof HandoffError ? err : classifyGitError(err.message, verb, context);
  process.stderr.write(formatHandoffError(structured, verb));
}

function renderDryRunPreview(r) {
  const m = r.metadata;
  return [
    "DRY-RUN (no network calls):",
    `  branch:        ${r.branch}`,
    `  transport:     ${r.url}`,
    `  description:   ${r.description}`,
    `  digest size:   ${r.digestBytes} bytes (after scrub)`,
    `  scrub count:   ${r.scrubbedCount} secrets redacted`,
    `  tags:          ${r.tags?.length > 0 ? r.tags.join(", ") : "(none)"}`,
    `  metadata:      cli=${m.cli} session=${m.short_id} project=${m.project} host=${m.hostname} month=${m.month}`,
    "",
    "run without --dry-run to push.",
    "",
  ].join("\n");
}

function renderPrunePreview({ candidates, skipped, total }, { dryRun }) {
  const lines = [
    `dotclaude-handoff prune: ${candidates.length} of ${total} branch(es) eligible for delete`,
  ];
  const B = PRUNE_SKIP_BUCKETS;
  if (skipped[B.byHost] || skipped[B.byMissingMeta] || skipped[B.byFromCli] || skipped[B.byAge]) {
    const parts = [];
    if (skipped[B.byAge]) parts.push(`${skipped[B.byAge]} too new`);
    if (skipped[B.byHost]) parts.push(`${skipped[B.byHost]} pushed from another host`);
    if (skipped[B.byFromCli]) parts.push(`${skipped[B.byFromCli]} different cli`);
    if (skipped[B.byMissingMeta]) parts.push(`${skipped[B.byMissingMeta]} missing metadata`);
    lines.push(`  skipped: ${parts.join(", ")}`);
  }
  if (candidates.length === 0) {
    lines.push("nothing to prune.", "");
    return lines.join("\n");
  }
  for (const c of candidates) {
    const ageDays = Math.floor((Date.now() - c.committedAt) / (24 * 60 * 60 * 1000));
    lines.push(`  ${c.branch}  (${ageDays}d ago)`);
  }
  lines.push("");
  if (dryRun) lines.push("--dry-run: nothing deleted.", "");
  return lines.join("\n");
}

function renderPruneResult({ deleted, failures }) {
  const lines = [];
  if (deleted.length) lines.push(`deleted ${deleted.length} branch(es).`);
  if (failures.length) {
    lines.push(`failed: ${failures.length}`);
    for (const f of failures) lines.push(`  ${f.branch}: ${f.reason}`);
  }
  lines.push("");
  return lines.join("\n");
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
  process.stdout.write(
    `${helpText(META)}\n\nSee skills/handoff/SKILL.md for the full reference.\n`,
  );
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
if (!/^\d+$/.test(limit.toString()))
  fail(EXIT_CODES.USAGE, `--limit must be a non-negative integer, got: ${limit}`);

const detectedHost = detectHost();
const toCli = detectedHost === "unknown" ? "claude" : detectedHost;

const fromCli = argv.flags.from !== undefined ? String(argv.flags.from).trim() : null;
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
    const hit = await resolveNarrowed(narrowTo, "latest");
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

  // ---- doctor / search ---------------------------------------------------
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
      `config: ${configLoaded ? CONFIG_FILE : "(not written yet — first push will create it)"}\n`,
    );
    process.stdout.write(
      `gh: ${ghAvailable() ? (ghAuthenticated() ? "authenticated" : "installed, not authenticated") : "not installed"}\n`,
    );
    process.stdout.write(
      `DOTCLAUDE_HANDOFF_REPO: ${process.env.DOTCLAUDE_HANDOFF_REPO || "(unset — will bootstrap on first push)"}\n`,
    );
    process.exit(r.status !== 0 ? r.status : EXIT_CODES.OK);
  }

  if (first === "search") {
    const query = second;
    if (!query) fail(EXIT_CODES.USAGE, "search requires a <query> argument");
    const hits = searchSessions({
      query,
      cli: fromCli,
      since: argv.flags.since ? String(argv.flags.since) : null,
      limit: limit.toString(),
      fixed: Boolean(argv.flags.fixed),
    });
    if (argv.json) {
      process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
      process.exit(EXIT_CODES.OK);
    }
    if (hits.length === 0) {
      process.stdout.write(`No sessions matching '${query}'\n`);
      process.exit(EXIT_CODES.OK);
    }
    process.stdout.write(
      "| CLI     | Short UUID | cwd                                   | Last modified       | Match                                    |\n",
    );
    process.stdout.write(
      "| ------- | ---------- | ------------------------------------- | ------------------- | ---------------------------------------- |\n",
    );
    for (const h of hits) {
      const when = new Date(h.mtime).toISOString().replace("T", " ").slice(0, 19);
      process.stdout.write(
        `| ${h.cli.padEnd(7)} | ${h.short_id.padEnd(10)} | ${(h.cwd ?? "").padEnd(37)} | ${when.padEnd(19)} | ${h.match_snippet.padEnd(40)} |\n`,
      );
    }
    process.stdout.write("\nDrill in with `dotclaude handoff pull <short-uuid> --summary`.\n");
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
    // #91 Gap 7: --tag <name> filters; --tags switches to histogram render.
    // Both need description-side tag info, so enrich once if either flag is
    // set (avoids the per-row fetch when neither is in play).
    //
    // Multiple --tag values on `list` are treated as OR: a row is kept if any
    // of its tags matches any of the requested filters. The same flag is
    // multi-value on `push` (collect) — argv.mjs returns string[] in both
    // cases — so this is a deliberate per-verb semantic, not a smell.
    const tagFilters = Array.isArray(argv.flags.tag)
      ? argv.flags.tag.map(String).filter((t) => t.length > 0)
      : [];
    const wantHistogram = Boolean(argv.flags.tags);
    const needTags = tagFilters.length > 0 || wantHistogram;
    if (showRemote) {
      if (!process.env.DOTCLAUDE_HANDOFF_REPO) {
        remoteSkipped = true;
        process.stderr.write(
          "dotclaude-handoff: list --remote: DOTCLAUDE_HANDOFF_REPO not set; skipping remote enumeration\n",
        );
      } else {
        try {
          const inventory = listRemoteCandidates();
          const enriched = needTags ? enrichWithDescriptions(inventory) : inventory;
          for (const c of enriched) {
            const parsed = parseHandoffBranch(c.branch);
            if (fromCli && parsed.cli !== fromCli) continue;
            const tagList = needTags ? parseTagsFromDescription(c.description) : [];
            if (tagFilters.length > 0 && !tagFilters.some((f) => tagList.includes(f))) continue;
            rows.push({
              location: "remote",
              cli: parsed.cli,
              short_id: parsed.shortId,
              branch: c.branch,
              commit: c.commit,
              when: parsed.yearMonth,
              tags: tagList,
            });
          }
        } catch (err) {
          process.stderr.write(`dotclaude-handoff: list --remote: ${err.message}\n`);
        }
      }
    }

    // Histogram mode short-circuits the row render. Aggregate over rows we
    // already gathered (already filtered by --from / --since / --tag).
    if (wantHistogram) {
      const counts = new Map();
      let untagged = 0;
      for (const r of rows) {
        if (!Array.isArray(r.tags) || r.tags.length === 0) {
          untagged += 1;
          continue;
        }
        for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (argv.json) {
        process.stdout.write(
          JSON.stringify({ histogram: Object.fromEntries(sorted), untagged }, null, 2) + "\n",
        );
        process.exit(EXIT_CODES.OK);
      }
      const total = rows.length;
      process.stdout.write(
        `tag histogram on transport (${total} branch${total === 1 ? "" : "es"}):\n`,
      );
      const widest = sorted.reduce((w, [k]) => Math.max(w, k.length), "(untagged)".length);
      for (const [tag, n] of sorted) {
        process.stdout.write(`  ${tag.padEnd(widest)}  ${n}\n`);
      }
      if (untagged > 0) {
        process.stdout.write(`  ${"(untagged)".padEnd(widest)}  ${untagged}\n`);
      }
      process.exit(EXIT_CODES.OK);
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
        ? await resolveNarrowed(fromCli, explicitQuery)
        : await resolveAny(explicitQuery);
    } else {
      // §5.5.2: --from is required when push has no <query>.
      if (!fromCli) {
        fail(
          EXIT_CODES.USAGE,
          `push without a <query> requires --from <cli>\n  usage: dotclaude handoff push --from <${[...CLIS].join("|")}>`,
        );
      }
      ({ hit: sessionHit, note: fallbackNote } = await resolveLatestWithHostScope({
        fromCli,
        detectedHost,
      }));
    }
    if (fallbackNote) process.stderr.write(fallbackNote + "\n");

    // #91 Gap 7: --tag is multi-valued. argv.flags.tag is now string[] when
    // any --tag was passed, or undefined. Pass through as `tags`.
    const tags = Array.isArray(argv.flags.tag) ? argv.flags.tag.map(String) : [];
    const verify = Boolean(argv.flags.verify);
    const verbose = Boolean(argv.verbose);
    const force = Boolean(argv.flags["force-collision"]);
    const dryRun = Boolean(argv.flags["dry-run"]);
    try {
      const result = await pushRemote({
        cli: sessionHit.cli,
        path: sessionHit.path,
        tags,
        verify,
        verbose,
        force,
        dryRun,
      });
      if (dryRun) {
        process.stdout.write(
          argv.json ? JSON.stringify(result, null, 2) + "\n" : renderDryRunPreview(result),
        );
      } else {
        process.stdout.write(
          `${result.branch}\n${result.url}\n${result.description}\n[scrubbed ${result.scrubbedCount} secrets]\n`,
        );
      }
      process.exit(EXIT_CODES.OK);
    } catch (err) {
      emitRemoteError(err, "push", {
        shortId: sessionHit ? shortIdFromPath(sessionHit.path) : undefined,
      });
      process.exit(2);
    }
  }

  if (first === "pull") {
    // Local render verb. Collapses the previous describe/digest/file/bare
    // surface under one verb with --summary and -o <path|auto|->. Always
    // runs the local resolver — never forwards to remote. When local misses
    // and DOTCLAUDE_HANDOFF_REPO is set, resolveLocalForPull appends a
    // single stderr hint pointing at `fetch` (#87).
    if (second === undefined) fail(EXIT_CODES.USAGE, "pull requires a <query>");
    const id = second;
    const summaryMode = Boolean(argv.flags.summary);
    const out = argv.flags.output != null ? String(argv.flags.output) : undefined;
    let hit;
    if (id.toLowerCase() === "latest") {
      // Host-scope the `latest` shortcut per #85: --from > detected host > union.
      // Case-fold matches the resolver's case-glob (Decision 2) so mixed-case
      // `Latest`/`LATEST` enter the host-scoped path here instead of falling
      // through to `any` resolution.
      const { hit: latestHit, note } = await resolveLatestWithHostScope({ fromCli, detectedHost });
      if (note) process.stderr.write(note + "\n");
      hit = latestHit;
    } else {
      hit = await resolveLocalForPull(id, fromCli);
    }
    const meta = extractMeta(hit.cli, hit.path);
    const prompts = extractPrompts(hit.cli, hit.path);
    if (summaryMode) {
      const body = argv.json
        ? JSON.stringify({ origin: meta, user_prompts: prompts }, null, 2)
        : renderDescribeMarkdown(meta, prompts);
      writeOutput(body, out, meta, { kind: "summary", prompts, sourcePath: hit.path, toCli });
      process.exit(EXIT_CODES.OK);
    }
    const turns = extractTurns(hit.cli, hit.path, limit);
    const body = argv.json
      ? JSON.stringify(buildDigestJson(meta, prompts, turns, toCli), null, 2)
      : renderHandoffBlock(meta, prompts, turns, toCli);
    writeOutput(body, out, meta, { kind: "digest", prompts, sourcePath: hit.path, toCli });
    process.exit(EXIT_CODES.OK);
  }

  if (first === "fetch") {
    if (argv.flags.summary) {
      fail(
        EXIT_CODES.USAGE,
        "--summary is only valid on `pull`; `fetch` retrieves the rendered handoff.md from the branch tip",
      );
    }
    const verify = Boolean(argv.flags.verify);
    const verbose = Boolean(argv.verbose);
    try {
      const hit = await pullRemote(second, fromCli, { verify, verbose });
      const { content } = fetchRemoteBranch(hit.branch);
      process.stdout.write(content.endsWith("\n") ? content : content + "\n");
      process.exit(EXIT_CODES.OK);
    } catch (err) {
      emitRemoteError(err, "fetch", { query: second ?? undefined });
      process.exit(2);
    }
  }

  if (first === "prune") {
    const raw = argv.flags["older-than"];
    if (!raw) fail(EXIT_CODES.USAGE, "prune requires --older-than <30d|6m|1y|YYYY-MM-DD>");
    let olderThanMs;
    try {
      olderThanMs = parseDuration(String(raw));
    } catch (err) {
      fail(EXIT_CODES.USAGE, `--older-than: ${err.message}`);
    }
    const dryRun = Boolean(argv.flags["dry-run"]);
    const yes = Boolean(argv.flags.yes);
    const verify = Boolean(argv.flags.verify);
    const verbose = Boolean(argv.verbose);
    try {
      const repoUrl = requireTransportRepoStrict();
      if (!dryRun) autoPreflight({ repo: repoUrl, verify, verbose });
      const result = listPruneCandidates({ olderThanMs, fromCli, repoUrl });
      if (argv.json && dryRun) {
        process.stdout.write(JSON.stringify({ dryRun: true, ...result }, null, 2) + "\n");
        process.exit(EXIT_CODES.OK);
      }
      process.stdout.write(renderPrunePreview(result, { dryRun }));
      if (result.candidates.length === 0 || dryRun) process.exit(EXIT_CODES.OK);

      if (!isTty() && !yes) {
        fail(
          EXIT_CODES.USAGE,
          "non-interactive prune requires --yes (or use --dry-run to preview)",
        );
      }
      if (isTty()) {
        const ans = await promptLine(`Delete ${result.candidates.length} branch(es)? [y/N] `);
        if (!/^y(es)?$/i.test(ans)) {
          process.stdout.write("aborted.\n");
          process.exit(EXIT_CODES.OK);
        }
      }
      const branches = result.candidates.map((c) => c.branch);
      const dr = deleteRemoteBranches(repoUrl, branches);
      process.stdout.write(renderPruneResult(dr));
      process.exit(dr.failures.length > 0 ? 2 : EXIT_CODES.OK);
    } catch (err) {
      emitRemoteError(err, "prune", {});
      process.exit(2);
    }
  }

  fail(
    EXIT_CODES.USAGE,
    `unknown command: ${first}. Run 'dotclaude handoff --help' for valid commands.`,
  );
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
