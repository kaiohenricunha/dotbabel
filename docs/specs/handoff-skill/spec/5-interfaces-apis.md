# §5 — Interfaces and APIs

> Tight, table-driven contract. Frozen schemas + flag matrices + exit-code
> matrices + output formats + the SKILL.md auto-trigger contract +
> bootstrap/doctor user-facing strings. ARCH-10's drift-test asserts
> against the symbol list in this section, not against `--help` prose.

## 5.0 What this section locks vs. what it leaves open

| Locked here                                                         | Editable without spec amendment                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Command names (`pull` / `push` / `fetch` / supporting four)         | The wording of `--help` prose                                    |
| Flag names, types, defaults, mandatory-when                         | Tone / phrasing of stderr templates beyond the listed prefix     |
| Exit codes per command + stderr **prefix** template                 | Internal stage names within the prefix                           |
| `metadata.json` field names + types + character classes             | Field documentation phrasing                                     |
| `handoff:v2:…` description grammar                                  | n/a (frozen)                                                     |
| `<handoff>` block grammar (attribute list + section order)          | Wording inside the Summary / Next-step lines (within length cap) |
| `<query>` valid forms                                               | n/a (frozen)                                                     |
| TSV candidate-list column order                                     | n/a (frozen)                                                     |
| SKILL.md auto-trigger phrase → binary form mapping                  | The wording of natural-language phrases (additions allowed)      |
| Bootstrap interactive prompt **structure** + manual-setup block     | Decorative whitespace / leading icons (`✓`)                      |
| `doctor` output structure (success / `ok (unconfigured)` / failure) | Diagnostic-line wording                                          |

## 5.1 Frozen schemas

These are persistent on-disk state in users' remote stores (or wire
formats consumed by external agents). Any change here is a migration
problem, not a documentation problem.

### 5.1.1 `metadata.json`

Written into every `handoff/...` branch's tree by `push`. Read by `fetch`,
`list --remote`, `describe --remote-id`, and the collision probe.

```jsonc
{
  "cli":            "claude" | "copilot" | "codex",
  "session_id":     <uuid string> | null,
  "short_id":       <8 lowercase hex chars>,
  "cwd":            <absolute path string> | null,
  "project":        <slug>,
  "month":          "YYYY-MM",
  "hostname":       <slug>,
  "created_at":     <ISO-8601 UTC, "Z" suffix>,
  "scrubbed_count": <integer ≥ 0>,
  "tags":           [<slug>, ...],
  "tag":            <first slug> | null   // DEPRECATED — see migration note
}
```

| Field            | Type    | Required         | Character class / shape                  | Notes                                                     |
| ---------------- | ------- | ---------------- | ---------------------------------------- | --------------------------------------------------------- |
| `cli`            | string  | yes              | enum `claude` \| `copilot` \| `codex`    | source CLI                                                |
| `session_id`     | string  | yes (since 0.10) | UUID `[0-9a-f]{8}-[0-9a-f]{4}-…`         | null only for legacy branches; collision probe gates push |
| `short_id`       | string  | yes              | `[0-9a-f]{8}`                            | first 8 hex of `session_id`                               |
| `cwd`            | string  | yes              | absolute path or null                    | null when source session has no cwd record                |
| `project`        | string  | yes              | `[a-z0-9-]{1,40}`                        | slugified from cwd top-level; "adhoc" if unresolvable     |
| `month`          | string  | yes              | `[0-9]{4}-[0-9]{2}`                      | UTC month bucket at push time                             |
| `hostname`       | string  | yes              | `[a-z0-9-]{1,40}`                        | slugified from `hostname()` short form                    |
| `created_at`     | string  | yes              | ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SS.sssZ` | reflects this push, not session start                     |
| `scrubbed_count` | integer | yes              | `≥ 0`                                    | redactions applied during this push                       |
| `tags`           | array   | yes              | `[<slug>, ...]` each `[a-z0-9-]{1,40}`   | possibly empty array `[]`                                 |
| `tag`            | string  | yes (deprecated) | first element of `tags` or null          | dropped after 0.13.0 (see Migration §6.5)                 |

**Forward-compatibility rule.** New fields may be added in additive
patch releases without spec amendment provided they are optional and
old readers ignore unknowns gracefully. Removing or changing a field's
type **does** require a spec amendment.

### 5.1.2 `handoff:v2:…` description grammar

Used in three places: the branch's commit message, the branch's
`description.txt`, and (read-only) any v1 legacy decoder in the wild.

**Grammar (BNF-ish):**

```
description    = "handoff:v2:" project ":" cli ":" month ":" short ":" host
                 [ ":" tag-list ]
