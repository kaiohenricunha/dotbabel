---
id: handoff
name: handoff
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [documentation, debugging]
maturity: draft
description: >
  Transfer conversation context between agentic CLIs (Claude Code, GitHub
  Copilot CLI, OpenAI Codex CLI) locally and across machines. Reads a
  source session transcript by UUID and produces either an inline summary,
  a paste-ready handoff digest, a written markdown file, or a branch in a
  user-owned private git repo that another machine can pull. Use when
  switching agents mid-task, recovering context, or moving between
  Windows/Linux/macOS setups. Triggers on: "handoff", "transfer context",
  "continue in codex", "continue in claude", "continue in copilot",
  "switch to codex", "switch to claude", "what was that session about",
  "claude --resume", "copilot --resume", "codex resume",
  "find the session where", "search sessions", "which session did I",
  "push handoff", "pull handoff", "handoff to other machine",
  "resume on my other laptop".
argument-hint: "[<query>|push|pull|list|doctor|remote-list|search] [args...]"
tools: Glob, Read, Grep, Bash, Write
effort: medium
model: sonnet
---

# Handoff — Cross-CLI Session Context Transfer

This skill is a thin wrapper around the `dotclaude handoff` binary.
The binary is the executable contract; the skill exists to map natural
language ("continue this in codex") into the right invocation and to
document the public surface in one place. Every form below also works
verbatim as `!dotclaude handoff …` from any shell — including Codex's
bash tool.

## The five forms

```
/handoff                              push host's latest session
/handoff <query>                      local cross-agent: emit <handoff>
/handoff push [<query>] [--tag <l>]   upload to transport
/handoff pull [<query>]               fetch from transport
/handoff list [--local|--remote]      unified table
```

`<query>` auto-detects across `~/.claude/projects`,
`~/.copilot/session-state`, and `~/.codex/sessions`. Accepted forms:
full UUID, short UUID (first 8 hex), `latest`, Claude `customTitle`
alias, Codex `thread_name` alias.

**Collision model.** When `<query>` matches multiple roots (or two
remote handoffs on `pull`): TTY → interactive prompt; non-TTY → exit 2
with a TSV candidate list on stderr.

## Sub-commands

The binary's `--help` lists the full surface and authoritative flag
semantics. Brief summary:

| Sub                   | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `init`                | Scaffold the remote schema pin on `main` (idempotent, one-time)     |
| `resolve <cli> <id>`  | Print the absolute JSONL path                                       |
| `describe <cli> <id>` | Inline 2–4 sentence summary + verbatim user prompts                 |
| `digest <cli> <id>`   | Print a paste-ready `<handoff>` block (no transport)                |
| `file <cli> <id>`     | Write the digest to `docs/handoffs/<date>-<cli>-<short>.md`         |
| `list`                | Unified local + remote table (`--local` / `--remote` to filter)     |
| `search <query>`      | Substring/regex match across local sessions; `--cli` / `--since`    |
| `push [<query>]`      | Push to `$DOTCLAUDE_HANDOFF_REPO`; `--tag` / `--include-transcript` |
| `pull [<handle>]`     | Fetch from `$DOTCLAUDE_HANDOFF_REPO`; `--from-file` for offline     |
| `remote-list`         | List handoffs on the transport; `--cli` / `--since` / `--limit`     |
| `doctor`              | Verify `git` + `$DOTCLAUDE_HANDOFF_REPO` + schema pin               |

Cross-cutting flags (consult `--help` for the canonical list):

- `--from <cli>` narrows source-CLI auto-detection on `push`, `pull`,
  bare `<query>`. Without it, the resolver probes all three roots.
- `--to <cli>` tunes the `<handoff>` block's next-step wording for a
  target agent. Defaults to the auto-detected host.
- `--cli <cli>` filters `search` and `remote-list` to one CLI.
- `--since <ISO>` cuts off `search` and `remote-list` (default 30 days).
- `--limit <N>` caps the row count (default 20).
- `--tag <label>` annotates a `push` for fuzzy `pull` later.
- `--include-transcript` adds the last 50 raw turns to a `push`
  (off by default to minimise leakage).
- `--from-file <path>` lets `pull` load a local markdown file written
  by `file`. Works without network access.
- `--json` is honoured by `list`, `describe`, `remote-list`, `search`.

## Prerequisites

Local sub-commands need only `jq` and the session files on disk.

The remote transport (`push`/`pull`/`remote-list`/`doctor`) is a
user-owned private git repo (any provider — GitHub, GitLab, Gitea,
self-hosted). Required:

- `git` on PATH.
- `$DOTCLAUDE_HANDOFF_REPO` set to the repo URL (no default; example:
  `git@github.com:<user>/handoff-store.git`).
- Working SSH or credential-helper auth for that repo.
- The repo initialised once via `dotclaude handoff init` — writes the
  schema pin on `main` so the binary can refuse mismatched stores.

Run `dotclaude handoff doctor` to verify. Full install matrix and
remediation lives in `references/prerequisites.md`.

## Repo layout (v0.10.0+)

Each handoff is a branch:

```
handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>
```

e.g. `handoff/dotclaude/claude/2026-04/aaaa1111`. `main` holds
`.dotclaude-handoff.json` (the schema pin) and a README — `push`/
`pull`/`remote-list`/`prune` only touch `handoff/...` branches. Full
schema + rationale in [`docs/handoff-store-schema.md`](https://github.com/kaiohenricunha/dotclaude/blob/main/docs/handoff-store-schema.md).

## Auto-trigger contract

When the user message matches any of these patterns, run the bare
`<query>` form (local cross-agent digest) by default:

- Resume-command fragments: `claude --resume <uuid>`,
  `claude --resume "<name>"`, `copilot --resume=<uuid>`,
  `codex resume <uuid>`, `codex resume <name>`.
- Natural language: "what was that session about", "continue in X",
  "switch to X", "handoff".

Extract the `<query>` from the user message (UUID, short UUID, or
named alias). The skill probes all three roots — no `<cli>` argument
needed. If the query is missing or ambiguous, ask one clarifying
question before proceeding.

## Out of scope

- **Invoking the target CLI directly.** The skill prints; the user
  pastes. This is deliberate — keeps the transfer auditable and
  prevents unintended cross-session execution.
- **End-to-end encryption.** The git transport is access-controlled
  by the host (private repo + push-side auth), but content is stored
  in plaintext on the remote. Do not push transcripts containing
  secrets you rely on scrubbing to catch. Scrubbing is a best-effort
  pattern pass (see `references/redaction.md`).
- **Fuzzy or semantic search.** `search` is substring/regex only.
- **Persistent indexing.** Grep-at-query-time is fast enough for
  local session volumes; revisit only if p95 exceeds ~2s.
