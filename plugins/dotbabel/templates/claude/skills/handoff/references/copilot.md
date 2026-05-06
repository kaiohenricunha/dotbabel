# GitHub Copilot CLI — session transcript reference

Copilot CLI stores one directory per session under
`~/.copilot/session-state/`, keyed by UUID. The UUID is the same value
passed to `copilot --resume=<uuid>`.

## Path layout

```
~/.copilot/session-state/<uuid>/
  events.jsonl      # the full event stream (messages, tool calls, hooks)
  workspace.yaml    # session workspace metadata
  checkpoints/      # snapshots taken at checkpoints
  files/            # file payloads the session attached
  research/         # research artifacts produced mid-session
```

## Locating a session

**By UUID** — direct path:

```
~/.copilot/session-state/<uuid>/events.jsonl
```

**Latest** — newest session dir by mtime of its `events.jsonl` (GNU/BSD
portable):

```bash
find ~/.copilot/session-state -maxdepth 2 -name events.jsonl 2>/dev/null \
  | xargs -I{} sh -c \
    'stat -c "%Y %n" "{}" 2>/dev/null || stat -f "%m %N" "{}" 2>/dev/null' \
  | sort -rn | head -1 | awk '{print $2}'
```

**List** — all sessions newest first:

```bash
find ~/.copilot/session-state -maxdepth 2 -name events.jsonl 2>/dev/null \
  | xargs -I{} sh -c \
    'stat -c "%Y %n" "{}" 2>/dev/null || stat -f "%m %N" "{}" 2>/dev/null' \
  | sort -rn
```

## Event schema

Each record has `type`, `id`, `parentId`, `timestamp`, `data`.

Relevant `type` values:

- `session.start`, `session.resume`, `session.shutdown`
- `session.model_change`
- `user.message` — user prompt; content in `.data.content`
- `assistant.message` — model response; content in `.data` (varies)
- `assistant.turn_start`, `assistant.turn_end`
- `tool.execution_start`, `tool.execution_complete`
- `hook.start`, `hook.end`
- `system.message`

## Extraction filters

### Session metadata (cwd, model)

```bash
jq -r 'select(.type == "session.start") | .data | {cwd, model, sessionId}' <file> | head -1
```

**Mandatory `workspace.yaml` fallback.** Real Copilot sessions commonly
emit `"cwd": null` on `session.start`; the authoritative value lives in
the sibling `workspace.yaml` (same session dir). If the `jq` filter
above returns a null or empty `cwd`, parse `workspace.yaml`:

```bash
awk -F': ' '$1 == "cwd" { sub(/^[^:]*: */, ""); print; exit }' \
  "$(dirname <file>)/workspace.yaml"
```

Same pattern for `model`. Reference implementation:
`plugins/dotbabel/scripts/handoff-extract.sh meta copilot <file>`.

### User prompts

```bash
jq -r 'select(.type == "user.message") | .data.content' <file>
```

Note: `.data.transformedContent` wraps the prompt with system-reminder
boilerplate. Always prefer `.data.content` for the clean user text.

### Assistant turns

```bash
jq -r 'select(.type == "assistant.message") | .data' <file>
```

The `.data` object varies by Copilot version. Probe with:

```bash
jq 'select(.type == "assistant.message") | .data | keys' <file> | head -1
```

Current versions use `.data.text` or `.data.content` for the
user-visible response.

### Tool calls

```bash
jq -c 'select(.type == "tool.execution_start") | .data | {tool, input}' <file>
```

### Model transitions

```bash
jq -c 'select(.type == "session.model_change") | .data' <file>
```

## Content search (clean pass)

For `/handoff search`, raw `rg` matches JSON escapes and
`transformedContent` boilerplate. Extract clean text first:

```bash
jq -r '
  if .type == "user.message" then "user:\t" + (.data.content // "")
  elif .type == "assistant.message" then
    "asst:\t" + (.data.text // .data.content // (.data | tostring))
  else empty end
' <file> | rg -i -m 1 '<query>'
```

Do not search `.data.transformedContent` — it wraps the raw prompt with
system-reminder boilerplate and produces false positives.

## Notes

- Copilot sessions can span multiple model changes in one transcript;
  the digest should note the model(s) used, not just the first one.
- The `research/` sibling dir often holds the most important context
  (extracted facts, code-walkthrough notes). Mention its presence in
  the digest if non-empty.
- `checkpoints/` entries can be sizable; do not inline them into the
  digest — reference the path only.
