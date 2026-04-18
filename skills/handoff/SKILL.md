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
  a paste-ready handoff digest, a written markdown file, or a private
  GitHub gist that another machine can pull. Use when switching agents
  mid-task, recovering context, or moving between Windows/Linux/macOS
  setups. Triggers on: "handoff", "transfer context",
  "continue in codex", "continue in claude", "continue in copilot",
  "switch to codex", "switch to claude", "what was that session about",
  "claude --resume", "copilot --resume", "codex resume",
  "find the session where", "search sessions", "which session did I",
  "push handoff", "pull handoff", "handoff to other machine",
  "resume on my other laptop".
argument-hint: "<sub-cmd> [<source-cli>] <uuid|latest|query|handle> [--to <target-cli>] [--via <transport>] [--cli <cli>]"
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

- `$0` — sub-command: `describe`, `digest`, `file`, `list`, `search`,
  `push`, `pull`, `remote-list`, or `doctor`. If not provided and the
  skill is auto-triggered, default to `describe`.
- `$1` — positional varies by sub-command:
  - `describe` / `digest` / `file` / `list` / `push` → source CLI
    (`claude`, `copilot`, `codex`).
  - `search` → the query string (regex).
  - `pull` → a handle (gist ID, gist URL, or the literal `latest`).
  - `remote-list` / `doctor` → no positional argument.
- `$2` — session identifier: a UUID or the literal `latest`. Required for
  `describe`, `digest`, `file`, `push`. Ignored for `list`, `search`,
  `pull`, `remote-list`, `doctor`.
- `--to <target-cli>` — optional; tunes the digest voice for the target
  agent. Defaults to `claude` since that is the most common consumer in
  this repo.
- `--cli <cli>` — `search` and `remote-list` only; restrict the scan
  to one CLI.
- `--since <ISO>` — `search` and `remote-list` only; skip entries older
  than this date. Default: 30 days ago.
- `--limit <N>` — `search` and `remote-list` only; max rows in the
  output table. Default: 20.
- `--via <transport>` — `push`, `pull`, `remote-list`, `doctor` only.
  Values: `github` (default, uses `gh gist`), `gist-token` (uses a
  `DOTCLAUDE_GH_TOKEN` PAT directly), `git-fallback` (uses raw `git`
  against a user-owned private repo). See
  `references/transport-github.md` for transport details.
- `--include-transcript` — `push` only; also uploads the last 50 turns
  of the raw session transcript. Off by default to minimise secret
  leakage blast radius.
- `--tag <label>` — `push` only; human-readable label appended to the
  gist description and stored in `metadata.json.tag`. Useful to
  distinguish parallel handoffs from the same session.
- `--from-file <path>` — `pull` only; skip the transport and load a
  local markdown file previously written by `file` (or any file
  containing a `<handoff>...</handoff>` block). Works offline.

### Prerequisites

Only the remote sub-commands (`push`, `pull`, `remote-list`) require
external tooling; local sub-commands continue to need only `jq` and
the session files on disk.

- `push` / `pull` / `remote-list` with `--via github` → `gh` CLI on
  PATH, authenticated (`gh auth status`) with the `gist` scope.
- `push` / `pull` / `remote-list` with `--via gist-token` → `curl` on
  PATH and `DOTCLAUDE_GH_TOKEN` environment variable set to a PAT
  with `gist` scope.
- `push` / `pull` / `remote-list` with `--via git-fallback` → `git`
  on PATH, a pre-existing user-owned private repo whose URL lives in
  `DOTCLAUDE_HANDOFF_REPO` (no default — must be set; example:
  `git@github.com:<user>/handoff-store.git`), and working SSH or
  credential-helper auth to that repo.

Run `/handoff doctor --via <transport>` at any time to verify
prerequisites and get a platform-specific remediation block. Full
install matrix and workarounds live in
`references/prerequisites.md`.

---

## Auto-trigger contract

When the user message matches any of these patterns and the skill fires
without explicit sub-command, run `describe` by default:

- Literal resume-command fragments: `claude --resume <uuid>`,
  `copilot --resume=<uuid>`, `codex resume <uuid>`.
- Natural-language: "what was that session about", "continue in
  \<cli\>", "switch to \<cli\>", "handoff".

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

### `push <cli> <uuid|latest> [--to <target-cli>] [--via <transport>] [--include-transcript] [--tag <label>]`

Upload a handoff digest to a remote transport so the context can be
resumed on a different machine. Use when switching laptops/distros
and you need the next agent on the other side to pick up the thread.

**Steps:**

1. Run `/handoff doctor --via <transport>` preflight. On failure,
   print the remediation block and stop — do not touch the transport.
2. Run steps 1–4 of `describe` to resolve the session file, load
   the per-CLI reference, and run the `jq` filters.
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
7. Encode the gist description by calling
   `plugins/dotclaude/scripts/handoff-description.sh encode
--cli <cli> --short-id <short_id> --project <project-slug>
--hostname <hostname> [--tag <tag>]`. The script prints the
   `handoff:v1:...` string on stdout. Description schema:
   `handoff:v1:<cli>:<short-uuid>:<project-slug>:<hostname>[:<tag>]`.
