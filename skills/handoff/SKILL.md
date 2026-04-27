---
id: handoff
name: handoff
type: skill
version: 1.1.0
domain: [devex]
platform: [none]
task: [documentation, debugging]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-04-17
updated: 2026-04-23
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
argument-hint: "[pull|push|fetch|list|search|resolve|doctor] [args...]"
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

## The four forms

```
/handoff pull [<id>] [--from <cli>] [--to <cli>] [--summary] [-o <path>]
/handoff push [<query>] [--from <cli>] [--tag <label> ...]
/handoff fetch [<query>] [--from <cli>] [--verify]
/handoff list [--local|--remote] [--from <cli>] [--since <ISO>] [--limit N|--all] [--tag <name>] [--tags]
```

A bare `/handoff` with no arguments prints usage and exits 0. Every
remote verb (`push`, `fetch`) is explicit.

If `--from` is set, resolution narrows to that CLI; otherwise the host is
auto-detected; otherwise all three roots are scanned.

`<id>` / `<query>` auto-detects across `~/.claude/projects`,
`~/.copilot/session-state`, and `~/.codex/sessions`. Accepted forms:
full UUID, short UUID (first 8 hex), `latest`, Claude `customTitle`
alias, Codex `thread_name` alias.

**`latest` is host-scoped.** When the binary identifies the invoking
CLI (via `--from` or host-specific env-var probes such as `CLAUDECODE=1`,
`CLAUDE_CODE_SSE_PORT`, `CODEX_*`, `COPILOT_*`, and `GITHUB_COPILOT_*`),
`latest` resolves within that CLI's root only — so inside Claude Code
it picks the newest `~/.claude/projects` session even when a newer
Codex JSONL exists on disk. Explicit UUIDs and aliases are never
narrowed. Without a host signal `latest` falls back to the union
resolver (globally newest across all roots) and stderr names the
picked session. Pass `--from <cli>` to force a specific root.

**Collision model.** When `<query>` matches multiple roots (or two
remote handoffs on `fetch`): TTY → interactive prompt; non-TTY → exit 2
with a TSV candidate list on stderr.

## Sub-commands

The binary's `--help` lists the full surface and authoritative flag
semantics. Brief summary:

