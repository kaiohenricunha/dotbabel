#!/usr/bin/env bash
# handoff-resolve.sh — resolve <cli> <identifier> to a session JSONL path.
#
# Usage:
#   handoff-resolve.sh <cli> <identifier>
#
# cli:          claude | copilot | codex
# identifier:   full UUID (36 chars), short UUID (first 8 hex),
#               the literal word `latest`, or, for codex only,
#               a thread_name alias (e.g. `my-feature`).
#
# Exits:
#   0  prints absolute path to the resolved JSONL on stdout
#   2  "not found" or other runtime error, with structured message on stderr
#   64 usage error

set -euo pipefail

die_usage() { printf 'handoff-resolve: %s\n' "$1" >&2; exit 64; }
die_runtime() { printf 'handoff-resolve: %s\n' "$1" >&2; exit 2; }

usage() {
  cat <<'EOF' >&2
usage: handoff-resolve.sh <any|claude|copilot|codex> <uuid|short-uuid|latest|alias>

  any       probe all three CLIs; on collision, exit 2 with TSV candidates on stderr
  claude    resolve in ~/.claude/projects only
  copilot   resolve in ~/.copilot/session-state only
  codex     resolve in ~/.codex/sessions only
EOF
  exit 64
}

UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
SHORT_UUID_RE='^[0-9a-f]{8}$'

# Detect stat/find flavor once at init. busybox stat accepts -f but ignores the
# format string, dumps multi-line default output, and exits 0 — a runtime
# fallback chain can't detect this. Probe once and take a single deterministic path.
_STAT_FLAVOR=posix
if stat --version 2>&1 | grep -q GNU; then
  _STAT_FLAVOR=gnu
elif stat -f '%m' "$0" 2>/dev/null | grep -qE '^[0-9]+$'; then
  _STAT_FLAVOR=bsd
fi