project        = slug                          ; [a-z0-9-]{1,40}
cli            = "claude" | "copilot" | "codex"
month          = 4*DIGIT "-" 2*DIGIT            ; YYYY-MM
short          = 8*HEXDIG                       ; lowercase
host           = slug                          ; [a-z0-9-]{1,40}
tag-list       = slug *("," slug)               ; comma-joined, no trailing comma
slug           = 1*40(LOWER-ALNUM | "-")
                 ; ASCII lowercase a-z, 0-9, hyphen; max 40 chars
```

**Lexical rules (frozen):**

| Rule | Description                                                                               |
| ---- | ----------------------------------------------------------------------------------------- |
| L-1  | All segments are lowercased ASCII; uppercase rejected by the encoder (slugify).           |
| L-2  | `:` is the segment delimiter and is **illegal** inside any segment.                       |
| L-3  | `,` is the within-tag-list delimiter and is **illegal** inside any other segment.         |
| L-4  | Any segment exceeding 40 chars is truncated by `slugify()`; encoder never emits > 40.     |
| L-5  | Empty segments are invalid (no `::` runs).                                                |
| L-6  | Trailing `:` (no tags) is invalid; if `tag-list` is empty, the trailing `:` is omitted.   |
| L-7  | The leading literal `handoff:v2:` is the schema-version pin; bumping to `v3` requires an  |
|      | additive decoder and a spec amendment.                                                    |
| L-8  | Hostnames containing characters outside `[a-z0-9-]` (spaces, dots, capitals — common on   |
|      | Mac default hostnames like "Kaio's MacBook.local") are slugified upstream by the encoder. |

**Decode error mode.** Any input failing the grammar exits 2 from
`handoff-description.sh decode` with stderr:

```
handoff-description: malformed v2: <reason>
```

where `<reason>` is one of: `too many colon segments`, `missing required
segment`, `cli not one of claude|copilot|codex (<got>)`, `month not YYYY-MM
(<got>)`, `short-id not 8 hex chars`, `<segment> slug fails charset`,
`tag segment fails charset`. The decoder also accepts v1 legacy input
(`handoff:v1:<cli>:<short>:<project>:<host>[:<tag>]`) for read-only paths
(`fetch`, `remote-list`); encoders only emit v2.

### 5.1.3 `<handoff>` block grammar

The rendered output of `pull`, the persisted body of `handoff.md` in
each branch, and the stdout of `fetch`. **External agents parse this
when the user pastes it.** Grammar drift breaks consumer parsing.

```
<handoff origin="<cli>" session="<short>" cwd="<cwd-or-empty>">

**Summary.** <one-sentence summary, ≤ 400 chars>

**User prompts (last 10, in order).**

1. <prompt 1, ≤ 300 chars, `…` if truncated>
2. <prompt 2, ≤ 300 chars>
…
10. <prompt 10, ≤ 300 chars>

**Last assistant turns (tail).**

> <turn 1, ≤ 400 chars per line, multi-line `\n> ` prefixed>

> <turn 2, ≤ 400 chars per line>

> <turn 3, ≤ 400 chars per line>

**Next step.** <single generic line, fixed text per ARCH-2>

