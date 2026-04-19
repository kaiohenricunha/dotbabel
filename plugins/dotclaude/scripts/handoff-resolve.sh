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
usage: handoff-resolve.sh <claude|copilot|codex> <uuid|short-uuid|latest|alias>
EOF
  exit 64
}

# Portable mtime+path printer (GNU or BSD stat).
stat_mtime() {
  local file="$1"
  stat -c "%Y %n" "$file" 2>/dev/null || stat -f "%m %N" "$file" 2>/dev/null
}

# Pick newest by mtime from stdin-separated file list. Prints path only.
pick_newest() {
  xargs -I{} sh -c 'stat -c "%Y %n" "{}" 2>/dev/null || stat -f "%m %N" "{}" 2>/dev/null' \
    | sort -rn | head -1 | awk '{for (i=2; i<=NF; i++) printf "%s%s", $i, (i<NF ? OFS : ORS)}'
}

resolve_claude() {
  local id="$1"
  local root="${HOME}/.claude/projects"
  [[ -d "$root" ]] || die_runtime "claude session root not found: $root"

  if [[ "$id" == "latest" ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name '*.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no claude sessions found under $root"
    printf '%s' "$hit"
    return 0
  fi

  # Full UUID (36 chars, 5 hyphen-separated groups).
  if [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name "${id}.jsonl" 2>/dev/null | head -1)"
    [[ -n "$hit" ]] || die_runtime "claude session not found for uuid: $id"
    printf '%s' "$hit"
    return 0
  fi

  # Short UUID (first 8 hex).
  if [[ "$id" =~ ^[0-9a-f]{8}$ ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name "${id}*.jsonl" 2>/dev/null | head -1)"
    [[ -n "$hit" ]] || die_runtime "claude session not found for short-uuid: $id"
    printf '%s' "$hit"
    return 0
  fi

  die_runtime "claude identifier must be full UUID, short-UUID (8 hex), or 'latest': $id"
}

resolve_copilot() {
  local id="$1"
  local root="${HOME}/.copilot/session-state"
  [[ -d "$root" ]] || die_runtime "copilot session root not found: $root"

  if [[ "$id" == "latest" ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name 'events.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no copilot sessions found under $root"
    printf '%s' "$hit"
    return 0
  fi

  # Full UUID — direct path.
  if [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    local candidate="${root}/${id}/events.jsonl"
    [[ -f "$candidate" ]] || die_runtime "copilot session not found for uuid: $id"
    printf '%s' "$candidate"
    return 0
  fi

  # Short UUID — glob match on dir prefix.
  if [[ "$id" =~ ^[0-9a-f]{8}$ ]]; then
    local hit
    hit="$(find "$root" -maxdepth 1 -type d -name "${id}*" 2>/dev/null | head -1)"
    [[ -n "$hit" && -f "$hit/events.jsonl" ]] \
      || die_runtime "copilot session not found for short-uuid: $id"
    printf '%s' "$hit/events.jsonl"
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
    printf '%s' "$hit"
    return 0
  fi

  # Full UUID.
  if [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    local hit
    hit="$(find "$root" -type f -name "rollout-*-${id}.jsonl" 2>/dev/null | head -1)"
    if [[ -n "$hit" ]]; then
      printf '%s' "$hit"
      return 0
    fi
    # UUID-shaped but not on disk: fall through to alias scan in case someone
    # named a thread with UUID-like shape. Very unlikely, but cheap.
  fi

  # Short UUID.
  if [[ "$id" =~ ^[0-9a-f]{8}$ ]]; then
    local hit
    hit="$(find "$root" -type f -name "rollout-*-${id}-*.jsonl" 2>/dev/null | head -1)"
    if [[ -n "$hit" ]]; then
      printf '%s' "$hit"
      return 0
    fi
    # Fall through to alias scan.
  fi

  # Alias scan: look for event_msg records with thread_name == "$id".
  # jq is required here; on older systems fall back to a plain grep for the
  # quoted string. jq is the happy path.
  if command -v jq >/dev/null 2>&1; then
    local f
    while IFS= read -r f; do
      local match
      match=$(jq -r --arg name "$id" '
        select(.type == "event_msg"
               and .payload.thread_name == $name)
        | input_filename' "$f" 2>/dev/null | head -1)
      if [[ -n "$match" ]]; then
        printf '%s' "$f"
        return 0
      fi
    done < <(find "$root" -type f -name 'rollout-*.jsonl' 2>/dev/null)
  else
    local f
    while IFS= read -r f; do
      if grep -q "\"thread_name\":\"${id}\"" "$f" 2>/dev/null; then
        printf '%s' "$f"
        return 0
      fi
    done < <(find "$root" -type f -name 'rollout-*.jsonl' 2>/dev/null)
  fi

  die_runtime "codex session not found for identifier: $id"
}

main() {
  [[ $# -ge 1 ]] || usage
  local cli="$1"
  [[ $# -ge 2 ]] || usage
  local id="$2"

  case "$cli" in
    claude)  resolve_claude "$id" ;;
    copilot) resolve_copilot "$id" ;;
    codex)   resolve_codex "$id" ;;
    *)       die_usage "cli must be one of: claude, copilot, codex (got: $cli)" ;;
  esac
}

main "$@"