# Pick newest by mtime from a newline-separated list on stdin. Prints path only.
# Pure-bash loop: no word-splitting on paths with spaces, no subshell per file.
pick_newest() {
  local best_ms=0 best_path="" file frac secs frac_part frac_ms
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    case "$_STAT_FLAVOR" in
      gnu) frac=$(find "$file" -maxdepth 0 -printf '%T@' 2>/dev/null || echo 0) ;;
      bsd) frac=$(stat -f '%Fm' "$file" 2>/dev/null || echo 0) ;;
      *)   frac=$(stat -c '%Y' "$file" 2>/dev/null || echo 0) ;;
    esac
    if [[ "$frac" == *.* ]]; then
      secs="${frac%%.*}"
      frac_part="${frac#*.}000"
      frac_ms=$(( ${secs:-0} * 1000 + 10#${frac_part:0:3} ))
    else
      frac_ms=$(( ${frac:-0} * 1000 ))
    fi
    if (( frac_ms > best_ms )); then
      best_ms=$frac_ms
      best_path="$file"
    fi
  done
  [[ -n "$best_path" ]] && printf '%s\n' "$best_path"
}

resolve_claude() {
  local id="$1"
  local root="${HOME}/.claude/projects"
  [[ -d "$root" ]] || die_runtime "claude session root not found: $root"

  if [[ "$id" == "latest" ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name '*.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no claude sessions found under $root"
    printf '%s\n' "$hit"
    return 0
  fi

  # Full UUID (36 chars, 5 hyphen-separated groups).
  if [[ "$id" =~ $UUID_RE ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name "${id}.jsonl" 2>/dev/null | head -1)"
    [[ -n "$hit" ]] || die_runtime "claude session not found for uuid: $id"
    printf '%s\n' "$hit"
    return 0
  fi

  # Short UUID (first 8 hex) — pick newest by mtime; deterministic across prefix collisions.
  if [[ "$id" =~ $SHORT_UUID_RE ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name "${id}*.jsonl" 2>/dev/null | pick_newest)"
    if [[ -n "$hit" ]]; then
      printf '%s\n' "$hit"
      return 0
    fi
    # Fall through to customTitle scan if short-UUID lookup missed.
  fi

  # Claude `custom-title` alias scan: `claude --resume "<name>"` stores
  # the alias as a JSONL record `{"type":"custom-title","customTitle":"<name>","sessionId":"<uuid>"}`.
  # Prefilter with grep so we only jq-verify files that contain the alias.
  if command -v jq >/dev/null 2>&1; then
    local f session_id
    while IFS= read -r f; do
      session_id=$(jq -r --arg name "$id" '
        select(.type == "custom-title" and .customTitle == $name)
        | .sessionId' "$f" 2>/dev/null | head -1)
      if [[ -n "$session_id" ]]; then
        local hit
        hit="$(find "$root" -maxdepth 2 -type f -name "${session_id}.jsonl" 2>/dev/null | head -1)"
        if [[ -n "$hit" ]]; then
          printf '%s\n' "$hit"
          return 0
        fi
      fi
    done < <(grep -rl --include='*.jsonl' -F "\"customTitle\":\"${id}\"" "$root" 2>/dev/null)
  fi

  die_runtime "claude session not found for identifier: $id"
}

resolve_copilot() {
  local id="$1"
  local root="${HOME}/.copilot/session-state"
  [[ -d "$root" ]] || die_runtime "copilot session root not found: $root"

  if [[ "$id" == "latest" ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name 'events.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no copilot sessions found under $root"
    printf '%s\n' "$hit"
    return 0
  fi

  # Full UUID — direct path.
  if [[ "$id" =~ $UUID_RE ]]; then
    local candidate="${root}/${id}/events.jsonl"
    [[ -f "$candidate" ]] || die_runtime "copilot session not found for uuid: $id"
    printf '%s\n' "$candidate"
    return 0
  fi

  # Short UUID — pick newest matching session dir by mtime of its events.jsonl.
  if [[ "$id" =~ $SHORT_UUID_RE ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -path "*/${id}*/events.jsonl" 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] \
      || die_runtime "copilot session not found for short-uuid: $id"
    printf '%s\n' "$hit"
    return 0
  fi

  die_runtime "copilot identifier must be full UUID, short-UUID (8 hex), or 'latest': $id"
}

resolve_codex() {
  local id="$1"
  local root="${HOME}/.codex/sessions"
  [[ -d "$root" ]] || die_runtime "codex session root not found: $root"

  if [[ "$id" == "latest" ]]; then
    local hit
    hit="$(find "$root" -type f -name 'rollout-*.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no codex sessions found under $root"
    printf '%s\n' "$hit"
    return 0
  fi

  # Full UUID.
  if [[ "$id" =~ $UUID_RE ]]; then
    local hit
    hit="$(find "$root" -type f -name "rollout-*-${id}.jsonl" 2>/dev/null | head -1)"
    if [[ -n "$hit" ]]; then
      printf '%s\n' "$hit"
      return 0
    fi
    # UUID-shaped but not on disk: fall through to alias scan in case someone
    # named a thread with UUID-like shape. Very unlikely, but cheap.
  fi

  # Short UUID — pick newest by mtime; deterministic across prefix collisions.
  if [[ "$id" =~ $SHORT_UUID_RE ]]; then
    local hit
    hit="$(find "$root" -type f -name "rollout-*-${id}-*.jsonl" 2>/dev/null | pick_newest)"
    if [[ -n "$hit" ]]; then
      printf '%s\n' "$hit"
      return 0
    fi
    # Fall through to alias scan.
  fi

  # Alias scan: look for event_msg records with thread_name == "$id".
  # Prefilter with grep — rollout dirs can hold hundreds of files, jq-parsing
  # each one is quadratic. Then jq-verify only candidates if jq is present.
  local f
  while IFS= read -r f; do
    if command -v jq >/dev/null 2>&1; then
      local match
      match=$(jq -r --arg name "$id" '
        select(.type == "event_msg"
               and .payload.thread_name == $name)
        | input_filename' "$f" 2>/dev/null | head -1)
      [[ -n "$match" ]] || continue
    fi
    printf '%s\n' "$f"
    return 0
  done < <(grep -rl --include='rollout-*.jsonl' -F "\"thread_name\":\"${id}\"" "$root" 2>/dev/null)

  die_runtime "codex session not found for identifier: $id"
}

# Extract a session id from a resolved path, per-CLI convention.
session_id_from_path() {
  local cli="$1" path="$2"
  case "$cli" in
    claude)
      basename "$path" .jsonl
      ;;
    copilot)
      basename "$(dirname "$path")"
      ;;
    codex)
      local base; base=$(basename "$path" .jsonl)
      printf '%s' "$base" \
        | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
        | tail -1
      ;;
  esac
}

# `any` mode: probe all three CLIs. Emit single path on exactly-one match;
# TSV candidate list on stderr + exit 2 on collision; exit 2 on no match.
resolve_any() {
  local id="$1"

  # Special case: `any latest` picks the newest jsonl across all three roots.
  if [[ "$id" == "latest" ]]; then
    local roots=()
    [[ -d "${HOME}/.claude/projects" ]]       && roots+=("${HOME}/.claude/projects")
    [[ -d "${HOME}/.copilot/session-state" ]] && roots+=("${HOME}/.copilot/session-state")
    [[ -d "${HOME}/.codex/sessions" ]]        && roots+=("${HOME}/.codex/sessions")
    [[ ${#roots[@]} -gt 0 ]] || die_runtime "no session roots found under \$HOME"
    local hit
    hit="$(find "${roots[@]}" -type f -name '*.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no sessions found across any root"
    printf '%s\n' "$hit"
    return 0
  fi

  # Collect hits from each per-CLI resolver (each may die_runtime on miss;
  # subshell captures the non-zero exit and we skip).
  local hits=()
  local tsv=()
  local cli path sid
  for cli in claude copilot codex; do
    if path=$("resolve_$cli" "$id" 2>/dev/null); then
      [[ -n "$path" ]] || continue
      sid=$(session_id_from_path "$cli" "$path")
      hits+=("$path")
      tsv+=("$(printf '%s\t%s\t%s\t%s' "$cli" "$sid" "$path" "$id")")
    fi
  done

  case ${#hits[@]} in
    0)
      die_runtime "no session matches: $id"
      ;;
    1)
      printf '%s\n' "${hits[0]}"
      return 0
      ;;
    *)
      {
        printf 'handoff-resolve: multiple sessions match "%s":\n' "$id"
        local line
        for line in "${tsv[@]}"; do
          printf '%s\n' "$line"
        done
      } >&2
      exit 2
      ;;
  esac
}

main() {
  [[ $# -ge 1 ]] || usage
  local cli="$1"
  [[ $# -ge 2 ]] || usage
  local id="$2"

  case "$cli" in
    any)     resolve_any "$id" ;;
    claude)  resolve_claude "$id" ;;
    copilot) resolve_copilot "$id" ;;
    codex)   resolve_codex "$id" ;;
    *)       die_usage "cli must be one of: any, claude, copilot, codex (got: $cli)" ;;
  esac
}

main "$@"
