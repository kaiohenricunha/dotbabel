---
id: handoff
name: handoff
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [documentation, debugging]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-04-17
updated: 2026-04-18
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
argument-hint: "[<query>|push|pull|list] [<query>] [--tag <label>]"
tools: Glob, Read, Grep, Bash, Write
effort: medium
model: sonnet
---

# Handoff — Cross-CLI Session Context Transfer

Locate a session transcript from any agentic CLI and hand its context
to another. Source CLI is auto-detected from the identifier; target CLI
is wherever you run the command. The skill never invokes a different
CLI itself — it produces a paste-ready `<handoff>` block the user drops
into the target agent.

## Arguments

**The five forms (primary public surface):**

```
/handoff                              push host's latest session
/handoff <query>                      local cross-agent: emit <handoff>
/handoff push [<query>] [--tag <l>]   upload to transport
/handoff pull [<query>]               fetch from transport
/handoff list [--local|--remote]      unified table
```

Equivalent from any shell (including Codex's bash tool):
`!dotclaude handoff …` with the same arguments.

`<query>` auto-detects the source CLI across all three roots
(`~/.claude/projects`, `~/.copilot/session-state`, `~/.codex/sessions`).
It accepts:

- full UUID (36 chars)
- short UUID (first 8 hex)
- the literal `latest` (newest by mtime across every root)
- Claude `customTitle` alias (set via `claude --resume "<name>"`,
  stored as a `custom-title` JSONL record)
- Codex `thread_name` alias (set via `codex resume <name>`, stored as
  an `event_msg` record)

**Collision model.** When a `<query>` matches in two or more roots (or
matches two remote handoffs on `pull`), behavior depends on stdin:

- TTY → skill prompts interactively for a pick.
- Non-TTY → exits 2 with a TSV candidate list on stderr (one line per
  candidate: `<cli>\t<session-id>\t<path>\t<query>`).

**Power-user sub-commands** (optional, only when you need them):

- `resolve <cli> <id>` — print the absolute JSONL path.
- `describe <cli> <id>` — inline summary (markdown or `--json`).
- `digest <cli> <id>` — full `<handoff>` block for paste (no transport).
- `file <cli> <id>` — write a markdown doc to `docs/handoffs/`.

Each takes an explicit `<cli>` (`claude`, `copilot`, `codex`) and an
identifier. These remain reachable for scripting.

- `--to <target-cli>` — optional; tunes the `<handoff>` block's
  next-step wording for a specific target agent. Defaults to the
  auto-detected host CLI (`CLAUDECODE=1` → `claude`, any `CODEX_*` →
  `codex`, any `COPILOT_*` → `copilot`), falling back to `claude`
  when no host signal is present. Mostly redundant for in-place use.
- `--from <cli>` — `push`, `pull`, and bare `<query>` paths; narrows
  auto-detection to one root (`claude`, `copilot`, or `codex`). Use
  when short-UUID prefixes collide across roots, or when scripting
  and the source CLI is known. Without `--from`, the resolver probes
  all three roots; with `--from`, only the named root is consulted.
- `--cli <cli>` — `search` and `remote-list` only; restrict the scan
  to one CLI.
- `--since <ISO>` — `search` and `remote-list` only; skip entries older
  than this date. Default: 30 days ago.
- `--limit <N>` — `search` and `remote-list` only; max rows in the
  output table. Default: 20.
- `--include-transcript` — `push` only; also uploads the last 50 turns
  of the raw session transcript. Off by default to minimise secret
  leakage blast radius.
- `--tag <label>` — `push` only; human-readable label appended to the
  branch description and stored in `metadata.json.tag`. Useful to
  distinguish parallel handoffs from the same session.
- `--from-file <path>` — `pull` only; skip the transport and load a
  local markdown file previously written by `file` (or any file
  containing a `<handoff>...</handoff>` block). Works offline.

### Prerequisites

Only the remote sub-commands (`push`, `pull`, `remote-list`) require
external tooling; local sub-commands continue to need only `jq` and
the session files on disk.

The remote transport is a user-owned private git repository (any
provider — GitHub, GitLab, Gitea, self-hosted). Prerequisites:

- `git` on PATH.
- A pre-existing private repo whose URL lives in
  `DOTCLAUDE_HANDOFF_REPO` (no default — must be set; example:
  `git@github.com:<user>/handoff-store.git`).
- Working SSH or credential-helper auth to that repo.

Run `/handoff doctor` at any time to verify prerequisites and get a
platform-specific remediation block. Full install matrix and
workarounds live in `references/prerequisites.md`.

---

## Auto-trigger contract

When the user message matches any of these patterns and the skill fires
without an explicit form, run the bare `<query>` path (local
cross-agent digest) by default:

- Literal resume-command fragments: `claude --resume <uuid>`,
  `claude --resume "<name>"`, `copilot --resume=<uuid>`,
  `codex resume <uuid>`, `codex resume <name>`.
- Natural-language: "what was that session about", "continue in X",
  "switch to X", "handoff".

Extract the `<query>` from the user message (a UUID, short UUID, or
named alias). No CLI argument is needed — the skill probes all three
roots. If the query is missing or ambiguous, ask a single clarifying
question before proceeding.

---

## Sub-Commands

### `describe <cli> <uuid|latest|alias>`

Print an inline 2–4 sentence summary of the session plus the verbatim
user prompts. Use when the user asks "what was that about" and nothing
more.

For the deterministic path (resolve + extract), prefer the bundled
shell scripts:

- `plugins/dotclaude/scripts/handoff-resolve.sh <cli> <id>` — returns
  the absolute JSONL path, supports UUID, short-UUID, `latest`, and
  (codex only) thread-name aliases.
- `plugins/dotclaude/scripts/handoff-extract.sh meta <cli> <file>` —
  emits a JSON metadata object.
- `plugins/dotclaude/scripts/handoff-extract.sh prompts <cli> <file>` —
  emits clean user prompts with CLI-specific noise filtered out.

For a fully-packaged CLI interface, invoke
`dotclaude-handoff describe <cli> <id>` (same pattern, no skill load
required — useful from Codex).

**Steps (skill-interpreted fallback if the scripts are unavailable):**

1. Resolve the session file. Load the per-CLI reference:
   - `claude` → `references/claude-code.md`
   - `copilot` → `references/copilot.md`
   - `codex` → `references/codex.md`
2. Apply the `latest` resolver if the identifier is `latest`; for codex
   an alias (non-hex identifier) triggers a `thread_name` scan; otherwise
   locate the file by UUID using the path pattern in the reference.
3. If no file is found, output exactly:

   ```
   No <cli> session found for '<identifier>'
   ```

   and stop.

4. Run the per-CLI `jq` filters from the reference to extract:
   - session meta (cwd, model, timestamp); for copilot, fall back to
     `workspace.yaml` when `session.start.cwd` is null
   - all user turns, verbatim, in order, with CLI-specific noise filtered
     (see the reference for the exclusion list)
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
     assistant match. Prefix with "user: " or "asst: ". Truncate to 80
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

### `push [<query>] [--from <cli>] [--to <target-cli>] [--include-transcript] [--tag <label>]`

Upload a handoff digest to the remote git transport so the context
can be resumed on a different machine. Use when switching
laptops/distros and you need the next agent on the other side to
pick up the thread.

The `<cli>` positional was removed in v0.8.0. Resolution now
auto-detects across all three roots; narrow with `--from <cli>` when
scripting or when short-UUID collisions demand a specific root.

**Steps:**

1. Run `/handoff doctor` preflight. On failure, print the
   remediation block and stop — do not touch the transport.
2. Resolve the session file. With no `<query>`, fall back to the
   host-detected CLI's "latest" session (or the union across all
   roots when no host signal is present); emit a single stderr line
   naming the fallback that fired. With `<query>`, use the `any`
   entry point unless `--from <cli>` narrows the scan. Then run the
   per-CLI reference's `jq` filters (steps 1–4 of `describe`).
