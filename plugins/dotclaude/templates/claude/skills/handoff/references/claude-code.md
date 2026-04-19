# Claude Code — session transcript reference

Claude Code stores one JSONL file per session under a per-project
directory derived from the session's cwd.

## Path layout

```
~/.claude/projects/<project-slug>/<session-id>.jsonl
```

- `<project-slug>` — the session cwd with `/` replaced by `-` and the
  leading `/` preserved (e.g. `/home/kaioh/projects/kaiohenricunha/dotclaude`
  → `-home-kaioh-projects-kaiohenricunha-dotclaude`).
- `<session-id>` — a UUID v4. Matches the value a user passes to
  `claude --resume <uuid>`.

## Locating a session

**By UUID** — the project slug is not known up front, so search across all
project dirs:

```bash
find ~/.claude/projects -maxdepth 2 -type f -name '<uuid>.jsonl' 2>/dev/null
```

**Latest** — newest `.jsonl` across all project dirs by mtime (GNU/BSD
portable):

```bash
find ~/.claude/projects -maxdepth 2 -type f -name '*.jsonl' 2>/dev/null \
  | xargs -I{} sh -c \
    'stat -c "%Y %n" "{}" 2>/dev/null || stat -f "%m %N" "{}" 2>/dev/null' \
  | sort -rn | head -1 | awk '{print $2}'
```

**List** — all sessions grouped by project, newest first:

```bash
find ~/.claude/projects -maxdepth 2 -type f -name '*.jsonl' 2>/dev/null \
  | xargs -I{} sh -c \
    'stat -c "%Y %n" "{}" 2>/dev/null || stat -f "%m %N" "{}" 2>/dev/null' \
  | sort -rn
```

## Record schema

JSONL, one record per line. Relevant top-level types:

- `user` — user message, content in `.message.content`
- `assistant` — model message, content in `.message.content`
- `system` — environment/system-reminder records
- `attachment`, `pr-link`, `file-history-snapshot` — ancillary

Every record carries `sessionId`, `cwd`, and `version`.

### Extract session metadata

```bash
jq -r 'select(.cwd) | {cwd, sessionId, version}' <file> | head -1
```

## Extraction filters

### User prompts (verbatim, in order)

`.message.content` is an array of content blocks. Text lives in blocks
with `type == "text"`:

```bash
jq -r 'select(.type == "user") | .message.content
  | if type == "string" then . else (map(select(.type == "text") | .text) | join("\n")) end' <file>
```

**Noise exclusions.** Claude JSONL carries many synthetic "user" records
that are not real human prompts: hook outputs, system reminders,
slash-command echoes, task-notification polling, and tool results.
Drop any prompt whose first non-whitespace content starts with:

- `<local-command-caveat>` — caveat wrapper for local-command input
- `<command-name>`, `<command-message>`, `<command-args>` — slash-command echoes
- `<stdin>` — interactive input wrapper
- `<system-reminder>` — injected reminders
- `<user-prompt-submit-hook>` — hook payloads
- `<task-notification>`, `</task-notification>`, `<task-id>` — task-monitor polling
- `<summary>Monitor event` — monitor-event summary
- `<event>` — raw monitor events
- `If this event is something the user` — monitor heuristic preamble

Reference implementation: `plugins/dotclaude/scripts/handoff-extract.sh
prompts claude <file>`.

### Assistant turns (text only)

```bash
jq -r 'select(.type == "assistant") | .message.content
  | (map(select(.type == "text") | .text) | join("\n"))' <file>
```

### Tool calls the assistant made

```bash
jq -c 'select(.type == "assistant") | .message.content
  | map(select(.type == "tool_use") | {name, input})' <file>
```

### Files the session touched

Scan tool-use inputs for absolute paths:

```bash
jq -r 'select(.type == "assistant") | .message.content[]
  | select(.type == "tool_use")
  | .input | (.file_path // .path // empty)' <file> | sort -u
```

## Content search (clean pass)

For `/handoff search`, raw `rg` over the JSONL gives a superset — JSON
escapes and system-reminder boilerplate match noisily. Re-filter by
extracting user+assistant text first:

```bash
jq -r '
  select((.type == "user" or .type == "assistant") and (.isSidechain | not))
  | .type as $role
  | .message.content
  | if type == "string" then "\($role):\t\(.)"
    else empty end,
    ( if type == "array" then
        (map(select(.type == "text") | .text) | join("\n"))
          | select(length > 0)
          | "\($role):\t\(.)"
      else empty end )
' <file> | rg -i -m 1 '<query>'
```

## Notes

- The first few records of a session are `summary`, `system`, or an
  initial environment `system-reminder`. User prompts usually start
  from record 2 onward.
- `isSidechain: true` records come from sub-agents (the `Agent` tool).
  Filter them out if you only want the top-level conversation:
  add `and (.isSidechain | not)` to the filter. The search clean-pass
  already does this.
