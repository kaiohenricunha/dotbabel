# OpenAI Codex CLI — session transcript reference

Codex CLI stores one JSONL "rollout" file per session under a
date-partitioned tree. The UUID is the same value passed to
`codex resume <uuid>`.

## Path layout

```
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
```

Examples:

```
~/.codex/sessions/2026/04/17/rollout-2026-04-17T20-20-43-019d9dbf-27e3-7661-b189-9ced5a55bd2f.jsonl
```

## Locating a session

**By UUID** — search recursively (the date path is not known up front):

```bash
find ~/.codex/sessions -type f -name "rollout-*-<uuid>.jsonl" 2>/dev/null
```

**By thread alias (`codex resume <name>`)** — when the user renames a
thread, Codex records an `event_msg` with
`payload.thread_name = "<name>"`. Scan rollouts for the match:

```bash
for f in $(find ~/.codex/sessions -type f -name 'rollout-*.jsonl'); do
  jq -r --arg name "<name>" '
    select(.type == "event_msg" and .payload.thread_name == $name)
    | input_filename' "$f" 2>/dev/null | head -1
done | head -1
```

Reference implementation:
`plugins/dotclaude/scripts/handoff-resolve.sh codex <alias>`.

**Latest** — newest rollout by mtime (GNU/BSD portable):

```bash
find ~/.codex/sessions -type f -name 'rollout-*.jsonl' 2>/dev/null \
  | xargs -I{} sh -c \
    'stat -c "%Y %n" "{}" 2>/dev/null || stat -f "%m %N" "{}" 2>/dev/null' \
  | sort -rn | head -1 | awk '{print $2}'
```

**List** — all rollouts newest first, with session metadata:

```bash
find ~/.codex/sessions -type f -name 'rollout-*.jsonl' 2>/dev/null \
  | xargs -I{} sh -c \
    'stat -c "%Y %n" "{}" 2>/dev/null || stat -f "%m %N" "{}" 2>/dev/null' \
  | sort -rn
```

## Record schema

Each record has `timestamp`, `type`, `payload`.

Relevant `type` values:

- `session_meta` — one per session, first record; carries cwd, cli
  version, model provider, and base instructions
- `event_msg` — lifecycle events (task_started, response_generated, etc.)
  keyed by `.payload.type`
- `response_item` — actual conversation turns, keyed by
  `.payload.type` (typically `message`) and `.payload.role`
- `turn_context` — per-turn configuration

## Extraction filters

### Session metadata

```bash
jq -c 'select(.type == "session_meta") | .payload
  | {id, cwd, cli_version, model_provider, timestamp}' <file> | head -1
```

`payload.base_instructions.text` holds the full system prompt. Do not
inline it in the digest — it is large and rarely useful to a target
agent.

### User prompts

```bash
jq -r 'select(.type == "response_item"
             and .payload.type == "message"
             and .payload.role == "user")
       | .payload.content[0].text' <file>
```

The first user record is usually an `<environment_context>` block.
Filter it out when rendering prompts for humans:

```bash
jq -r 'select(.type == "response_item"
             and .payload.type == "message"
             and .payload.role == "user")
       | .payload.content[0].text
       | select(test("^<environment_context>") | not)' <file>
```

### Assistant turns

```bash
jq -r 'select(.type == "response_item"
             and .payload.type == "message"
             and .payload.role == "assistant")
       | .payload.content[0].text' <file>
```

### Tool calls

Codex emits tool calls as `response_item` records with a non-`message`
payload type:

```bash
jq -c 'select(.type == "response_item" and .payload.type != "message")
       | .payload | {type, name, arguments}' <file>
```

### Task lifecycle

```bash
jq -c 'select(.type == "event_msg") | .payload | {type, turn_id}' <file>
```

## Content search (clean pass)

For `/handoff search`, raw `rg` over rollouts matches inside
`base_instructions.text` (the entire Codex system prompt, ~10k chars)
and tool-call payloads. Always extract clean turn text first:

```bash
jq -r '
  select(.type == "response_item"
         and .payload.type == "message"
         and (.payload.role == "user" or .payload.role == "assistant"))
  | .payload.role as $r
  | .payload.content[0].text
  | select(test("^<environment_context>") | not)
  | "\($r):\t" + .
' <file> | rg -i -m 1 '<query>'
```

The `<environment_context>` filter is important: every Codex session's
first user turn is an auto-generated block with cwd/shell/timezone, and
searching for common words like `bash` or a username matches every
session without it.

## Notes

- Codex sessions routinely exceed 100k lines because tool-call output
  is logged inline. For the `describe` sub-command, truncate the
  assistant transcript to the last ~20 turns before summarizing.
- `payload.content` is always an array. `content[0].text` is the
  common case but probe with `content | length` before trusting it.
- `cwd` in `session_meta` is the cwd at session start; if the user ran
  `cd` mid-session, later `event_msg` records reflect the updated cwd.