3. Build the normalized digest per `references/digest-schema.md`,
   tuned by `--to`.
4. Build `metadata.json` with these keys:
   `cli`, `session_id`, `short_id`, `cwd`, `hostname`,
   `git_remote` (if `$CWD` is inside a git repo — use
   `git config --get remote.origin.url`, else `null`),
   `created_at` (ISO-8601 UTC), `scrubbed_count` (int),
   `schema_version` (always `"1"`), `tag` (string or `null`).
5. Pipe the rendered digest through the scrubbing pass. Patterns and
   replacement semantics live in `references/redaction.md`. The
   reusable implementation is
   `plugins/dotclaude/scripts/handoff-scrub.sh` (stdin→stdout, prints
   the redaction count on stderr in the form `scrubbed:<N>`). Store
   the count in `metadata.json.scrubbed_count`.
6. If `--include-transcript` is set, build `transcript.jsonl` from
   the last 50 turns of the raw session JSONL, then run the same
   scrubbing pass over it.
7. Encode the description by calling
   `plugins/dotclaude/scripts/handoff-description.sh encode
--cli <cli> --short-id <short_id> --project <project-slug>
--hostname <hostname> [--tag <tag>]`. The script prints the
   `handoff:v1:...` string on stdout. Description schema:
   `handoff:v1:<cli>:<short-uuid>:<project-slug>:<hostname>[:<tag>]`.
8. Push to `$DOTCLAUDE_HANDOFF_REPO` on a branch named
   `handoff/<cli>/<short-uuid>`. Commit message is the encoded
   description; commit contents are `handoff.md`, `metadata.json`,
   and `description.txt` (and `transcript.jsonl` when
   `--include-transcript` is set).