</handoff>
```

**Attribute rules (frozen):**

| Attribute | Required                | Value                                       | Notes                                           |
| --------- | ----------------------- | ------------------------------------------- | ----------------------------------------------- |
| `origin`  | yes                     | `claude` \| `copilot` \| `codex`            | source CLI                                      |
| `session` | yes                     | 8 lowercase hex chars (the source short_id) | empty string when no session_id was extractable |
| `cwd`     | yes (attribute present) | absolute path or empty string               | empty string when source had no cwd             |

No other attributes are emitted. Adding new attributes requires a spec
amendment + ARCH-10 drift-test update. The previous `target=…` attribute
is removed (target is implicit per ARCH-2).

**Section rules (frozen):**

| #   | Section heading                         | Body shape                                                 |
| --- | --------------------------------------- | ---------------------------------------------------------- |
| 1   | `**Summary.**`                          | one sentence, ≤ 400 chars                                  |
| 2   | `**User prompts (last 10, in order).**` | 1-indexed numbered list, last 10 prompts, ≤ 300 chars each |
| 3   | `**Last assistant turns (tail).**`      | block-quote `> …`, last 3 turns, ≤ 400 chars each          |
| 4   | `**Next step.**`                        | single fixed line (per ARCH-2 generic next-step text)      |

**Empty-content fallbacks (frozen):**

- No prompts: `1. (session contained no user prompts)`.
- No turns: `_(session contained no assistant turns)_` in place of the quote block.

**Generic Next-step line (frozen text):**

```
Continue from the last assistant turn using the same file scope and goals summarized above.
```

This is the single line emitted regardless of source or target CLI. No
per-target variants exist.

## 5.2 Per-command flag matrix

### 5.2.1 `pull <query> [flags]`

| Flag           | Type       | Default | Mandatory when | Notes                                                                  |
| -------------- | ---------- | ------- | -------------- | ---------------------------------------------------------------------- |
| `<query>`      | positional | n/a     | always         | UUID / 8-hex short / `latest` / Claude customTitle / Codex thread_name |
| `--from <cli>` | string     | (none)  | optional       | narrow to one root; values: `claude` \| `copilot` \| `codex`           |
| `--limit <N>`  | integer    | 20      | optional       | turns extraction tail length                                           |

No `--to`. No `--json`. No `--out-dir`. No environment-variable detection.

### 5.2.2 `push [<query>] [flags]`

| Flag                | Type               | Default | Mandatory when                  | Notes                                                                      |
| ------------------- | ------------------ | ------- | ------------------------------- | -------------------------------------------------------------------------- |
| `[<query>]`         | positional         | (none)  | mandatory unless `--from` given | session resolution input                                                   |
| `--from <cli>`      | string             | (none)  | mandatory if `<query>` absent   | per ARCH-3                                                                 |
| `--tag <label>`     | string, repeatable | (none)  | optional                        | multi-tag via repeat (`--tag a --tag b`) **or** comma-joined (`--tag a,b`) |
| `--force-collision` | bool               | false   | optional                        | override different-session-id-on-same-short-id error                       |
| `--dry-run`         | bool               | false   | optional                        | render+scrub+probe, skip remote write                                      |
| `--verify`          | bool               | false   | optional                        | extra preflight checks before push                                         |
| `--verbose`         | bool               | false   | optional                        | extra debug output on stderr                                               |

No `--to`. No env-var detection.

### 5.2.3 `fetch <query> [flags]`

| Flag           | Type       | Default | Mandatory when | Notes                                                                                     |
| -------------- | ---------- | ------- | -------------- | ----------------------------------------------------------------------------------------- |
| `<query>`      | positional | n/a     | always         | tag / 8-hex short / branch-suffix / commit prefix / description substring                 |
| `--from <cli>` | string     | (none)  | optional       | filter candidates whose `<cli>` segment matches; values: `claude` \| `copilot` \| `codex` |
| `--limit <N>`  | integer    | 20      | optional       | candidate cap before bailing with "too many candidates, narrow the query"                 |

No `--to`. No `--json` (output is the `<handoff>` block, already a structured contract per 5.1.3).

### 5.2.4 Supporting commands

#### `list [flags]`

Unified table of local sessions and remote handoffs. Source of truth for "what's available before I `pull` or `fetch`."

| Flag          | Type    | Default | Notes                                                         |
| ------------- | ------- | ------- | ------------------------------------------------------------- |
| `--local`     | bool    | false   | local-only (mutually exclusive with `--remote`)               |
| `--remote`    | bool    | false   | remote-only (mutually exclusive with `--local`)               |
| `--limit <N>` | integer | 50      | row cap; applies independently to local and remote            |
| `--json`      | bool    | false   | emit JSON array `[{location, cli, short_id, when, ...}, ...]` |

#### `search <text> [flags]`

Substring/regex match across **local** session content (no remote search; remote uses `fetch` substring match instead). Resolves "I forgot the UUID but remember the topic."

| Flag          | Type       | Default | Notes                                                     |
| ------------- | ---------- | ------- | --------------------------------------------------------- |
| `<text>`      | positional | n/a     | regex, case-insensitive by default                        |
| `--cli <cli>` | string     | (none)  | narrow to one root                                        |
| `--limit <N>` | integer    | 50      | row cap                                                   |
| `--json`      | bool       | false   | emit JSON array of `{cli, short_id, cwd, mtime, snippet}` |

(`--since <ISO>` deferred — month-bucket prefix in branch naming is the cheap filter; revisit only if usage shows monthly granularity is too coarse.)

#### `describe <query> [flags]`

Preview a session's metadata + last 10 user prompts without rendering the full `<handoff>` block.

| Flag           | Type       | Default | Notes                                        |
| -------------- | ---------- | ------- | -------------------------------------------- |
| `<query>`      | positional | n/a     | same forms as `pull`'s `<query>`             |
| `--from <cli>` | string     | (none)  | narrow to one root                           |
| `--json`       | bool       | false   | emit `{origin: <meta>, user_prompts: [...]}` |

#### `doctor`

Verify the remote transport is reachable; no flags.

## 5.3 Exit-code matrix

ADR 0013 (referenced from `docs/repo-facts.json`) pins the exit-code domain
to `{0, 1, 2, 64}`. This section maps each code to the conditions per
command and locks the **prefix** of the stderr template.

### 5.3.1 Universal codes

| Code | Meaning                                                                 | Stderr prefix                                                                                                        |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0    | success                                                                 | (none)                                                                                                               |
| 1    | preflight check failed (recoverable)                                    | `Preflight failed: <reason>` followed by `What's wrong:` / `How to fix:` block (existing `handoff-doctor.sh` format) |
| 2    | runtime error (resolution miss, transport failure, scrub failure, etc.) | `dotclaude-handoff: <reason>`                                                                                        |
| 64   | usage error (unknown flag, missing positional, conflicting flags)       | `dotclaude-handoff: <reason>` followed by `Usage: …` block                                                           |

