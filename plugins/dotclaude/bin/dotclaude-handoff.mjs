#!/usr/bin/env node
/**
 * dotclaude-handoff — read a session transcript and render it as a
 * paste-ready handoff digest.
 *
 * Usage:
 *   dotclaude-handoff <subcmd> <cli> <identifier> [--to <cli>] [OPTIONS]
 *
 * Subcommands:
 *   resolve   <cli> <id>              print resolved session file path
 *   describe  <cli> <id>              inline summary (markdown or --json)
 *   digest    <cli> <id> [--to ...]   full <handoff> block for paste
 *   list      <cli>                   newest-first table of sessions
 *   file      <cli> <id> [--to ...]   write markdown handoff doc to disk
 *
 * cli:  claude | copilot | codex
 * id:   full UUID, short UUID (first 8 hex), `latest`, or (codex only)
 *       a thread_name alias.
 *
 * Exits: 0 ok, 2 not-found / runtime error, 64 usage error.
 */

import { parse, helpText } from "../src/lib/argv.mjs";
import { EXIT_CODES } from "../src/lib/exit-codes.mjs";
import { version } from "../src/index.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";

const SUBCOMMANDS = new Set(["resolve", "describe", "digest", "list", "file"]);
const CLIS = new Set(["claude", "copilot", "codex"]);

