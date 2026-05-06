#!/usr/bin/env bash
# handoff-extract.sh — CLI-aware extractor for session transcripts.
#
# Usage:
#   handoff-extract.sh meta    <cli> <file>
#   handoff-extract.sh prompts <cli> <file>
#   handoff-extract.sh turns   <cli> <file> [N]
#
# cli:   claude | copilot | codex | gemini
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
usage: handoff-extract.sh <meta|prompts|turns> <claude|copilot|codex|gemini> <file> [N]
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

  # Use first(inputs | select(...)) so jq stops at the first cwd-bearing record
  # rather than slurping the entire file — keeps memory bounded on large transcripts.
  # Session ID comes from the matched record if available, else $fallback_id (the
  # filename UUID), so the second slurp-pass for sessionId is eliminated.
  jq -n -c \
    --arg cli "claude" \
    --arg fallback_id "$fallback_id" \
    --arg started_at "$started_at" \
    '
    def nonempty: select(. != null and . != "");
    (first(inputs | select((.cwd // "") != "")) // {}) as $r
    | (($r.sessionId // "") | select(. != "") // $fallback_id) as $sid
    | {
        cli: $cli,
        session_id: ($sid | nonempty // null),
        short_id: ($sid | (.[:8] | nonempty) // null),
        cwd: ($r.cwd | (. // "") | nonempty // null),
        model: null,
        version: ($r.version | (. // "") | nonempty // null),
        started_at: ($started_at | nonempty // null)
      }
    ' "$file" 2>/dev/null
}

# Claude user prompts, scrubbed of system/command/tool noise.
#
# Output: one JSON-encoded string per line (jq -c). Multi-line prompts stay
# atomic as `"line one\nline two"`; the consumer parses each line via
# JSON.parse. This is what fixes the "digest splits by line, not by message"
# bug — the old jq -r contract emitted raw bytes and multi-line skill-body
# messages turned into N bogus "prompts".
#
# Slash-command handling: a `<command-name>/X</command-name>` wrapper is
# rendered as compact `/X <args>` form, and the immediately-following
# skill body (same promptId) is dropped. This requires a single-pass
# slurp + reduce so we can track "previous record was a command wrapper"
# across the input stream.
prompts_claude() {
  local file="$1"
  jq -c -n '
    def text_of:
      if type == "string" then .
      else (map(select(.type == "text") | .text) | join("\n"))
      end;
    def is_noise:
      ltrimstr(" ") | ltrimstr("\t") | ltrimstr("\n") |
      ( startswith("<local-command-caveat>")
        or startswith("<local-command-stdout>")
        or startswith("<stdin>")
        or startswith("<system-reminder>")
        or startswith("<user-prompt-submit-hook>")
        or startswith("<task-notification>")
        or startswith("<task-id>")
        or startswith("<summary>Monitor event")
        or startswith("</task-notification>")
        or startswith("<event>")
        or startswith("If this event is something the user")
      );
    def is_command_wrapper:
      test("<command-name>") or test("<command-message>");
    def compact_command:
      (capture("<command-name>\\s*(?<n>[^<]+?)\\s*</command-name>") // null) as $n
      | (capture("<command-args>\\s*(?<a>[^<]*?)\\s*</command-args>") // null) as $a
      | if $n == null then "/unknown"
        elif $a == null or ($a.a // "") == "" then $n.n
        else "\($n.n) \($a.a)"
        end;
    foreach (inputs | select(.type == "user")) as $r (
        {emit: null, prevWasCommand: false, prevPid: null};
        ($r.message.content | text_of) as $t
        | ($r.promptId // "") as $pid
        | if $t == "" or ($t | is_noise) then
            .emit = null
          elif ($t | is_command_wrapper) then
            .emit = ($t | compact_command)
            | .prevWasCommand = true
            | .prevPid = $pid
          elif .prevWasCommand and .prevPid == $pid then
            .emit = null
            | .prevWasCommand = false
          else
            .emit = $t
            | .prevWasCommand = false
            | .prevPid = $pid
          end;
        .emit | select(. != null)
      )
  ' "$file" 2>/dev/null
}

turns_claude() {
  local file="$1"
  local limit="${2:-20}"
  local tail_arg="$limit"
  [[ "$limit" == "0" ]] && tail_arg="+1"
  jq -c '
    select(.type == "assistant")
    | .message.content
    | (map(select(.type == "text") | .text) | join("\n"))
    | select(length > 0)
  ' "$file" 2>/dev/null | tail -n "$tail_arg"
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
# Output: one JSON-encoded string per line so multi-line prompts stay atomic.
prompts_copilot() {
  local file="$1"
  jq -c '
    select(.type == "user.message")
    | .data.content // ""
    | select(length > 0)
  ' "$file" 2>/dev/null
}

turns_copilot() {
  local file="$1"
  local limit="${2:-20}"
  local tail_arg="$limit"
  [[ "$limit" == "0" ]] && tail_arg="+1"
  jq -c '
    select(.type == "assistant.message")
    | (.data.content // .data.text // "")
    | select(length > 0)
  ' "$file" 2>/dev/null | tail -n "$tail_arg"
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
  # Output: one JSON-encoded string per line so multi-line prompts stay atomic.
  jq -c '
    select(.type == "response_item"
           and .payload.type == "message"
           and .payload.role == "user")
    | .payload.content[0].text // ""
    | select(length > 0)
    | select(test("^<environment_context>") | not)
  ' "$file" 2>/dev/null
}

# Reads response_item records only. Codex also emits event_msg agent_message
# records that mirror assistant turns 1:1 in every session tested per
# docs/audits/codex-extraction-investigation-2026-04-30.md Phase 2. If those
# mirrors ever desync from response_item (streaming interruption, partial
# writes, schema change), assistant content would silently drop here.
# Potential v1.x hardening: fallback chain to event_msg.agent_message.
turns_codex() {
  local file="$1"
  local limit="${2:-20}"
  local tail_arg="$limit"
  [[ "$limit" == "0" ]] && tail_arg="+1"
  jq -c '
    select(.type == "response_item"
           and .payload.type == "message"
           and .payload.role == "assistant")
    | .payload.content[0].text // ""
    | select(length > 0)
  ' "$file" 2>/dev/null | tail -n "$tail_arg"
}

# -- gemini ---------------------------------------------------------------

gemini_short_from_filename() {
  local file="$1"
  local base
  base=$(basename "$file" .jsonl)
  printf '%s' "$base" | grep -oE '[0-9a-f]{8}$' || true
}

meta_gemini() {
  local file="$1"
  local project_dir cwd="" model="" started_at fallback_short header
  project_dir=$(dirname "$(dirname "$file")")
  if [[ -f "${project_dir}/.project_root" ]]; then
    cwd=$(sed -n '1p' "${project_dir}/.project_root" 2>/dev/null || true)
  fi
  model="$(jq -r 'select(.type == "gemini" and (.model // "") != "") | .model' "$file" 2>/dev/null | sed -n '1p' || true)"
  started_at=$(file_iso_mtime "$file")
  fallback_short="$(gemini_short_from_filename "$file")"
  header=$(sed -n '1p' "$file" 2>/dev/null || true)

  printf '%s\n' "$header" | jq -c \
    --arg cli "gemini" \
    --arg cwd "$cwd" \
    --arg model "$model" \
    --arg started_at "$started_at" \
    --arg fallback_short "$fallback_short" \
    '
    def nn(x): if (x // "") == "" then null else x end;
    . as $r
    | ($r.sessionId // "") as $sid
    | (if ($sid[:8] // "") == "" then $fallback_short else $sid[:8] end) as $short
    | {
        cli: $cli,
        session_id: nn($sid),
        short_id: nn($short),
        cwd: nn($cwd),
        model: nn($model),
        started_at: nn($r.startTime // $r.lastUpdated // $started_at)
      }
    ' 2>/dev/null
}

prompts_gemini() {
  local file="$1"
  jq -c '
    def content_text:
      if (.content | type) == "string" then .content
      elif (.content | type) == "array" then
        [.content[] | if type == "string" then . elif (.text // "") != "" then .text else empty end]
        | join("\n")
      else ""
      end;
    select(.type == "user")
    | content_text
    | select(length > 0)
  ' "$file" 2>/dev/null
}

turns_gemini() {
  local file="$1"
  local limit="${2:-20}"
  local tail_arg="$limit"
  [[ "$limit" == "0" ]] && tail_arg="+1"
  jq -c '
    select(.type == "gemini")
    | (.content // "")
    | select(length > 0)
  ' "$file" 2>/dev/null | awk 'prev != $0 { print; prev = $0 }' | tail -n "$tail_arg"
}

# -- dispatch -------------------------------------------------------------

main() {
  [[ $# -ge 1 ]] || usage
  local sub="$1"
  [[ $# -ge 2 ]] || usage
  local cli="$2"
  case "$cli" in
    claude|copilot|codex|gemini) ;;
    *) die_usage "cli must be one of: claude, copilot, codex, gemini (got: $cli)" ;;
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
        gemini)  meta_gemini "$file" ;;
      esac
      ;;
    prompts)
      case "$cli" in
        claude)  prompts_claude "$file" ;;
        copilot) prompts_copilot "$file" ;;
        codex)   prompts_codex "$file" ;;
        gemini)  prompts_gemini "$file" ;;
      esac
      ;;
    turns)
      case "$cli" in
        claude)  turns_claude "$file" "$limit" ;;
        copilot) turns_copilot "$file" "$limit" ;;
        codex)   turns_codex "$file" "$limit" ;;
        gemini)  turns_gemini "$file" "$limit" ;;
      esac
      ;;
    *)
      die_usage "unknown subcommand: $sub"
      ;;
  esac
}

main "$@"
