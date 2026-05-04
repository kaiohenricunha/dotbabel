#!/usr/bin/env bash
# handoff-resolve.sh — resolve <cli> <identifier> to a session JSONL path.
#
# Usage:
#   handoff-resolve.sh <cli> <identifier>
#
# cli:          claude | copilot | codex | any
# identifier:   full UUID (36 chars), short UUID (first 8 hex),
#               the literal word `latest` (case-insensitive), or an alias:
#                 - claude:  customTitle (`claude --resume "<name>"`) or aiTitle
#                            (auto-generated TUI summary)
#                 - codex:   thread_name (user-set, `event_msg.thread_name`)
#                 - copilot: workspace.yaml:name (auto-generated session label)
#               Aliases: case-insensitive exact match. Decision 4 precedence:
#               UUID > short-UUID > latest > alias (no fall-through on miss).
#
# Stdout (success):  absolute path to the resolved JSONL
# Stderr (success):  matched-field=<uuid|short-uuid|latest|customTitle|aiTitle|thread_name|name>
#                    matched-value=<sanitized matched value>
# Stderr (collision, alias-form): handoff-resolve: multiple sessions match "<id>":
#                    + 5-column TSV rows + hint line (see §5.3.5 / §5.3.2)
#
# Exits:
#   0  success — single path resolved
#   2  "not found", "no session matches", or "multiple sessions match" (collision)
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

# Helpers for 5-column TSV emit on alias collisions and matched-value sanitization.
# See docs/specs/handoff-skill/spec/5-interfaces-apis.md §5.3.5 for the column contract.

# Collapse tabs/newlines in a matched-value to single spaces, preserving field width.
# §5.3.5 invariant: alias-form <matched-value> is sanitized at emit so TSV rows
# never contain literal tabs/newlines that would corrupt column boundaries.
sanitize_for_tsv() {
  local v="$1"
  v="${v//$'\t'/ }"
  v="${v//$'\n'/ }"
  printf '%s' "$v"
}

# First 8 hex of a session id, for the <short-id> TSV column.
short_id_from_session() {
  local sid="$1"
  printf '%s' "${sid:0:8}"
}

# Emit a 5-column collision TSV to stderr and exit 2. Caller passes the input
# query followed by pre-formatted 5-col rows (already sanitized) as positional
# args. Header + rows + trailing hint per §5.3.2.
emit_collision_tsv() {
  local query="$1"
  shift
  {
    printf 'handoff-resolve: multiple sessions match "%s":\n' "$query"
    local row
    for row in "$@"; do
      printf '%s\n' "$row"
    done
    printf 'hint: pass --from <cli> to narrow, or use UUID/short-UUID prefix.\n'
  } >&2
  exit 2
}

# Infer matched-field tag from input shape — fallback for cases where a per-CLI
# resolver's single-hit branch returned a path on stdout but did NOT emit the
# matched-field=/matched-value= stderr metadata that (d).7 standardized. As of
# v1.3.0 (#158) all per-CLI single-hit branches emit explicit tags; reaching
# this fallback indicates a per-CLI contract drift worth investigating, not a
# normal code path. The four shape categories below mirror Decision 4's
# precedence order so debugging signal is unambiguous.
infer_field_from_id() {
  local id="$1"
  if [[ "$id" =~ $UUID_RE ]]; then printf '%s' "uuid"
  elif [[ "$id" =~ $SHORT_UUID_RE ]]; then printf '%s' "short-uuid"
  elif [[ "$id" == [Ll][Aa][Tt][Ee][Ss][Tt] ]]; then printf '%s' "latest"
  else printf '%s' "alias"
  fi
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
# Returns 0 on both empty and populated input. Empty input → empty stdout, exit 0
# (NOT exit 1 — callers compose this in pipefail-sensitive substitutions like
# `hit="$(find ... | pick_newest)"` and rely on `[[ -z "$hit" ]]` for the no-match
# branch; an exit-1 from the helper would propagate via pipefail and errexit-kill
# the calling script before the no-match branch could dispatch).
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
  if [[ -n "$best_path" ]]; then
    printf '%s\n' "$best_path"
  fi
  return 0
}

