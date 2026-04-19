#!/usr/bin/env bash
# handoff-extract.sh — CLI-aware extractor for session transcripts.
#
# Usage:
#   handoff-extract.sh meta    <cli> <file>
#   handoff-extract.sh prompts <cli> <file>
#   handoff-extract.sh turns   <cli> <file> [N]
#
# cli:   claude | copilot | codex
# file:  absolute path to the session JSONL (from handoff-resolve.sh)
# N:     optional limit for `turns` (default: 20)
#
# Subcommands:
#   meta      emits a single JSON object with:
#               {cli, session_id, short_id, cwd, model, started_at}
#             Copilot: if session.start.cwd is null, reads the sibling
#             workspace.yaml as a fallback.
#   prompts   emits user prompts newline-separated, in order, with
#             CLI-specific noise filtered out (Claude: system-reminders,
#             command-name, tool_result; Codex: environment_context).
#   turns     emits assistant text turns newline-separated, last N only.
#
# Exits:
#   0  success
#   2  file-not-found / parse error
#   64 usage error

set -euo pipefail

die_usage() { printf 'handoff-extract: %s\n' "$1" >&2; exit 64; }
die_runtime() { printf 'handoff-extract: %s\n' "$1" >&2; exit 2; }

usage() {
  cat <<'EOF' >&2
usage: handoff-extract.sh <meta|prompts|turns> <claude|copilot|codex> <file> [N]
EOF
  exit 64
}

require_file() {
  [[ -f "$1" ]] || die_runtime "file not found: $1"
}

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# ISO-8601 UTC mtime of a file (portable: GNU date first, BSD fallback).
file_iso_mtime() {
  local file="$1"
  date -u -r "$file" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file")" +%Y-%m-%dT%H:%M:%SZ
}

# -- claude ---------------------------------------------------------------