| Sub                  | Purpose                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pull [<id>]`        | Render local session to stdout (`<handoff>` block); `--summary` for prose; `-o` to write to disk                      |
| `resolve <cli> <id>` | Print the absolute JSONL path                                                                                         |
| `list`               | Unified local + remote table (`--local`/`--remote`, `--from`, `--since`, `--limit`/`--all`, `--tag <name>`, `--tags`) |
| `search <query>`     | Substring/regex match across local sessions; `--from` / `--since` / `--limit` / `--fixed` / `--json`                  |
| `push [<query>]`     | Push to `$DOTCLAUDE_HANDOFF_REPO`; `--tag`                                                                            |
| `fetch [<handle>]`   | Fetch from `$DOTCLAUDE_HANDOFF_REPO`; `--from-file` for offline                                                       |
| `remote-list`        | List handoffs on the transport; `--from` / `--since` / `--limit`                                                      |
| `doctor`             | Verify `git` + `$DOTCLAUDE_HANDOFF_REPO` + `gh` fallback                                                              |

Cross-cutting flags (consult `--help` for the canonical list):

- `--from <cli>` narrows source-CLI auto-detection on `push`, `fetch`,
  `pull`, and filters `list`, `search`, and `remote-list` to one root.
  Without it, the resolver probes all three roots. `--cli` is accepted
  as a legacy alias on `search` and `remote-list`.
  For `push` without a query, `--from` is required.
- `--to <cli>` tunes the `<handoff>` block's next-step wording for a
  target agent. Defaults to the auto-detected host. `--from` narrows
  the source root; `--to` still resolves to the invoking host unless
  explicitly overridden.
- `--summary` (on `pull`) emits a prose summary + verbatim user prompts
  instead of the full `<handoff>` block.
- `-o <path>` (on `pull`) controls the output destination:
  `-` forces stdout; `auto` writes to `<repo>/docs/handoffs/<date>-<cli>-<short>.md`
  (falling back to `~/.claude/handoffs/` when off-repo) and prints the
  file path on stdout; any other string is used as the literal output path.
- `--since <ISO>` cuts off `list` when explicitly provided, and
  cuts off `search` and `remote-list` (default 30 days).
- `--limit <N>` caps the row count (default 20). `--all` (on `list`)
  disables the cap.
- `--fixed` / `-F` treats the `search` query as a literal string
  instead of a regex.
- `--tag <label>` annotates a `push`. Repeatable for multi-tag
  (`--tag shipping --tag perf`). On `list --remote`, `--tag <name>`
  filters by exact tag and `--tags` switches to a tag-frequency
  histogram. On `fetch <tag>`, exact-tag matches are preferred over
  description substring fallback.
- `--from-file <path>` lets `fetch` load a local markdown file written
  by `pull -o`. Works without network access.
- `--json` is honoured by `list`, `pull`, `remote-list`, `search`.

## Cross-agent behavior

(a) **`pull` stdout is the transport into the model's context.** All three
host runtimes (Claude Code, Copilot CLI, Codex via its bash tool) capture
stdout the same way. `pull` to stdout; the runtime delivers it.

(b) **`--to` on `pull` defaults to the detected host, not `--from`.** When
`--from` is set without `--to`, `--to` still resolves to the invoking host.
`--from` narrows the source root; `--to` tunes the next-step wording for
where the output will be read.

(c) **Self-referential pull is allowed and renders normally.** When
host-scoped `latest` resolves to the session the command was run from,
the digest renders the current session into its own context. Occasionally
useful for capturing the current session via `-o auto`.

(d) **`pull <unmatched>` does not auto-forward to `fetch`.** If the local
resolver returns no match and `$DOTCLAUDE_HANDOFF_REPO` is set, a single
stderr hint suggests `fetch <id>`. If the variable is unset, only the
standard no-match error appears. No silent source override.

## Prerequisites

Local sub-commands need only `jq` and the session files on disk.

The remote transport (`push`/`fetch`/`remote-list`/`doctor`) is a
user-owned private git repo (any provider — GitHub, GitLab, Gitea,
self-hosted). Required:

- `git` on PATH.
- Either `$DOTCLAUDE_HANDOFF_REPO` set to a repo URL, **or** the binary
  will auto-bootstrap on first `push` when stdin is a TTY and `gh` is
  authenticated — it offers to `gh repo create` a private store and
  persists the URL to `$XDG_CONFIG_HOME/dotclaude/handoff.env` (default:
  `~/.config/dotclaude/handoff.env`) for future runs.
- Working SSH or credential-helper auth for the resulting repo.

That's it. No `init` step, no schema pin, no ceremony. Run
`dotclaude handoff doctor` for a sanity check; see
`references/prerequisites.md` for the full install matrix.

## Repo layout

Each handoff is a branch:

```
handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>
```

e.g. `handoff/dotclaude/claude/2026-04/aaaa1111`. The store needs no
setup beyond "be a reachable git repo"; `main` is never touched by
`push` / `fetch` / `remote-list`. GitHub UI + `git ls-remote` render
the branches directly.

## Auto-trigger contract

When the user message matches any of these patterns, run `pull` (local
cross-agent digest) by default:

- Resume-command fragments: `claude --resume <uuid>`,
  `claude --resume "<name>"`, `copilot --resume=<uuid>`,
  `codex resume <uuid>`, `codex resume <name>`.
- Natural language: "what was that session about", "continue in X",
  "switch to X", "handoff".

Extract the `<id>` from the user message (UUID, short UUID, or named
alias). The skill probes all three roots — no `--from` argument needed.
If the query is missing or ambiguous, ask one clarifying question before
proceeding.

## Out of scope

- **Invoking the target CLI directly.** The skill prints; the user
  pastes. This is deliberate — keeps the transfer auditable and
  prevents unintended cross-session execution.
- **End-to-end encryption.** The git transport is access-controlled
  by the host (private repo + push-side auth), but content is stored
  in plaintext on the remote. Every `push` runs the scrubber before
  uploading and reports `[scrubbed N secrets]` as the final stdout
  line; the push fails closed (exit 2, no commit written) if the
  scrubber cannot run. Scrubbing is a best-effort pattern pass (see
  `references/redaction.md`) — do not rely on it to catch bespoke
  or obfuscated secrets.
- **Fuzzy or semantic search.** `search` is substring/regex only.
- **Persistent indexing.** Grep-at-query-time is fast enough for
  local session volumes; revisit only if p95 exceeds ~2s.

## Deprecated aliases

The following forms are deprecated as of 0.12.0 and removed in 0.14.0.
They still function but emit a stderr warning on every invocation.

| Old form                      | New form                     |
| ----------------------------- | ---------------------------- |
| `describe <cli> <id>`         | `pull <id> --summary`        |
| `describe <cli> <id> --json`  | `pull <id> --summary --json` |
| `digest <cli> <id>`           | `pull <id>`                  |
| `file <cli> <id>`             | `pull <id> -o auto`          |
| `pull <query>` (remote fetch) | `fetch <query>`              |

Set `DOTCLAUDE_QUIET=1` to suppress deprecation stderr in CI pipelines
that cannot update callers immediately. Real errors (exit 2 / exit 64)
are never suppressed.