8. Upload via the chosen transport (see
   `references/transport-github.md` for the exact commands per
   `--via` value):
   - `--via github` → `gh gist create --desc "<description>" ...`
     with `handoff.yaml`, `metadata.json`, and optional
     `transcript.jsonl`.
   - `--via gist-token` → `curl -H "Authorization: token
$DOTCLAUDE_GH_TOKEN" https://api.github.com/gists` with the
     same payload.
   - `--via git-fallback` → branch + commit + push to
     `$DOTCLAUDE_HANDOFF_REPO`, branch name
     `handoff/<cli>/<short-uuid>`.
9. Print to stdout, one field per line:

   ```text
   <gist-id-or-branch-name>
   <gist-url-or-repo-ref>
   Scrubbed <N> secrets
   ```

   No other commentary. If the transport failed, print the exact
   error plus the `--via <alt>` fallback suggestion from
   `references/transport-github.md`, then exit non-zero.

### `pull <handle|latest> [--to <target-cli>] [--via <transport>] [--from-file <path>]`

Fetch a previously pushed handoff and render the `<handoff>` block
for the target agent. Use when you sat down at the other machine
and want to continue.

**Steps:**

1. If `--from-file` is set, read the file, extract the
   `<handoff>...</handoff>` block, tune `next_step_suggestion` for
   `--to`, print, and stop. This is the offline / gh-less path.
2. Otherwise run `/handoff doctor --via <transport>` preflight. On
   failure, print the remediation block plus the `--from-file`
   suggestion and stop.
3. Resolve the handle:
   - Literal gist ID (hex) → use as-is.
   - URL like `https://gist.github.com/<user>/<id>` → extract the
     id with a simple regex.
   - `latest` → call `remote-list --limit 1 --via <transport>`
     (optionally filtered by `--cli`) and take the first row's id.
4. Fetch the gist contents:
   - `--via github` → `gh gist view <id> --filename handoff.yaml --raw`.
   - `--via gist-token` → `curl -s -H "Authorization: token
$DOTCLAUDE_GH_TOKEN"
https://api.github.com/gists/<id>` and read
     `.files["handoff.yaml"].content`.
   - `--via git-fallback` → shallow-clone the repo, `git show
handoff/<cli>/<short-uuid>:handoff.yaml`.
5. Tune `next_step_suggestion` for `--to` per
   `references/digest-schema.md`.
6. Print the `<handoff>...</handoff>` block, unchanged otherwise,
   with no commentary before or after.

### `remote-list [--via <transport>] [--cli <cli>] [--since <ISO>] [--limit <N>]`

List recent handoffs on the transport, newest first. Useful when
you forgot which one to pull or want a scrollback.

**Steps:**

1. Run `/handoff doctor --via <transport>` preflight. On failure,
   print the remediation block and stop.
2. Enumerate remote entries:
   - `--via github` → `gh api '/gists?per_page=100'` (the `gist list`
     subcommand lacks `--json`, so we use the REST API directly;
     filter `.public == false` to exclude public gists).
   - `--via gist-token` → `curl -s -H "Authorization: token
$DOTCLAUDE_GH_TOKEN"
https://api.github.com/gists?per_page=100`.
   - `--via git-fallback` → `git ls-remote
$DOTCLAUDE_HANDOFF_REPO 'handoff/*'` with a sort pass by
     committer-date (shallow fetch of refs meta only).
3. Filter to descriptions starting with `handoff:v1:`. If `--cli` is
   set, additionally require the third colon-segment to match.
4. Decode each row with
   `plugins/dotclaude/scripts/handoff-description.sh decode
"<description>"` → JSON fields.
5. Apply `--since` (default 30 days ago) and truncate to `--limit`
   (default 20).
6. Render a table:

   ```markdown
   | Gist ID | CLI | Short UUID | Project | Hostname | Tag | Updated |
   | ------- | --- | ---------- | ------- | -------- | --- | ------- |
   ```

7. If zero rows survive, print exactly:

   ```text
   No handoffs found on <transport>
   ```

### `doctor [--via <transport>]`

Run the preflight prerequisite checks without touching the
transport. Prints an exact remediation block on failure. Use to
verify setup before the first `push` or on a fresh machine.

**Steps:**

1. Select the transport (`--via`, default `github`).
2. Invoke `plugins/dotclaude/scripts/handoff-doctor.sh <transport>`.
   The script returns:
   - exit 0 on success, printing a single-line `ok: <transport>`
     summary.
   - exit non-zero on failure, printing a structured remediation
     block of the form documented in
     `references/prerequisites.md`.
3. Do not emit any additional commentary. The script output is the
   contract.

The script enumerates: `gh` on PATH, `gh auth status -h
github.com`, the `gist` OAuth scope (via `gh api user -i`), network
reach (`gh api /`), and clock sanity (warn only). For
`gist-token`, it checks `DOTCLAUDE_GH_TOKEN` presence and calls
`GET /user` to confirm the token is valid. For `git-fallback`, it
checks `git` on PATH and `git ls-remote $DOTCLAUDE_HANDOFF_REPO`
reachability.

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
- End-to-end encryption. Scrubbing is best-effort pattern matching;
  private gists are URL-visible and not encrypted at rest. Do not push
  transcripts that contain secrets you rely on scrubbing to catch.
- Fuzzy or semantic search. `search` is substring/regex only. If a user
  wants semantic retrieval, direct them to the raw transcripts.
- Persistent indexing. Grep-at-query-time is fast enough for local
  session volumes; revisit only if p95 exceeds ~2s.
- Auto-bootstrapping the `git-fallback` repo. The user creates the
  private `handoff-store` repo once, out of band. `doctor` detects its
  absence and points at the docs.