meta_claude() {
  local file="$1"
  # Prefer a record with a cwd (the common case). Slurp-and-first via
  # `jq -n '[inputs]|.[0]'` to avoid SIGPIPE on long transcripts.
  # Fallback chain: any record with sessionId → UUID parsed from filename.
  local base started_at fallback_id=""
  base=$(basename "$file" .jsonl)
  if [[ "$base" =~ $UUID_RE ]]; then
    fallback_id="$base"
  fi
  started_at=$(file_iso_mtime "$file")

  jq -n -c \
    --arg cli "claude" \
    --arg fallback_id "$fallback_id" \
    --arg started_at "$started_at" \
    '
    def nonempty: select(. != null and . != "");
    [inputs] as $r
    | (($r | map(select(.cwd | (. // "") != "")) | .[0]) // {}) as $with_cwd
    | (($r | map(select(.sessionId != null)) | .[0].sessionId) // $fallback_id) as $sid
    | {
        cli: $cli,
        session_id: ($sid | nonempty // null),
        short_id: ($sid | (.[:8] | nonempty) // null),
        cwd: ($with_cwd.cwd | (. // "") | nonempty // null),
        model: null,
        version: ($with_cwd.version | (. // "") | nonempty // null),
        started_at: ($started_at | nonempty // null)
      }
    ' "$file" 2>/dev/null
}

# Claude user prompts, scrubbed of system/command/tool noise.
# Content may be string OR array of content blocks.
prompts_claude() {
  local file="$1"
  jq -r '
    select(.type == "user")
    | .message.content
    | if type == "string" then
        .
      else
        (map(select(.type == "text") | .text) | join("\n"))
      end
    | select(length > 0)
  ' "$file" 2>/dev/null \
    | awk '
        # Claude JSONL carries many synthetic "user" records that are not
        # actual human prompts: hook outputs, system reminders, slash-command
        # echoes, task-notification polling, etc. Drop any record whose
        # first non-whitespace content starts with one of these markers.
        {
          trimmed = $0
          sub(/^[[:space:]]+/, "", trimmed)
          if (trimmed == "") next
          if (trimmed ~ /^<local-command-caveat>/) next
          if (trimmed ~ /^<command-name>/) next
          if (trimmed ~ /^<command-message>/) next
          if (trimmed ~ /^<command-args>/) next
          if (trimmed ~ /^<stdin>/) next
          if (trimmed ~ /^<system-reminder>/) next
          if (trimmed ~ /^<user-prompt-submit-hook>/) next
          if (trimmed ~ /^<task-notification>/) next
          if (trimmed ~ /^<task-id>/) next
          if (trimmed ~ /^<summary>Monitor event/) next
          if (trimmed ~ /^<\/task-notification>/) next
          if (trimmed ~ /^<event>/) next
          if (trimmed ~ /^If this event is something the user/) next
          print
        }
      '
}

turns_claude() {
  local file="$1"
  local limit="${2:-20}"
  jq -r '
    select(.type == "assistant")
    | .message.content
    | (map(select(.type == "text") | .text) | join("\n"))
    | select(length > 0)
  ' "$file" 2>/dev/null | tail -n "$limit"
}

# -- copilot --------------------------------------------------------------

# Parse a single key from workspace.yaml. YAML here is flat key:value, no
# nesting; avoid a yq dependency by grepping the line.
workspace_yaml_get() {
  local wy="$1" key="$2"
  awk -F': ' -v k="$key" '$1 == k { sub(/^[^:]*: */, ""); print; exit }' "$wy" 2>/dev/null
}

meta_copilot() {
  local file="$1"
  local session_meta
  session_meta=$(jq -n -c '[inputs | select(.type == "session.start") | .data] | .[0] // empty' "$file" 2>/dev/null)
  [[ -n "$session_meta" ]] || die_runtime "no session.start record in $file"

  # Fallback: if session.start's cwd/model is null/empty, read the sibling
  # workspace.yaml. (Real Copilot sessions emit null cwd at start in practice.)
  local session_dir wy wy_cwd="" wy_model=""
  session_dir=$(dirname "$file")
  wy="$session_dir/workspace.yaml"
  if [[ -f "$wy" ]]; then
    wy_cwd=$(workspace_yaml_get "$wy" "cwd")
    wy_model=$(workspace_yaml_get "$wy" "model")
  fi

  local started_at
  started_at=$(file_iso_mtime "$file")

  printf '%s' "$session_meta" | jq -c \
    --arg cli "copilot" \
    --arg wy_cwd "$wy_cwd" \
    --arg wy_model "$wy_model" \
    --arg started_at "$started_at" \
    '
    def nn(x): (x // "") | select(. != "") // null;
    . as $d
    | ($d.sessionId // "") as $sid
    | {
        cli: $cli,
        session_id: nn($sid),
        short_id: nn($sid[:8]),
        cwd: nn($d.cwd // $wy_cwd),
        model: nn($d.model // $wy_model),
        started_at: nn($started_at)
      }
    '
}

# Always prefer .data.content (the raw user text) over .data.transformedContent
# (which wraps the prompt in system-reminder boilerplate).
prompts_copilot() {
  local file="$1"
  jq -r '
    select(.type == "user.message")
    | .data.content // ""
    | select(length > 0)
  ' "$file" 2>/dev/null
}

turns_copilot() {
  local file="$1"
  local limit="${2:-20}"
  jq -r '
    select(.type == "assistant.message")
    | (.data.content // .data.text // "")
    | select(length > 0)
  ' "$file" 2>/dev/null | tail -n "$limit"
}

# -- codex ----------------------------------------------------------------

meta_codex() {
  local file="$1"
  local sm
  sm=$(jq -n -c '[inputs | select(.type == "session_meta") | .payload] | .[0] // empty' "$file" 2>/dev/null)
  [[ -n "$sm" ]] || die_runtime "no session_meta record in $file"

  printf '%s' "$sm" | jq -c '
    def nn(x): (x // "") | select(. != "") // null;
    ((.id // "")) as $sid
    | {
        cli: "codex",
        session_id: nn($sid),
        short_id: nn($sid[:8]),
        cwd: nn(.cwd),
        model: nn(.model_provider),
        started_at: nn(.timestamp)
      }
  '
}

prompts_codex() {
  local file="$1"
  # The first user message in every Codex session is an <environment_context>
  # block. Filter it out; every other user turn stays.
  jq -r '
    select(.type == "response_item"
           and .payload.type == "message"
           and .payload.role == "user")
    | .payload.content[0].text // ""
    | select(length > 0)
    | select(test("^<environment_context>") | not)
  ' "$file" 2>/dev/null
}

turns_codex() {
  local file="$1"
  local limit="${2:-20}"
  jq -r '
    select(.type == "response_item"
           and .payload.type == "message"
           and .payload.role == "assistant")
    | .payload.content[0].text // ""
    | select(length > 0)
  ' "$file" 2>/dev/null | tail -n "$limit"
}

# -- dispatch -------------------------------------------------------------

main() {
  [[ $# -ge 1 ]] || usage
  local sub="$1"
  [[ $# -ge 2 ]] || usage
  local cli="$2"
  case "$cli" in
    claude|copilot|codex) ;;
    *) die_usage "cli must be one of: claude, copilot, codex (got: $cli)" ;;
  esac

  [[ $# -ge 3 ]] || usage
  local file="$3"
  local limit="${4:-20}"
  require_file "$file"

  case "$sub" in
    meta)
      case "$cli" in
        claude)  meta_claude "$file" ;;
        copilot) meta_copilot "$file" ;;
        codex)   meta_codex "$file" ;;
      esac
      ;;
    prompts)
      case "$cli" in
        claude)  prompts_claude "$file" ;;
        copilot) prompts_copilot "$file" ;;
        codex)   prompts_codex "$file" ;;
      esac
      ;;
    turns)
      case "$cli" in
        claude)  turns_claude "$file" "$limit" ;;
        copilot) turns_copilot "$file" "$limit" ;;
        codex)   turns_codex "$file" "$limit" ;;
      esac
      ;;
    *)
      die_usage "unknown subcommand: $sub"
      ;;
  esac
}

main "$@"
