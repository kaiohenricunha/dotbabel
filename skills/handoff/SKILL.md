---
id: handoff
name: handoff
type: skill
version: 1.3.0
domain: [devex]
platform: [none]
task: [documentation, debugging]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-04-17
updated: 2026-05-04
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

Thin wrapper around the `dotbabel handoff` binary. The binary is the
authoritative contract; run `dotbabel handoff --help` for the full
sub-command list and flag reference. This file maps natural language to
the right invocation.

## Auto-trigger phrase mapping

| Trigger phrase                                                         | Invocation                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| `handoff <id>` / resume-command fragments                              | `dotbabel handoff pull <id>`                        |
| `continue in <cli>` / `switch to <cli>` / `pull from <cli>`            | `dotbabel handoff pull <id> --from <cli>`           |
| `what was that session about` + identifier                             | `dotbabel handoff pull <id> --summary`              |
| `push handoff` / `send to other machine` / `save this`                 | `dotbabel handoff push --from <host-cli> [--tag …]` |
| `pull handoff` / `fetch handoff` / `continue from yesterday's machine` | `dotbabel handoff fetch [<query>]`                  |

Extract `<id>` from the user message (UUID, short UUID, or a deliberate-label
alias: claude `customTitle`/`aiTitle`, codex `thread_name`, copilot
`workspace.yaml:name`, or gemini `checkpoint`). Aliases match
case-insensitively. Resolution precedence: UUID > short-UUID > `latest` >
alias (no fall-through on miss).
The resolver probes Claude / Copilot / Codex / Gemini roots automatically. If the
query is missing or ambiguous, ask one clarifying question before proceeding.

## The `--from` filling rule

When invoking `dotbabel handoff push` without a query positional,
include `--from <your-cli>` where `<your-cli>` is the agent the host LLM
is running in (`claude` for Claude Code, `copilot` for GitHub Copilot CLI,
`codex` for Codex). The flag is required in that mode; the binary exits
64 without it.

## Layered fidelity (Approach A and Approach B)

The digest combines two layers of context fidelity. Justification and
tradeoffs are captured in
`docs/experiments/handoff-hardening-2026-05-08.md` (added in PR #206;
this PR must merge after #206 for the link to resolve).

- **B-floor (always on).** Mechanical extraction the binary performs
  unconditionally: TodoWrite mining in claude/codex transcripts,
  user-prompt cap of 50 (prompt 1 pinned + last 49), and assistant
  turn sampling (first turn + last 3). This is what every `push` and
  `pull` produces with no extra flags. See
  `references/digest-schema.md` for the schema and size bounds.
- **Approach A (opt-in via `--state-file`).** When
  `dotbabel handoff push --state-file <path>` is passed, the file's
  raw content (typically a `<handoff-state>` YAML block authored by
  the source agent) is prepended above the mechanical `<handoff>`
  block. This lets the agent author intent, decisions, and goals
  verbatim instead of relying on extraction heuristics. The block
  flows through the same secret scrubber. See
  `references/digest-schema.md` for the rendered shape.

## Tool execution failures

When the `dotbabel` binary cannot be executed for any reason —
permission denied, binary not found, network failure, sandbox
restriction — do NOT fabricate, reconstruct, or synthesize a
`<handoff>` block from raw session JSONL files. Report the
tool-execution error verbatim and stop; instruct the user to run
the command manually in a shell where `dotbabel` is available.

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

Brief reference. `dotbabel handoff --help` is authoritative.

- `--from <cli>` narrows source-CLI auto-detection on `push`, `fetch`, `pull`; filters `list`, `search`, and `prune`.
  For `pull latest`, omitting `--from` triggers host auto-detection: `CLAUDECODE=1` / `COPILOT_*` / `CODEX_*` / `GEMINI_CLI*` env signals → narrowed to that CLI's root; host undetectable → cross-root union (newest mtime across all four roots).
- `--summary` is `pull`-only; `fetch --summary` exits 64 because `fetch` retrieves the rendered remote `handoff.md`.
- `-o <path>` (on `pull`) controls output: `-` forces stdout; `auto` writes to `<repo>/docs/handoffs/<date>-<cli>-<short>.md`; any other string is a literal path.
- `--since <ISO>` cuts off `list` and `search` (default 30 days for `search`).
- `--limit <N>` caps the row count.
- `--tag <label>` annotates a `push` (repeatable). On `fetch <tag>`, exact-tag matches are preferred over description substring fallback.
- `--fixed` / `-F` treats the `search` query as a literal string instead of a regex.
- `--json` is honoured by `list`, `pull`, `search`.
- `--state-file <path>` (on `push`) prepends a free-form state block (Approach A) to the digest before the mechanical extraction. The block is scrubbed for secrets like any other content.

## Out of scope

- **Invoking the target CLI directly.** The skill prints; the user pastes. Keeps the transfer auditable.
- **End-to-end encryption.** The git transport is access-controlled by the host (private repo + auth); content is plaintext on the remote. `push` runs the scrubber and fails closed (exit 2) if it can't run. Best-effort pattern pass — see `references/redaction.md`.
- **Fuzzy or semantic search.** `search` is substring/regex only.

## Internal references

- `dotbabel handoff --help` — authoritative flag and sub-command list.
- `references/prerequisites.md` — install matrix and remote-transport setup.
- `references/from-codex.md` — Codex-specific notes.
- `references/redaction.md` — scrubber behavior.