const META = {
  name: "dotclaude-handoff",
  synopsis:
    "dotclaude-handoff <resolve|describe|digest|list|file> <claude|copilot|codex> [<id>] [--to <cli>]",
  description:
    "Read a session transcript from one agentic CLI and render it as a paste-ready handoff digest. Works from any shell, including Codex's bash tool.",
  flags: {
    to: { type: "string" },
    limit: { type: "string" },
    "out-dir": { type: "string" },
  },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolvePath(__dirname, "..", "scripts");
const RESOLVE_SH = join(SCRIPTS, "handoff-resolve.sh");
const EXTRACT_SH = join(SCRIPTS, "handoff-extract.sh");

function fail(code, msg) {
  if (msg) process.stderr.write(`dotclaude-handoff: ${msg}\n`);
  process.exit(code);
}

function runScript(script, args) {
  const res = spawnSync(script, args, { encoding: "utf8" });
  return { status: res.status ?? 2, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function resolveSession(cli, id) {
  const r = runScript(RESOLVE_SH, [cli, id]);
  if (r.status !== 0) {
    fail(r.status === 64 ? EXIT_CODES.USAGE : 2, r.stderr.trim() || `could not resolve ${cli} ${id}`);
  }
  return r.stdout.trim();
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
  if (toShow.length === 0) {
    lines.push("- (no user prompts captured)");
  } else {
    for (const p of toShow) {
      const trimmed = p.length > 200 ? `${p.slice(0, 200).trim()}…` : p;
      lines.push(`- ${trimmed}`);
    }
  }
  if (prompts.length > 10) {
    lines.push(`- …and ${prompts.length - 10} more (truncated)`);
  }
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
  if (promptsCapped.length === 0) {
    lines.push("1. (no user prompts captured)");
  } else {
    promptsCapped.forEach((p, i) => {
      const trimmed = p.length > 300 ? `${p.slice(0, 300).trim()}…` : p;
      lines.push(`${i + 1}. ${trimmed}`);
    });
  }
  lines.push("");
  lines.push("**Last assistant turns (tail).**");
  lines.push("");
  if (turnsTail.length === 0) {
    lines.push("_(no assistant output captured)_");
  } else {
    for (const t of turnsTail) {
      const trimmed = t.length > 400 ? `${t.slice(0, 400).trim()}…` : t;
      lines.push(`> ${trimmed.replace(/\n/g, "\n> ")}`);
      lines.push("");
    }
  }
  lines.push("**Next step.** " + next);
  lines.push("");
  lines.push("</handoff>");
  return lines.join("\n");
}

const UUID_HEAD_RE = /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const CLI_LAYOUTS = {
  claude: {
    root: (home) => join(home, ".claude", "projects"),
    // ~/.claude/projects/<slug>/<uuid>.jsonl — one level deep.
    walk: 1,
    match: (name) => name.endsWith(".jsonl"),
  },
  copilot: {
    root: (home) => join(home, ".copilot", "session-state"),
    // ~/.copilot/session-state/<uuid>/events.jsonl — one level deep.
    walk: 1,
    match: (name) => name === "events.jsonl",
  },
  codex: {
    root: (home) => join(home, ".codex", "sessions"),
    // ~/.codex/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl — three levels deep.
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

function listSessions(cli) {
  const layout = CLI_LAYOUTS[cli];
  if (!layout) fail(EXIT_CODES.USAGE, `unknown cli: ${cli}`);
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
    rows.push({ cli, short_id: shortId, file, mtime, when });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, 50);
}

// ---- main ---------------------------------------------------------------

let argv;
try {
  argv = parse(process.argv.slice(2), META.flags);
} catch (err) {
  fail(EXIT_CODES.USAGE, err.message);
}

if (argv.help) {
  process.stdout.write(`${helpText(META)}\n`);
  process.exit(EXIT_CODES.OK);
}
if (argv.version) {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_CODES.OK);
}

// Bare form `dotclaude-handoff <cli> <id>` is implicit `digest`.
let sub, cli, id;
if (argv.positional.length >= 1 && CLIS.has(argv.positional[0])) {
  sub = "digest";
  cli = argv.positional[0];
  id = argv.positional[1];
  if (!id) fail(EXIT_CODES.USAGE, `missing identifier (uuid, short-uuid, 'latest', or alias) after '${cli}'`);
} else {
  [sub, cli, id] = argv.positional;
  if (!sub) fail(EXIT_CODES.USAGE, "missing subcommand or cli. See --help.");
  if (!SUBCOMMANDS.has(sub)) fail(EXIT_CODES.USAGE, `unknown subcommand: ${sub}`);
  if (!cli) fail(EXIT_CODES.USAGE, "missing cli argument");
  if (!CLIS.has(cli)) fail(EXIT_CODES.USAGE, `cli must be one of: claude, copilot, codex`);
}

const toCli = argv.flags.to ?? "claude";
if (!CLIS.has(toCli)) fail(EXIT_CODES.USAGE, `--to must be one of: claude, copilot, codex`);

const limit = argv.flags.limit ?? "20";
if (!/^\d+$/.test(limit)) fail(EXIT_CODES.USAGE, `--limit must be a non-negative integer, got: ${limit}`);

if (sub === "list") {
  const rows = listSessions(cli);
  if (argv.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    process.exit(EXIT_CODES.OK);
  }
  if (rows.length === 0) {
    process.stdout.write(`No ${cli} sessions found\n`);
    process.exit(EXIT_CODES.OK);
  }
  process.stdout.write(`| Short UUID | When              | File |\n`);
  process.stdout.write(`| ---------- | ----------------- | ---- |\n`);
  for (const r of rows) {
    process.stdout.write(`| ${r.short_id} | ${r.when} | ${r.file} |\n`);
  }
  process.exit(EXIT_CODES.OK);
}

if (!id) fail(EXIT_CODES.USAGE, `${sub} requires an identifier (uuid, short-uuid, 'latest', or alias)`);

const file = resolveSession(cli, id);

if (sub === "resolve") {
  process.stdout.write(`${file}\n`);
  process.exit(EXIT_CODES.OK);
}

const meta = extractMeta(cli, file);
const prompts = extractPrompts(cli, file);

if (sub === "describe") {
  if (argv.json) {
    process.stdout.write(
      JSON.stringify({ origin: meta, user_prompts: prompts }, null, 2) + "\n"
    );
    process.exit(EXIT_CODES.OK);
  }
  process.stdout.write(renderDescribeMarkdown(meta, prompts) + "\n");
  process.exit(EXIT_CODES.OK);
}

const turns = extractTurns(cli, file, limit);

if (sub === "digest") {
  process.stdout.write(renderHandoffBlock(meta, prompts, turns, toCli) + "\n");
  process.exit(EXIT_CODES.OK);
}

if (sub === "file") {
  // Write a markdown doc to docs/handoffs/ (or ~/.claude/handoffs/ as fallback).
  const outDir = argv.flags["out-dir"];
  let target;
  if (outDir) {
    target = resolvePath(outDir);
  } else {
    const gitRes = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (gitRes.status === 0 && gitRes.stdout.trim()) {
      target = join(gitRes.stdout.trim(), "docs", "handoffs");
    } else {
      target = join(process.env.HOME ?? "", ".claude", "handoffs");
    }
  }
  mkdirSync(target, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const shortId = meta.short_id ?? "unknown";
  const filename = `${today}-${meta.cli}-${shortId}.md`;
  const outPath = join(target, filename);

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
    `- Source transcript: \`${file}\``,
    `- Prompts: ${prompts.length} (verbatim); assistant turns summarized in the <handoff> block.`,
  ].join("\n");

  writeFileSync(outPath, body + "\n");
  process.stdout.write(`${outPath}\n`);
  process.exit(EXIT_CODES.OK);
}

fail(EXIT_CODES.USAGE, `unhandled subcommand: ${sub}`);
