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

# jq boolean helper: does this string look like a non-empty, non-null?
json_str_or_null() {
  local raw="$1"
  if [[ -z "$raw" || "$raw" == "null" ]]; then
    printf 'null'
  else
    # Escape embedded double-quotes and backslashes for safe JSON embedding.
    printf '"%s"' "$(printf '%s' "$raw" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  fi
}

# -- claude ---------------------------------------------------------------

meta_claude() {
  local file="$1"
  # Slurp-and-first via `jq -n '[inputs]|.[0]'` so there's no SIGPIPE from
  # `head -1` closing the pipe early on a long transcript.
  local raw
  raw=$(jq -n -c '[inputs | select(.cwd != null and .cwd != "") | {cwd, sessionId, version}] | .[0] // empty' "$file" 2>/dev/null)
  [[ -n "$raw" ]] || die_runtime "no session metadata found in $file"

  local cwd session_id version short_id
  cwd=$(printf '%s' "$raw" | jq -r '.cwd // ""')
  session_id=$(printf '%s' "$raw" | jq -r '.sessionId // ""')
  version=$(printf '%s' "$raw" | jq -r '.version // ""')
  short_id="${session_id:0:8}"

  # started_at: use file mtime as a stable proxy.
  local started_at
  started_at=$(date -u -r "$file" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file")" +%Y-%m-%dT%H:%M:%SZ)

  printf '{"cli":"claude","session_id":%s,"short_id":%s,"cwd":%s,"model":%s,"version":%s,"started_at":%s}\n' \
    "$(json_str_or_null "$session_id")" \
    "$(json_str_or_null "$short_id")" \
    "$(json_str_or_null "$cwd")" \
    "null" \
    "$(json_str_or_null "$version")" \
    "$(json_str_or_null "$started_at")"
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

  local cwd model session_id
  cwd=$(printf '%s' "$session_meta" | jq -r '.cwd // ""')
  model=$(printf '%s' "$session_meta" | jq -r '.model // ""')
  session_id=$(printf '%s' "$session_meta" | jq -r '.sessionId // ""')

  # Fallback: if session.start's cwd is null/empty, try the sibling
  # workspace.yaml. (Real Copilot sessions emit null cwd at start in practice.)
  local session_dir
  session_dir=$(dirname "$file")
  local wy="$session_dir/workspace.yaml"
  if [[ -z "$cwd" && -f "$wy" ]]; then
    cwd=$(workspace_yaml_get "$wy" "cwd")
  fi
  if [[ -z "$model" && -f "$wy" ]]; then
    model=$(workspace_yaml_get "$wy" "model")
  fi

  local short_id="${session_id:0:8}"
  local started_at
  started_at=$(date -u -r "$file" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file")" +%Y-%m-%dT%H:%M:%SZ)

  printf '{"cli":"copilot","session_id":%s,"short_id":%s,"cwd":%s,"model":%s,"started_at":%s}\n' \
    "$(json_str_or_null "$session_id")" \
    "$(json_str_or_null "$short_id")" \
    "$(json_str_or_null "$cwd")" \
    "$(json_str_or_null "$model")" \
    "$(json_str_or_null "$started_at")"
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

  local session_id cwd model started_at
  session_id=$(printf '%s' "$sm" | jq -r '.id // ""')
  cwd=$(printf '%s' "$sm" | jq -r '.cwd // ""')
  model=$(printf '%s' "$sm" | jq -r '.model_provider // ""')
  started_at=$(printf '%s' "$sm" | jq -r '.timestamp // ""')

  local short_id="${session_id:0:8}"
  printf '{"cli":"codex","session_id":%s,"short_id":%s,"cwd":%s,"model":%s,"started_at":%s}\n' \
    "$(json_str_or_null "$session_id")" \
    "$(json_str_or_null "$short_id")" \
    "$(json_str_or_null "$cwd")" \
    "$(json_str_or_null "$model")" \
    "$(json_str_or_null "$started_at")"
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
