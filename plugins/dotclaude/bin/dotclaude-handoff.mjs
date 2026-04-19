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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

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

function extractPrompts(cli, file) {
  const r = runScript(EXTRACT_SH, ["prompts", cli, file]);
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((line) => line.trim().length > 0);
}

function extractTurns(cli, file, limit) {
  const args = ["turns", cli, file];
  if (limit) args.push(String(limit));
  const r = runScript(EXTRACT_SH, args);
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((line) => line.trim().length > 0);
}

function nextStepFor(toCli) {
  // The LLM on the target side will re-summarize; this is a mechanical cue.
  if (toCli === "codex") {
    return "Read the prompts and assistant turns above, then continue the task using the file paths mentioned. Treat this as a task specification.";
  }
  if (toCli === "copilot") {
    return "Help me pick up where this session left off; reference the prompts and findings above.";
  }
  // claude (default)
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

function listSessions(cli) {
  // Delegate to handoff-resolve.sh's `latest` logic by shelling out to find.
  // Newest-first per CLI.
  const home = process.env.HOME ?? "";
  let roots, pattern;
  switch (cli) {
    case "claude":
      roots = [join(home, ".claude", "projects")];
      pattern = "*.jsonl";
      break;
    case "copilot":
      roots = [join(home, ".copilot", "session-state")];
      pattern = "events.jsonl";
      break;
    case "codex":
      roots = [join(home, ".codex", "sessions")];
      pattern = "rollout-*.jsonl";
      break;
    default:
      fail(EXIT_CODES.USAGE, `unknown cli: ${cli}`);
  }
  const root = roots[0];
  if (!existsSync(root)) return [];
  const res = spawnSync("sh", [
    "-c",
    `find "${root}" ${cli === "claude" ? "-maxdepth 2" : ""} -type f -name '${pattern}' 2>/dev/null | xargs -I{} sh -c 'stat -c "%Y %n" "{}" 2>/dev/null || stat -f "%m %N" "{}" 2>/dev/null' | sort -rn | head -50`,
  ], { encoding: "utf8" });
  const rows = [];
  for (const line of (res.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx < 0) continue;
    const mtime = parseInt(line.slice(0, spaceIdx), 10);
    const file = line.slice(spaceIdx + 1);
    // Derive short_id from path.
    let shortId = "?";
    const m =
      cli === "claude" ? file.match(/\/([0-9a-f]{8})-[0-9a-f]{4}-/) :
      cli === "copilot" ? file.match(/\/([0-9a-f]{8})-[0-9a-f]{4}-/) :
      /* codex */         file.match(/-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/);
    if (m) shortId = m[1];
    const when = new Date(mtime * 1000).toISOString().replace("T", " ").slice(0, 16);
    rows.push({ cli, short_id: shortId, file, mtime, when });
  }
  return rows;
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

const [sub, cli, id] = argv.positional;

if (!sub) fail(EXIT_CODES.USAGE, "missing subcommand. See --help.");
if (!SUBCOMMANDS.has(sub)) fail(EXIT_CODES.USAGE, `unknown subcommand: ${sub}`);
if (!cli) fail(EXIT_CODES.USAGE, "missing cli argument");
if (!CLIS.has(cli)) fail(EXIT_CODES.USAGE, `cli must be one of: claude, copilot, codex`);

const toCli = argv.flags.to ?? "claude";
if (!CLIS.has(toCli)) fail(EXIT_CODES.USAGE, `--to must be one of: claude, copilot, codex`);

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

const turns = extractTurns(cli, file, argv.flags.limit ?? "20");

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
