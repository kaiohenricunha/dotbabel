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
  Copilot CLI, OpenAI Codex CLI). Reads a source session transcript by UUID
  and produces either an inline summary or a paste-ready handoff digest for
  another agent. Use when switching agents mid-task or recovering context.
  Triggers on: "handoff", "transfer context", "continue in codex",
  "continue in claude", "continue in copilot", "switch to codex",
  "switch to claude", "what was that session about",
  "claude --resume", "copilot --resume", "codex resume",
  "find the session where", "search sessions", "which session did I".
argument-hint: "<sub-cmd> [<source-cli>] <uuid|latest|query> [--to <target-cli>] [--cli <cli>]"
tools: Glob, Read, Grep, Bash, Write
effort: medium
model: sonnet
---

# Handoff — Cross-CLI Session Context Transfer

Locate a session transcript from one agentic CLI and hand its context to
another. Supports three source CLIs (`claude`, `copilot`, `codex`) and
the same three as targets. The skill never invokes a different CLI
itself — it produces a summary or a paste-ready block the user drops
into the target agent.

## Arguments

- `$0` — sub-command: `describe`, `digest`, `file`, `list`, or `search`.
  If not provided and the skill is auto-triggered, default to `describe`.
- `$1` — positional varies by sub-command:
  - `describe` / `digest` / `file` / `list` → source CLI
    (`claude`, `copilot`, `codex`).
  - `search` → the query string (regex).
- `$2` — session identifier: a UUID or the literal `latest`. Required for
  `describe`, `digest`, `file`. Ignored for `list` and `search`.
- `--to <target-cli>` — optional; tunes the digest voice for the target
  agent. Defaults to `claude` since that is the most common consumer in
  this repo.
- `--cli <cli>` — `search` only; restrict the scan to one CLI.
- `--since <ISO>` — `search` only; skip sessions older than this date.
  Default: 30 days ago.
- `--limit <N>` — `search` only; max rows in the hit table. Default: 20.

---

## Auto-trigger contract

When the user message matches any of these patterns and the skill fires
without explicit sub-command, run `describe` by default:

- Literal resume-command fragments: `claude --resume <uuid>`,
  `copilot --resume=<uuid>`, `codex resume <uuid>`.
- Natural-language: "what was that session about", "continue in
  <cli>", "switch to <cli>", "handoff".

Extract `<cli>` and `<uuid>` from the user message. If either is missing,
ask a single clarifying question before proceeding.

---

## Sub-Commands

### `describe <cli> <uuid|latest>`

Print an inline 2–4 sentence summary of the session plus the verbatim
user prompts. Use when the user asks "what was that about" and nothing
more.

**Steps:**

1. Resolve the session file. Load the per-CLI reference:
   - `claude` → `references/claude-code.md`
   - `copilot` → `references/copilot.md`
   - `codex` → `references/codex.md`
2. Apply the `latest` resolver if the identifier is `latest`, otherwise
   locate the file by UUID using the path pattern in that reference.
3. If no file is found, output exactly:

   ```
   No <cli> session found for '<identifier>'
   ```

   and stop.

4. Run the per-CLI `jq` filters from the reference to extract:
   - session meta (cwd, model, timestamp)
   - all user turns, verbatim, in order
   - all assistant turns (kept in memory for summary only; do not print)
5. Render the output as:

   ```markdown
   **<cli>** `<short-uuid>` — `<cwd>` — <started-at>

   **User prompts:**

   - <prompt 1>
   - <prompt 2>

   **Summary:** <2–4 sentences of what the session was about>
   ```

### `digest <cli> <uuid|latest> [--to <target-cli>]`

Print a paste-ready handoff block. Use when the user wants to carry the
context into a different agent.

**Steps:**

1. Run steps 1–4 from `describe`.
2. Build the normalized digest described in
   `references/digest-schema.md`.
3. Print the digest wrapped in a single `<handoff>...</handoff>` block
   so the target agent can recognize and ingest it as one unit. Do not
   print any commentary before or after the block.

### `file <cli> <uuid|latest> [--to <target-cli>]`

Same as `digest`, but also write the rendered markdown to
`docs/handoffs/<YYYY-MM-DD>-<cli>-<short-uuid>.md` using `Write`. The
`<handoff>` block goes at the top of the file; a human-readable summary
follows. Print only the written path to stdout.

If `docs/handoffs/` does not exist in the current repo, fall back to
`~/.claude/handoffs/`. Do not create `docs/handoffs/` outside of a git
repo.