resolve_claude() {
  local id="$1"
  local root="${HOME}/.claude/projects"
  [[ -d "$root" ]] || die_runtime "claude session root not found: $root"

  if [[ "$id" == [Ll][Aa][Tt][Ee][Ss][Tt] ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name '*.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no claude sessions found under $root"
    printf '%s\n' "$hit"
    printf 'matched-field=latest\n' >&2
    printf 'matched-value=latest\n' >&2
    return 0
  fi

  # Full UUID (36 chars, 5 hyphen-separated groups).
  if [[ "$id" =~ $UUID_RE ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name "${id}.jsonl" 2>/dev/null | head -1)"
    [[ -n "$hit" ]] || die_runtime "claude session not found for uuid: $id"
    printf '%s\n' "$hit"
    printf 'matched-field=uuid\n' >&2
    printf 'matched-value=%s\n' "$(sanitize_for_tsv "$id")" >&2
    return 0
  fi

  # Short UUID (first 8 hex) — pick newest by mtime; deterministic across prefix collisions.
  # Strict precedence per Decision 4: short-UUID-shaped queries are not consulted
  # as aliases on miss (no fall-through to customTitle/aiTitle scans).
  if [[ "$id" =~ $SHORT_UUID_RE ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name "${id}*.jsonl" 2>/dev/null | pick_newest)"
    if [[ -n "$hit" ]]; then
      printf '%s\n' "$hit"
      printf 'matched-field=short-uuid\n' >&2
      printf 'matched-value=%s\n' "$(sanitize_for_tsv "$id")" >&2
      return 0
    fi
    die_runtime "claude session not found for short-uuid: $id"
  fi

  # Claude alias scans — `customTitle` (user-set via `claude --resume "<name>"`)
  # and `aiTitle` (auto-generated TUI summary). Per ARCH-3, both fields are
  # equally-weighted alias surfaces for the same CLI; the two mechanisms are
  # SCANNED INDEPENDENTLY but their hits ACCUMULATE into a single Claude alias
  # candidate set with shared dedup-by-sessionId. Only after BOTH scans complete
  # do we decide single-hit vs collision — otherwise a cross-mechanism match
  # (e.g. customTitle="x" in session A and aiTitle="x" in session B) would
  # silently exit on the first scan, missing the collision.
  #
  # Both scans use:
  #   - jq ascii_downcase for case-insensitive exact match (Decisions 1/2)
  #   - grep -iF prefilter so case-folded inputs pass the gate
  #   - intra-file dedup-by-sessionId (claude rewrites these records on every
  #     save, producing 100+ identical records per file — Phase 1 cardinality
  #     survey: 73-366 records per file)
  if command -v jq >/dev/null 2>&1; then
    local f session_id matched_value
    local -a claude_rows=()
    local claude_hit_path="" claude_hit_value="" claude_hit_field=""
    local seen_sids=""

    # customTitle scan
    while IFS= read -r f; do
      while IFS=$'\t' read -r session_id matched_value; do
        [[ -n "$session_id" ]] || continue
        case " $seen_sids " in
          *" $session_id "*) continue ;;
        esac
        seen_sids="$seen_sids $session_id"
        local hit
        hit="$(find "$root" -maxdepth 2 -type f -name "${session_id}.jsonl" 2>/dev/null | head -1)"
        [[ -n "$hit" ]] || continue
        if [[ -z "$claude_hit_path" ]]; then
          claude_hit_path="$hit"
          claude_hit_value="$matched_value"
          claude_hit_field="customTitle"
        fi
        claude_rows+=("$(printf '%s\t%s\t%s\t%s\t%s' \
          "claude" \
          "$(short_id_from_session "$session_id")" \
          "$hit" \
          "$(sanitize_for_tsv "$matched_value")" \
          "customTitle")")
      done < <(jq -r --arg name "$id" '
        select(.type == "custom-title"
               and (.customTitle | ascii_downcase) == ($name | ascii_downcase))
        | "\(.sessionId)\t\(.customTitle | gsub("[\t\n]"; " "))"' "$f" 2>/dev/null)
    done < <(grep -rl --include='*.jsonl' -iF "\"customTitle\":\"${id}\"" "$root" 2>/dev/null)

    # aiTitle scan — shares seen_sids with customTitle so a session matched by
    # both mechanisms collapses to one row (whichever scan saw it first wins
    # the matched-field tag). Different sessions matched by different mechanisms
    # remain distinct rows in claude_rows for collision dispatch below.
    while IFS= read -r f; do
      while IFS=$'\t' read -r session_id matched_value; do
        [[ -n "$session_id" ]] || continue
        case " $seen_sids " in
          *" $session_id "*) continue ;;
        esac
        seen_sids="$seen_sids $session_id"
        local hit
        hit="$(find "$root" -maxdepth 2 -type f -name "${session_id}.jsonl" 2>/dev/null | head -1)"
        [[ -n "$hit" ]] || continue
        if [[ -z "$claude_hit_path" ]]; then
          claude_hit_path="$hit"
          claude_hit_value="$matched_value"
          claude_hit_field="aiTitle"
        fi
        claude_rows+=("$(printf '%s\t%s\t%s\t%s\t%s' \
          "claude" \
          "$(short_id_from_session "$session_id")" \
          "$hit" \
          "$(sanitize_for_tsv "$matched_value")" \
          "aiTitle")")
      done < <(jq -r --arg name "$id" '
        select(.type == "ai-title"
               and (.aiTitle | ascii_downcase) == ($name | ascii_downcase))
        | "\(.sessionId)\t\(.aiTitle | gsub("[\t\n]"; " "))"' "$f" 2>/dev/null)
    done < <(grep -rl --include='*.jsonl' -iF "\"aiTitle\":\"${id}\"" "$root" 2>/dev/null)

    # Unified dispatch over the union of customTitle + aiTitle hits.
    case ${#claude_rows[@]} in
      0) ;;  # no alias match in either mechanism; fall through to die_runtime
      1)
        printf '%s\n' "$claude_hit_path"
        printf 'matched-field=%s\n' "$claude_hit_field" >&2
        printf 'matched-value=%s\n' "$(sanitize_for_tsv "$claude_hit_value")" >&2
        return 0
        ;;
      *)
        emit_collision_tsv "$id" "${claude_rows[@]}"
        ;;
    esac
  fi

  die_runtime "claude session not found for identifier: $id"
}

resolve_copilot() {
  local id="$1"
  local root="${HOME}/.copilot/session-state"
  [[ -d "$root" ]] || die_runtime "copilot session root not found: $root"

  if [[ "$id" == [Ll][Aa][Tt][Ee][Ss][Tt] ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -name 'events.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no copilot sessions found under $root"
    printf '%s\n' "$hit"
    printf 'matched-field=latest\n' >&2
    printf 'matched-value=latest\n' >&2
    return 0
  fi

  # Full UUID — direct path.
  if [[ "$id" =~ $UUID_RE ]]; then
    local candidate="${root}/${id}/events.jsonl"
    [[ -f "$candidate" ]] || die_runtime "copilot session not found for uuid: $id"
    printf '%s\n' "$candidate"
    printf 'matched-field=uuid\n' >&2
    printf 'matched-value=%s\n' "$(sanitize_for_tsv "$id")" >&2
    return 0
  fi

  # Short UUID — pick newest matching session dir by mtime of its events.jsonl.
  if [[ "$id" =~ $SHORT_UUID_RE ]]; then
    local hit
    hit="$(find "$root" -maxdepth 2 -type f -path "*/${id}*/events.jsonl" 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] \
      || die_runtime "copilot session not found for short-uuid: $id"
    printf '%s\n' "$hit"
    printf 'matched-field=short-uuid\n' >&2
    printf 'matched-value=%s\n' "$(sanitize_for_tsv "$id")" >&2
    return 0
  fi

  # Copilot `workspace.yaml:name` alias scan: copilot persists an LLM-generated
  # session name at session-start time as a top-level YAML key in
  # `~/.copilot/session-state/<uuid>/workspace.yaml`. The `name` field is what
  # `copilot --resume`'s picker displays. Distinct from `summary` (decorative
  # companion key, often identical but not the resolution target per Decision 4).
  # Case-insensitive exact match via LC_ALL=C tr (matching the bash 3.2 floor
  # established at handoff-description.sh:34). One workspace.yaml per session
  # directory, so no intra-resource dedup needed (structural invariant: one
  # name per UUID directory). Cross-directory matches are real collisions —
  # accumulate into name_rows + emit_collision_tsv.
  local id_lower
  id_lower="$(printf '%s' "$id" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  local d workspace_yaml name_value name_lower sid
  local -a name_rows=()
  local name_hit_path="" name_hit_value=""
  while IFS= read -r d; do
    workspace_yaml="${d}/workspace.yaml"
    [[ -f "$workspace_yaml" ]] || continue
    name_value=$(sed -n 's/^name: *//p' "$workspace_yaml" 2>/dev/null | head -1)
    name_value="${name_value#\"}"
    name_value="${name_value%\"}"
    [[ -n "$name_value" ]] || continue
    name_lower="$(printf '%s' "$name_value" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
    [[ "$name_lower" == "$id_lower" ]] || continue
    local hit="${d}/events.jsonl"
    [[ -f "$hit" ]] || continue
    sid=$(basename "$d")
    name_hit_path="$hit"
    name_hit_value="$name_value"
    name_rows+=("$(printf '%s\t%s\t%s\t%s\t%s' \
      "copilot" \
      "$(short_id_from_session "$sid")" \
      "$hit" \
      "$(sanitize_for_tsv "$name_value")" \
      "name")")
  done < <(find "$root" -maxdepth 1 -mindepth 1 -type d 2>/dev/null)

  case ${#name_rows[@]} in
    0) ;;  # no name match; fall through to die_runtime below
    1)
      printf '%s\n' "$name_hit_path"
      printf 'matched-field=name\n' >&2
      printf 'matched-value=%s\n' "$(sanitize_for_tsv "$name_hit_value")" >&2
      return 0
      ;;
    *)
      emit_collision_tsv "$id" "${name_rows[@]}"
      ;;
  esac

  die_runtime "copilot session not found for identifier: $id"
}

resolve_codex() {
  local id="$1"
  local root="${HOME}/.codex/sessions"
  [[ -d "$root" ]] || die_runtime "codex session root not found: $root"

  if [[ "$id" == [Ll][Aa][Tt][Ee][Ss][Tt] ]]; then
    local hit
    hit="$(find "$root" -type f -name 'rollout-*.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no codex sessions found under $root"
    printf '%s\n' "$hit"
    printf 'matched-field=latest\n' >&2
    printf 'matched-value=latest\n' >&2
    return 0
  fi

  # Full UUID.
  # Strict precedence per Decision 4: UUID-shaped queries are not consulted as
  # aliases on miss (no fall-through to thread_name scan). Removes the
  # previously-codex-only "very unlikely, but cheap" fall-through that diverged
  # from claude/copilot's strict-precedence shape.
  if [[ "$id" =~ $UUID_RE ]]; then
    local hit
    hit="$(find "$root" -type f -name "rollout-*-${id}.jsonl" 2>/dev/null | head -1)"
    if [[ -n "$hit" ]]; then
      printf '%s\n' "$hit"
      printf 'matched-field=uuid\n' >&2
      printf 'matched-value=%s\n' "$(sanitize_for_tsv "$id")" >&2
      return 0
    fi
    die_runtime "codex session not found for uuid: $id"
  fi

  # Short UUID — pick newest by mtime; deterministic across prefix collisions.
  # Strict precedence per Decision 4: short-UUID-shaped queries are not consulted
  # as aliases on miss (no fall-through to thread_name scan).
  if [[ "$id" =~ $SHORT_UUID_RE ]]; then
    local hit
    hit="$(find "$root" -type f -name "rollout-*-${id}-*.jsonl" 2>/dev/null | pick_newest)"
    if [[ -n "$hit" ]]; then
      printf '%s\n' "$hit"
      printf 'matched-field=short-uuid\n' >&2
      printf 'matched-value=%s\n' "$(sanitize_for_tsv "$id")" >&2
      return 0
    fi
    die_runtime "codex session not found for short-uuid: $id"
  fi

  # Codex `thread_name` user-set alias scan: stored as
  # `{"type":"event_msg","payload":{"thread_name":"<name>", ...}}` in rollout JSONL.
  # Structural note: codex sessionId is encoded in the rollout filename (not a JSON
  # field), so jq emits input_filename instead of looking up by sessionId. Bash
  # extracts short-id via session_id_from_path "codex" "$path".
  # Case-insensitive exact match via jq ascii_downcase (Decision 1/2). Null guard
  # because ascii_downcase errors on null and most event_msg records lack
  # .payload.thread_name. Collect-all per ARCH-3: collisions emit 5-col TSV via
  # emit_collision_tsv; single hit emits matched-field/matched-value to stderr
  # alongside path on stdout.
  # Prefilter with grep -iF so case-folded inputs pass the gate.
  #
  # Implicit invariant: only event_msg records carrying a thread_name have
  # .payload.thread_name; the null guard filters safely without a .payload.type
  # discriminator. Empirical verification 2026-05-03: 0 thread_name records
  # across 5 local rollouts (Phase 1 finding). The .payload.type discriminator
  # is unverified on real thread_name data — revisit when production data is
  # available; tightening to .payload.type == "thread_name" would be a strict
  # invariant upgrade if confirmed.
  if command -v jq >/dev/null 2>&1; then
    local f path matched_value
    local -a thread_rows=()
    local thread_hit_path="" thread_hit_value=""
    local seen_paths=""
    while IFS= read -r f; do
      while IFS=$'\t' read -r path matched_value; do
        [[ -n "$path" ]] || continue
        [[ -f "$path" ]] || continue
        # Intra-file dedup-by-path: codex sessionId is encoded in the rollout
        # filename, so same path === same session. Multiple thread_name records
        # within one rollout (if any — Phase 1 found 0 records on local data)
        # would dedupe to one row. NOT to be confused with cross-file collision
        # detection — different paths with the same alias are real collisions,
        # handled by accumulation into thread_rows + emit_collision_tsv.
        case " $seen_paths " in
          *" $path "*) continue ;;
        esac
        seen_paths="$seen_paths $path"
        local sid; sid=$(session_id_from_path "codex" "$path")
        thread_hit_path="$path"
        thread_hit_value="$matched_value"
        thread_rows+=("$(printf '%s\t%s\t%s\t%s\t%s' \
          "codex" \
          "$(short_id_from_session "$sid")" \
          "$path" \
          "$(sanitize_for_tsv "$matched_value")" \
          "thread_name")")
      done < <(jq -r --arg name "$id" '
        select(.type == "event_msg"
               and .payload.thread_name != null
               and (.payload.thread_name | ascii_downcase) == ($name | ascii_downcase))
        | "\(input_filename)\t\(.payload.thread_name | gsub("[\t\n]"; " "))"' "$f" 2>/dev/null)
    done < <(grep -rl --include='rollout-*.jsonl' -iF "\"thread_name\":\"${id}\"" "$root" 2>/dev/null)

    case ${#thread_rows[@]} in
      0) ;;  # no thread_name match; fall through to die_runtime at function bottom
      1)
        printf '%s\n' "$thread_hit_path"
        printf 'matched-field=thread_name\n' >&2
        printf 'matched-value=%s\n' "$(sanitize_for_tsv "$thread_hit_value")" >&2
        return 0
        ;;
      *)
        emit_collision_tsv "$id" "${thread_rows[@]}"
        ;;
    esac
  fi

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

# `any` mode: probe all three CLIs. On exactly-one match emit single path on stdout
# plus matched-field=/matched-value= metadata on stderr (mirroring per-CLI single-hit
# contract). On multi-match (intra-CLI alias collision passed through, OR cross-CLI
# union of single hits with the same alias), emit 5-column TSV via emit_collision_tsv.
# On no match across all CLIs, exit 2 with "no session matches: <id>".
#
# Per-CLI stderr is captured per-iteration to a tmpfile so resolve_any can:
#   (a) parse matched-field=/matched-value= metadata from per-CLI single-hit branches
#   (b) detect per-CLI alias-collision via "handoff-resolve: multiple sessions match"
#       header and aggregate the 5-tab-field rows into resolve_any's own row array
#   (c) discard "not found" stderr from CLIs that miss (skip silently)
# Cleanup: per-iteration rm -f for happy path, RETURN trap for abnormal exits.
resolve_any() {
  local id="$1"

  # Special case: `any latest` picks the newest jsonl across all three roots.
  if [[ "$id" == [Ll][Aa][Tt][Ee][Ss][Tt] ]]; then
    local roots=()
    [[ -d "${HOME}/.claude/projects" ]]       && roots+=("${HOME}/.claude/projects")
    [[ -d "${HOME}/.copilot/session-state" ]] && roots+=("${HOME}/.copilot/session-state")
    [[ -d "${HOME}/.codex/sessions" ]]        && roots+=("${HOME}/.codex/sessions")
    [[ ${#roots[@]} -gt 0 ]] || die_runtime "no session roots found under \$HOME"
    local hit
    hit="$(find "${roots[@]}" -type f -name '*.jsonl' 2>/dev/null | pick_newest)"
    [[ -n "$hit" ]] || die_runtime "no sessions found across any root"
    printf '%s\n' "$hit"
    printf 'matched-field=latest\n' >&2
    printf 'matched-value=latest\n' >&2
    return 0
  fi

  # Probe each per-CLI resolver. Capture stderr per-iteration so we can:
  #   - parse matched-field/matched-value metadata on single-hit success
  #   - aggregate 5-column collision rows on per-CLI alias collision (exit 2 +
  #     "multiple sessions match" header from emit_collision_tsv)
  #   - skip silently on per-CLI miss (any other exit + stderr we don't recognize)
  local hits=()
  local tsv=()
  local cli path sid matched_field matched_value first_field row_path row err_tmp
  for cli in claude copilot codex; do
    err_tmp=$(mktemp) || die_runtime "mktemp failed"
    if path=$("resolve_$cli" "$id" 2>"$err_tmp"); then
      # Single-hit case: extract metadata, build 5-column row.
      if [[ -z "$path" ]]; then
        rm -f "$err_tmp"
        continue
      fi
      matched_field=$(awk -F= '/^matched-field=/{sub(/^matched-field=/,""); print; exit}' "$err_tmp")
      matched_value=$(awk '/^matched-value=/{sub(/^matched-value=/,""); print; exit}' "$err_tmp")
      [[ -n "$matched_field" ]] || matched_field=$(infer_field_from_id "$id")
      [[ -n "$matched_value" ]] || matched_value="$id"
      sid=$(session_id_from_path "$cli" "$path")
      hits+=("$path")
      tsv+=("$(printf '%s\t%s\t%s\t%s\t%s' \
        "$cli" \
        "$(short_id_from_session "$sid")" \
        "$path" \
        "$(sanitize_for_tsv "$matched_value")" \
        "$matched_field")")
    elif grep -q '^handoff-resolve: multiple sessions match' "$err_tmp"; then
      # Per-CLI alias collision: aggregate the 5-tab-field rows into resolve_any's
      # tsv array (skipping the per-CLI emit_collision_tsv header and trailing hint).
      # Each row's first field is the cli name (claude|copilot|codex), and the row
      # already carries the per-CLI's matched-field/matched-value — no
      # re-construction needed.
      while IFS= read -r row; do
        [[ "$row" == *$'\t'* ]] || continue
        first_field="${row%%$'\t'*}"
        case "$first_field" in
          claude|copilot|codex)
            tsv+=("$row")
            row_path=$(printf '%s' "$row" | cut -f3)
            hits+=("$row_path")
            ;;
        esac
      done < "$err_tmp"
    fi
    # Other exits (per-CLI miss with "not found" stderr, env error, etc.): skip
    # silently — same behavior as the pre-(d).9 2>/dev/null discard, just with the
    # tmpfile capture made explicit instead of dropping unconditionally.
    rm -f "$err_tmp"
  done

  case ${#hits[@]} in
    0)
      die_runtime "no session matches: $id"
      ;;
    1)
      printf '%s\n' "${hits[0]}"
      # Surface the metadata from the single matched row (5 tab fields:
      # cli, short-id, path, matched-value, matched-field).
      matched_value=$(printf '%s' "${tsv[0]}" | cut -f4)
      matched_field=$(printf '%s' "${tsv[0]}" | cut -f5)
      printf 'matched-field=%s\n' "$matched_field" >&2
      printf 'matched-value=%s\n' "$matched_value" >&2
      return 0
      ;;
    *)
      # Multi-hit: cross-CLI union OR per-CLI alias collision passthrough.
      # emit_collision_tsv handles header + rows + hint per §5.3.2 stderr template.
      emit_collision_tsv "$id" "${tsv[@]}"
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
