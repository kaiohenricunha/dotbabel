---
id: handoff
name: handoff
type: skill
version: 1.2.0
domain: [devex]
platform: [none]
task: [documentation, debugging]
maturity: draft
description: >
  Transfer conversation context between agentic CLIs (Claude Code, GitHub
  Copilot CLI, OpenAI Codex CLI) locally and across machines. Reads a
  source session transcript by UUID and produces either an inline summary,
  a paste-ready handoff digest, a written markdown file, or a branch in a
  user-owned private git repo that another machine can fetch. Use when
  switching agents mid-task, recovering context, or moving between
  Windows/Linux/macOS setups. Triggers on: "handoff", "transfer context",
  "continue in codex", "continue in claude", "continue in copilot",
  "switch to codex", "switch to claude", "what was that session about",
  "claude --resume", "copilot --resume", "codex resume",
  "find the session where", "search sessions", "which session did I",
  "push handoff", "fetch handoff", "handoff to other machine",
  "resume on my other laptop".
argument-hint: "[pull|push|fetch|list|search|prune|doctor] [args...]"
tools: Glob, Read, Grep, Bash, Write
effort: medium
model: sonnet
---

# Handoff — Cross-CLI Session Context Transfer

Thin wrapper around the `dotclaude handoff` binary. The binary is the
authoritative contract; run `dotclaude handoff --help` for the full
sub-command list and flag reference. This file maps natural language to
the right invocation.

## Auto-trigger phrase mapping

| Trigger phrase                                                         | Invocation                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `handoff <id>` / resume-command fragments                              | `dotclaude handoff pull <id>`                        |
| `continue in <cli>` / `switch to <cli>` / `pull from <cli>`            | `dotclaude handoff pull <id> --from <cli>`           |
| `what was that session about` + identifier                             | `dotclaude handoff pull <id> --summary`              |
| `push handoff` / `send to other machine` / `save this`                 | `dotclaude handoff push --from <host-cli> [--tag …]` |
| `pull handoff` / `fetch handoff` / `continue from yesterday's machine` | `dotclaude handoff fetch [<query>]`                  |

Extract `<id>` from the user message (UUID, short UUID, or named alias).
The resolver probes Claude / Copilot / Codex roots automatically. If the
query is missing or ambiguous, ask one clarifying question before
proceeding.

## The `--from` filling rule

When invoking `dotclaude handoff push` without a query positional,
include `--from <your-cli>` where `<your-cli>` is the agent the host LLM
is running in (`claude` for Claude Code, `copilot` for GitHub Copilot CLI,
`codex` for Codex). The flag is required in that mode; the binary exits
64 without it.

## Tool execution failures

When the `dotclaude` binary cannot be executed for any reason —
permission denied, binary not found, network failure, sandbox
restriction — do NOT fabricate, reconstruct, or synthesize a
`<handoff>` block from raw session JSONL files. Report the
tool-execution error verbatim and stop; instruct the user to run
the command manually in a shell where `dotclaude` is available.

Specifically:

1. Quote the exact command attempted and the failure message.
2. Tell the user to run it themselves and paste the output back.
3. Do not infer, summarize, or proceed as if the call had succeeded.

Why: the binary is the authoritative producer of `<handoff>` blocks
— it owns the scrub passes (`push` redaction) and the extraction
logic §4 data flow depends on. Fabricated output may pass shape
validation but bypasses scrubbing entirely; the consumer cannot
distinguish a hand-rolled block from a real one.

## Cross-cutting flags

Brief reference. `dotclaude handoff --help` is authoritative.

- `--from <cli>` narrows source-CLI auto-detection on `push`, `fetch`, `pull`; filters `list`, `search`, and `prune`.
  For `pull latest`, omitting `--from` triggers host auto-detection: `CLAUDECODE=1` / `COPILOT_*` / `CODEX` env signals → narrowed to that CLI's root; host undetectable → cross-root union (newest mtime across all three roots).
- `--summary` (on `pull`) emits a prose summary instead of the full `<handoff>` block.
- `-o <path>` (on `pull`) controls output: `-` forces stdout; `auto` writes to `<repo>/docs/handoffs/<date>-<cli>-<short>.md`; any other string is a literal path.
- `--since <ISO>` cuts off `list` and `search` (default 30 days for `search`).
- `--limit <N>` caps the row count.
- `--tag <label>` annotates a `push` (repeatable). On `fetch <tag>`, exact-tag matches are preferred over description substring fallback.
- `--fixed` / `-F` treats the `search` query as a literal string instead of a regex.
- `--json` is honoured by `list`, `pull`, `search`.

## Out of scope

- **Invoking the target CLI directly.** The skill prints; the user pastes. Keeps the transfer auditable.
- **End-to-end encryption.** The git transport is access-controlled by the host (private repo + auth); content is plaintext on the remote. `push` runs the scrubber and fails closed (exit 2) if it can't run. Best-effort pattern pass — see `references/redaction.md`.
- **Fuzzy or semantic search.** `search` is substring/regex only.

## Internal references

- `dotclaude handoff --help` — authoritative flag and sub-command list.
- `references/prerequisites.md` — install matrix and remote-transport setup.
- `references/from-codex.md` — Codex-specific notes.
- `references/redaction.md` — scrubber behavior.