9. Print to stdout, one field per line:

   ```text
   <branch-name>
   <repo-url>
   Scrubbed <N> secrets
   ```

   No other commentary. If the push failed, print the exact error
   and exit non-zero.

### `pull [<handle>] [--to <target-cli>] [--from-file <path>]`

Fetch a previously pushed handoff and render the `<handoff>` block
for the target agent. Use when you sat down at the other machine
and want to continue.

The `<cli>` positional was removed in v0.8.0. Bare `pull` (no
`<handle>`) fetches the newest handoff on the transport; provide a
`<handle>` (fuzzy substring over tag/short-UUID/project/hostname or
the explicit `handoff/<cli>/<short>` branch name) to pick a specific
one. Use `--from <cli>` to restrict the candidate pool to one
source-CLI's branches when the transport holds handoffs from
multiple hosts.

**Steps:**

1. If `--from-file` is set, read the file, extract the
   `<handoff>...</handoff>` block, tune `next_step_suggestion` for
   `--to`, print, and stop. This is the offline path.
2. Otherwise run `/handoff doctor` preflight. On failure, print the
   remediation block plus the `--from-file` suggestion and stop.
3. Resolve the handle:
   - Explicit branch name `handoff/<cli>/<short>` → use as-is.
   - Fuzzy substring → match against branch names and decoded
     descriptions; on collision, prompt (TTY) or exit 2 with the
     candidate list (non-TTY).
   - `latest` → call `remote-list --limit 1` (optionally filtered by
     `--from <cli>`) and take the first row's branch.
4. Shallow-clone the repo and `git show
handoff/<cli>/<short-uuid>:handoff.md` (the file written by
   `push`).
5. Tune `next_step_suggestion` for `--to` per
   `references/digest-schema.md`.
6. Print the `<handoff>...</handoff>` block, unchanged otherwise,
   with no commentary before or after.

### `remote-list [--cli <cli>] [--since <ISO>] [--limit <N>]`

List recent handoffs on the transport, newest first. Useful when
you forgot which one to pull or want a scrollback.

**Steps:**

1. Run `/handoff doctor` preflight. On failure, print the
   remediation block and stop.
2. Enumerate remote entries: `git ls-remote $DOTCLAUDE_HANDOFF_REPO
'handoff/*'` followed by a sort pass by committer-date (shallow
   fetch of refs meta only).
3. Filter to descriptions starting with `handoff:v1:`. If `--cli` is
   set, additionally require the third colon-segment to match.
4. Decode each row with
   `plugins/dotclaude/scripts/handoff-description.sh decode
"<description>"` → JSON fields.
5. Apply `--since` (default 30 days ago) and truncate to `--limit`
   (default 20).
6. Render a table:

   ```markdown
   | Branch | CLI | Short UUID | Project | Hostname | Tag | Updated |
   | ------ | --- | ---------- | ------- | -------- | --- | ------- |
   ```

7. If zero rows survive, print exactly:

   ```text
   No handoffs found
   ```

### `doctor`

Run the preflight prerequisite checks without touching the
transport. Prints an exact remediation block on failure. Use to
verify setup before the first `push` or on a fresh machine.

**Steps:**

1. Invoke `plugins/dotclaude/scripts/handoff-doctor.sh`. The script
   takes no arguments and returns:
   - exit 0 on success, printing `ok` on stdout.
   - exit non-zero on failure, printing a structured remediation
     block of the form documented in
     `references/prerequisites.md`.
2. Do not emit any additional commentary. The script output is the
   contract.

The script enumerates: `git` on PATH, `DOTCLAUDE_HANDOFF_REPO`
present and pointing at a reachable repo (`git ls-remote $repo
HEAD`), and clock sanity (warn only).

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
- Secret redaction for local-only sub-commands (`describe`, `digest`,
  `file`, `list`, `search`). The caller is responsible for not passing
  sensitive transcripts through those outputs. Redaction IS applied
  on `push` because the payload leaves the machine.
- End-to-end encryption. Scrubbing is best-effort pattern matching.
  The git transport is access-controlled by the host (private repo on
  GitHub/GitLab/Gitea/etc.), but content is stored in plaintext on the
  remote — do not push transcripts that contain secrets you rely on
  scrubbing to catch.
- Fuzzy or semantic search. `search` is substring/regex only. If a user
  wants semantic retrieval, direct them to the raw transcripts.
- Persistent indexing. Grep-at-query-time is fast enough for local
  session volumes; revisit only if p95 exceeds ~2s.
- Auto-bootstrapping the `git-fallback` repo. The user creates the
  private `handoff-store` repo once, out of band. `doctor` detects its
  absence and points at the docs.