### `list <cli>`

List sessions for the given CLI, newest first.

**Steps:**

1. Enumerate sessions using the per-CLI path pattern.
2. For each session, extract the short UUID (first 8 chars), mtime, and
   session meta cwd.
3. Render as a table:

   ```markdown
   | UUID (short) | cwd | last modified |
   | ------------ | --- | ------------- |
   ```

4. If no sessions found, output:

   ```
   No <cli> sessions found
   ```

### `search <query> [--cli <cli>] [--since <ISO>] [--limit <N>]`

Scan transcripts across one or all CLIs for a substring/regex match and
return a ranked list of candidate sessions. Use when you remember what a
session was about but not its UUID. Chain into `describe <cli> <uuid>`
on the chosen row.

**Steps:**

1. Resolve the search roots. If `--cli` is given, use only the matching
   root; otherwise scan all three:
   - `claude` → `~/.claude/projects/`
   - `copilot` → `~/.copilot/session-state/`
   - `codex` → `~/.codex/sessions/`
2. Compute the `--since` cutoff. Default: 30 days ago. Use
   `find <root> -name '<pattern>' -newermt "<cutoff>"` to pre-filter by
   mtime. Per-CLI patterns:
   - claude: `*.jsonl` under `~/.claude/projects/*/`
   - copilot: `events.jsonl` under `~/.copilot/session-state/*/`
   - codex: `rollout-*.jsonl` under `~/.codex/sessions/*/*/*/`
3. **Raw pass (fast filter).** Run
   `rg -l -i --no-messages -e '<query>' <file-list>` to get the
   candidate-file list. This hits JSON-escaped content too; that's
   fine — it's a superset we refine in the next step.
4. **Clean pass (snippet extraction).** For each candidate file, apply
   the CLI's user+assistant `jq` filter from the corresponding reference
   in `references/` (see `claude-code.md`, `copilot.md`, `codex.md`),
   then `rg -i -m 1 -C 0 '<query>'` over the extracted text so the full
   matching line is available for snippet construction. If the clean
   pass yields no hit, **drop the file** — the raw match was in
   tool-use payloads or metadata (almost always noise). For codex, drop
   any snippet whose source turn is an `<environment_context>` block.
5. For each surviving candidate, extract:
   - `cli` (inferred from root)
   - short UUID (first 8 chars; for claude/codex parse from filename,
     for copilot parse from the parent dir name)
   - `cwd` (from session meta using the per-CLI filter)
   - `mtime` (from `stat`)
   - snippet — prefer the first user-prompt match; else first
     assistant match. Prefix with `user: ` or `asst: `. Truncate to 80
     chars with `…`.
6. Sort by `mtime` desc. Truncate to `--limit` (default 20).
7. Render:

   ```markdown
   | CLI     | Short UUID | cwd         | Last modified    | Match                      |
   | ------- | ---------- | ----------- | ---------------- | -------------------------- |
   | copilot | 1be89762   | /home/kaioh | 2026-04-17 20:21 | user: "copilot --resume=…" |

   Drill in with `/handoff describe <cli> <uuid>`.
   ```

8. If no candidates survive, output exactly:

   ```
   No sessions matching '<query>'
   ```

**Query-handling rules:**

- `<query>` is passed to `rg` as a regex. Shell-special characters the
  user typed verbatim should be single-quoted when shelling out.
- Case-insensitive by default (`-i`). The caller can opt out with an
  explicit `(?-i)` inline flag in the regex.
- Do not expand `~` inside the query — only inside the root paths.

---

## Error handling

- Unknown sub-command → print usage line and stop.
- Unknown source CLI → print the three supported values and stop.
- Malformed UUID → treat as a literal and let the resolver return
  "not found" rather than guessing.
- Missing `jq` on PATH → fall back to reading the JSONL with `Read` and
  parsing in-memory. Note the fallback only in human-readable output
  modes (`describe`, `list`, `search`). Do not emit any extra stdout for
  `digest`; for `file`, stdout must remain path-only — if a fallback
  note is needed, place it in the written markdown body after the
  `<handoff>` block.

## Out of scope

- Invoking the target CLI directly. The skill prints, the user pastes.
- Secret redaction. The caller is responsible for not passing sensitive
  transcripts through `file` or `search` output.
- Fuzzy or semantic search. `search` is substring/regex only. If a user
  wants semantic retrieval, direct them to the raw transcripts.
- Persistent indexing. Grep-at-query-time is fast enough for local
  session volumes; revisit only if p95 exceeds ~2s.