### 5.3.2 `pull`-specific exits

| Code | Condition                                | Stderr template                                                                    |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| 2    | no session matches (no `--from`)         | `dotclaude-handoff: no session matches: <query>`                                   |
| 2    | no session matches (with `--from <cli>`) | `dotclaude-handoff: no <cli> session matches: <query>`                             |
| 2    | multiple sessions match (non-TTY)        | header `dotclaude-handoff: multiple sessions match "<query>":` + TSV lines (5.3.5) |
| 64   | unknown flag                             | `dotclaude-handoff: unknown flag: <flag>` + usage                                  |
| 64   | missing `<query>`                        | `dotclaude-handoff: pull requires a <query>` + usage                               |

When `--from <cli>` is set the no-match message is narrowed to the requested
CLI ("no `<cli>` session matches"), giving a clearer diagnostic when the user
has scoped the lookup. The unnarrowed form remains the contract for union
lookups (no `--from`). Both forms are stable public output (#136).

### 5.3.3 `push`-specific exits

| Code | Condition                                                                  | Stderr template                                                                                                                                    |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | transport not configured (env unset, non-TTY)                              | `dotclaude-handoff: transport not configured` + manual-setup block (5.5.2)                                                                         |
| 2    | scrub fail-closed                                                          | `dotclaude-handoff: scrub not applied: <reason>`                                                                                                   |
| 2    | short-id collision, different session_id                                   | `dotclaude-handoff: short-id collision on <branch>: local-session=<X> remote-session=<Y>; rerun with --force-collision to override`                |
| 2    | metadata.json missing on existing branch (legacy + no `--force-collision`) | `dotclaude-handoff: short-id collision on <branch>: existing branch has no provable owner (<git error>); rerun with --force-collision to override` |
| 64   | no `<query>` and no `--from`                                               | `dotclaude-handoff: push: --from required when no <query> is given` + usage                                                                        |
| 64   | unknown flag                                                               | `dotclaude-handoff: unknown flag: <flag>` + usage                                                                                                  |

### 5.3.4 `fetch`-specific exits

| Code | Condition                                 | Stderr template                                                                    |
| ---- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| 2    | transport not configured                  | `dotclaude-handoff: transport not configured` + "run push first" hint              |
| 2    | no remote handoffs match                  | `dotclaude-handoff: no remote handoffs match: <query>`                             |
| 2    | multiple handoffs match (non-TTY)         | header `dotclaude-handoff: multiple handoffs match "<query>":` + TSV lines (5.3.5) |
| 2    | too many description-substring candidates | `dotclaude-handoff: too many candidates, narrow the query`                         |
| 64   | unknown flag                              | `dotclaude-handoff: unknown flag: <flag>` + usage                                  |
| 64   | missing `<query>`                         | `dotclaude-handoff: fetch requires a <query>` + usage                              |

### 5.3.5 TSV candidate-list format (frozen column order)

Both `pull` and `fetch` emit candidate lines on multi-match (non-TTY).
Column order is fixed; tools parsing this format can rely on field positions.

| Command | Columns (tab-separated, in order)                     |
| ------- | ----------------------------------------------------- |
| `pull`  | `<cli>`, `<session_id>`, `<absolute-path>`, `<query>` |
| `fetch` | `<branch>`, `<commit>`, `<description>`, `<query>`    |

One candidate per line. No header row in the TSV (the human-readable
header line above the TSV is plain prose, ignored by parsers). Fields
are guaranteed not to contain literal tabs (resolver / git outputs are
controlled).

## 5.4 `<query>` valid forms (cross-cutting)

Frozen across `pull`, `push`, `fetch`, `describe`:

| Form                       | Lexical                                                        | Notes                                       |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Full UUID                  | `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` | exact match on session id                   |
| Short UUID                 | `[0-9a-f]{8}`                                                  | first 8 hex of session id                   |
| Literal `latest`           | exactly the string `latest`                                    | newest by mtime in target root(s)           |
| Claude `customTitle` alias | non-hex string ≤ 256 chars                                     | scanned via `customTitle` JSONL records     |
| Codex `thread_name` alias  | non-hex string ≤ 256 chars                                     | scanned via `event_msg.thread_name` records |
| Tag (fetch only)           | `[a-z0-9-]{1,40}`                                              | matches description tag segment             |
| Branch suffix (fetch only) | partial branch path                                            | trailing-`/<short>` match against ls-remote |
| Commit prefix (fetch only) | `[0-9a-f]{4,40}`                                               | matches commit hash prefix in ls-remote     |

**`latest` resolution precedence** (`--from` > detected host > cross-root union): when `--from` is omitted, the binary checks environment signals (`CLAUDECODE=1`, any `COPILOT_*`, `CODEX`) to detect the host CLI and narrows to that root. When the host is undetectable, it falls back to cross-root union — the newest session by mtime across all three roots.

Copilot has **no** alias support; UUID / short / `latest` only (per
`handoff-resolve.sh:151`). Claude does; Codex does.

## 5.5 SKILL.md auto-trigger contract (testable)

The skill markdown's `## Auto-trigger contract` section MUST list the
phrase → invocation mapping below. ARCH-10's drift-test asserts:

1. Every phrase pattern in SKILL.md maps to a known binary form in §5.2.
2. Every primary form in §5.2 is reachable by at least one phrase pattern.
3. The `--from` filling rule is documented identically in SKILL.md, the
   binary's `--help`, and `docs/handoff-guide.md`.

### 5.5.1 Phrase-pattern → binary-form mapping (frozen)

| Trigger phrase pattern                                                 | Binary invocation                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| `handoff` + identifier (UUID / short / `latest` / alias)               | `dotclaude handoff pull <id>`                              |
| `continue in <cli>` / `switch to <cli>` / `pull from <cli>` + id       | `dotclaude handoff pull <id> --from <cli>`                 |
| `claude --resume <id>` / `codex resume <id>` / `copilot --resume=<id>` | `dotclaude handoff pull <id>`                              |
| `what was that session about` + identifier                             | `dotclaude handoff describe <id>`                          |
| `push handoff` / `send to other machine` / `save this`                 | `dotclaude handoff push --from <host-cli> [--tag <label>]` |
| `pull handoff` / `fetch handoff` / `continue from yesterday's machine` | `dotclaude handoff fetch <query-or-prompt-user>`           |

### 5.5.2 The `--from` filling rule (frozen text)

The skill markdown MUST contain this paragraph (the drift-test uses a
four-clause structural match — presence of `--from`, `push`, a "no
query" marker, and a "required" marker — per spec §5.0 which keeps
wording editable while enforcing semantics):

> When invoking `dotclaude handoff push` without a `<query>` positional,
> include `--from <your-cli>` where `<your-cli>` is the agent the host
> LLM is running in (`claude` for Claude Code, `copilot` for GitHub
> Copilot CLI, `codex` for Codex). The binary requires this flag in
> that mode and will exit 64 without it.

### 5.5.3 Out-of-trigger flags

`--limit`, `--json`, `--force-collision`, `--dry-run`, `--verify`,
`--verbose` are **not** part of the skill auto-trigger contract.
Direct/scripted callers may pass them; the host LLM does not.

## 5.6 Bootstrap & doctor user-facing strings

### 5.6.1 Bootstrap interactive prompts (structure frozen, decoration editable)

Locked structure (✓ icons, exact whitespace are decoration; reorderable but each line semantic must appear):

```
DOTCLAUDE_HANDOFF_REPO is not set — dotclaude can set this up for you.

  Detected: gh CLI authenticated as @<login>.
  Plan: create private repo  <login>/<name>
        persist URL to       <config-file>

  Repo name? [dotclaude-handoff-store] █
  Create <login>/<name> and proceed? [y/N] █
  ✓ created <login>/<name>             ; or "✓ repo <login>/<name> already exists — reusing"
  ✓ wrote <config-file>
    (add `source <config-file>` to ~/.bashrc or ~/.zshrc to persist across shells)
```

The prompts MUST gate on (a) detected `gh` login, (b) repo-name confirmation,
(c) create-or-reuse confirmation. No silent creates.

### 5.6.2 Manual-setup block (printed when bootstrap can't proceed)

```
Can't auto-bootstrap the handoff store: <reason>

Set it up manually:
  1. gh repo create <you>/dotclaude-handoff-store --private
  2. export DOTCLAUDE_HANDOFF_REPO=git@github.com:<you>/dotclaude-handoff-store.git
  3. dotclaude handoff push   # retries

Alternative providers (GitLab, Gitea, self-hosted) work too — set
DOTCLAUDE_HANDOFF_REPO to any ssh://, git@, https://, file://, or absolute path.
```

`<reason>` is one of: `not running in an interactive terminal`,
``\`gh\` CLI is not on PATH — install it from https://cli.github.com/``,
``\`gh\` is not authenticated — run \`gh auth login\` (scopes: repo)``,
`could not read GitHub username via \`gh api user\``,
`configured repo is unreachable (<url>) and we can't prompt in non-interactive mode`.

### 5.6.3 `doctor` output format

| Outcome                                                      | Stdout                                                        | Exit |
| ------------------------------------------------------------ | ------------------------------------------------------------- | ---- |
| All checks pass, env configured, repo reachable              | `ok` + diagnostic lines (config / gh / repo URL)              | 0    |
| Env unset, gh authenticated (bootstrap will succeed on push) | `ok (unconfigured)` + diagnostic lines + bootstrap-ready hint | 0    |
| Any check fails                                              | (none — failure block on stderr)                              | 1    |

Diagnostic-line shape (frozen):

```
config: <path-or-"(not written yet — first push will create it)">
gh: <"authenticated" | "installed, not authenticated" | "not installed">
DOTCLAUDE_HANDOFF_REPO: <url-or-"(unset — will bootstrap on first push)">
```

Failure block shape (frozen, on stderr):

```
Preflight failed: <reason>

  What's wrong: <diagnosis>
  How to fix:
    1. <command>
    2. <command>

  Workaround: <alternative>

Rerun /handoff doctor to verify.
```

## 5.7 Output-format summary per primary command

| Command    | Stdout (success)                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `pull`     | `<handoff>...</handoff>` block per 5.1.3 + trailing newline                                                     |
| `push`     | four lines: `<branch>` / `<repo-url>` / `<description>` / `[scrubbed N secrets]`                                |
| `fetch`    | `<handoff>...</handoff>` block per 5.1.3 (read verbatim from `handoff.md` in the resolved branch)               |
| `list`     | markdown table (default) or JSON array (`--json`); empty: `No sessions found` + exit 0                          |
| `search`   | markdown table + drill-in hint (default) or JSON array (`--json`); empty: `No sessions matching '<q>'` + exit 0 |
| `describe` | markdown summary (default) or `{origin: <meta>, user_prompts: [...]}` (`--json`)                                |
| `doctor`   | per 5.6.3                                                                                                       |

## 5.8 Cross-references

- §3 ARCH-10 enforces drift-detection across SKILL.md, `--help`, and `docs/handoff-guide.md`. The symbol-list under test is exactly what 5.2 + 5.3 + 5.5 freeze.
- §4 KD-1 / KD-2 are the policy decisions; §5 is the wire-format and surface contract that implements them.
- §6 sequences the migration including the `metadata.tag` deprecation cycle (one release, then drop) and the SKILL.md trigger-mapping rewrite.
- §7 attaches non-functional targets (push / fetch / list latencies, store-growth ceilings) to specific commands above.
- §8 captures risks: schema-bump migration, encoder/decoder version drift, the deprecated `metadata.tag` window.
