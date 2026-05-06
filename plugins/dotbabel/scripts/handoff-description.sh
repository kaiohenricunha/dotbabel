#!/usr/bin/env bash
# handoff-description.sh — encode/decode the remote handoff store
# description schema. Used by `dotclaude handoff push` to build the
# branch commit message + the description.txt file, and by
# `remote-list` to render the table.
#
# Schemas:
#   v2 (current): handoff:v2:<project>:<cli>:<YYYY-MM>:<short>:<host>[:<tag>]
#   v1 (legacy ): handoff:v1:<cli>:<short>:<project>:<host>[:<tag>]
# decode accepts both; encode only emits v2.
#
# Usage:
#   handoff-description.sh encode \
#     --cli <claude|copilot|codex|gemini> \
#     --short-id <8 hex chars> \
#     --project <slug> \
#     --hostname <slug> \
#     --month <YYYY-MM> \
#     [--tag <slug>]
#
#   handoff-description.sh decode "<handoff:v[12]:...>"
#
# encode: prints the v2 string on stdout, exit 0.
# decode: prints a JSON object on stdout, exit 0. The JSON includes a
#         "schema":"v1"|"v2" key so callers can branch on it.

set -euo pipefail

die() { printf 'handoff-description: %s\n' "$1" >&2; exit 2; }

# Lower-cases input and replaces non-[a-z0-9-] with '-', trims to 40 chars.
slugify() {
  local raw="$1"
  raw="$(printf '%s' "$raw" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  raw="$(printf '%s' "$raw" | LC_ALL=C tr -c 'a-z0-9-' '-')"
  raw="$(printf '%s' "$raw" | sed -E 's/-+/-/g; s/^-+//; s/-+$//')"
  [[ -z "$raw" ]] && raw="adhoc"
  printf '%s' "${raw:0:40}"
}

# Validates an already-slugified segment matches [a-z0-9-]{1,40}.
valid_segment() {
  [[ "$1" =~ ^[a-z0-9-]{1,40}$ ]]
}

# Validates a tag segment: comma-joined slugified tokens, each [a-z0-9-]{1,40}.
# Used for the optional 8th segment in v2 (and v1's optional 7th).
# Single regex to also reject `a,,b`, `,a`, `a,` (bash word-splitting on
# IFS=',' silently dropped empty fields, which would have let those
# malformed segments through).
valid_tag_segment() {
  [[ "$1" =~ ^[a-z0-9-]{1,40}(,[a-z0-9-]{1,40})*$ ]]
}

# Emits the JSON fragment for tag/tags. Pass empty string for "no tag".
# Output: ,"tag":"first","tags":["a","b"]   OR   ,"tag":null,"tags":[]
emit_tags_json() {
  local seg="$1"
  if [[ -z "$seg" ]]; then
    printf ',"tag":null,"tags":[]'
    return
  fi
  local first="${seg%%,*}"
  local arr="" IFS=','
  for token in $seg; do
    [[ -z "$token" ]] && continue
    if [[ -z "$arr" ]]; then arr="\"$token\""
    else arr="${arr},\"$token\""
    fi
  done
  printf ',"tag":"%s","tags":[%s]' "$first" "$arr"
}

# YYYY-MM month bucket — exactly 4 digits, dash, 2 digits.
valid_month() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}$ ]]
}

cmd_encode() {
  local cli="" short_id="" project="" hostname="" month="" tag=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cli) cli="$2"; shift 2;;
      --short-id) short_id="$2"; shift 2;;
      --project) project="$2"; shift 2;;
      --hostname) hostname="$2"; shift 2;;
      --month) month="$2"; shift 2;;
      --tag) tag="$2"; shift 2;;
      *) die "unknown encode flag: $1";;
    esac
  done

  [[ -z "$cli" ]] && die "encode requires --cli"
  [[ -z "$short_id" ]] && die "encode requires --short-id"
  [[ -z "$project" ]] && die "encode requires --project"
  [[ -z "$hostname" ]] && die "encode requires --hostname"
  [[ -z "$month" ]] && die "encode requires --month"

  case "$cli" in
    claude|copilot|codex|gemini) ;;
    *) die "--cli must be one of: claude, copilot, codex, gemini";;
  esac

  [[ "$short_id" =~ ^[0-9a-f]{8}$ ]] || die "--short-id must be exactly 8 hex chars"
  valid_month "$month" || die "--month must be YYYY-MM (got: $month)"

  local project_slug hostname_slug
  project_slug="$(slugify "$project")"
  hostname_slug="$(slugify "$hostname")"
  valid_segment "$project_slug" || die "project slug invalid after normalization: $project_slug"
  valid_segment "$hostname_slug" || die "hostname slug invalid after normalization: $hostname_slug"

  local out="handoff:v2:${project_slug}:${cli}:${month}:${short_id}:${hostname_slug}"
  if [[ -n "$tag" ]]; then
    # Multi-tag (#91 Gap 7): value may be a single tag or a comma-joined list.
    # Split on comma, slugify each token, validate, rejoin. Single-tag input
    # has no comma → produces a one-element list → backward compatible.
    local tag_joined="" first=1
    local IFS=','
    for token in $tag; do
      [[ -z "$token" ]] && continue
      local s; s="$(slugify "$token")"
      valid_segment "$s" || die "tag slug invalid after normalization: $s"
      if (( first )); then tag_joined="$s"; first=0
      else tag_joined="${tag_joined},${s}"
      fi
    done
    [[ -n "$tag_joined" ]] && out="${out}:${tag_joined}"
  fi

  printf '%s\n' "$out"
}

# Decode a v2 description. Segments are positional:
#   handoff:v2:<project>:<cli>:<YYYY-MM>:<short>:<host>[:<tag>]
decode_v2() {
  local rest="$1"
  IFS=':' read -r project cli month short_id hostname tag extra <<<"$rest"

  [[ -n "${extra:-}" ]] && die "malformed v2: too many colon segments"
  [[ -z "${project:-}" || -z "${cli:-}" || -z "${month:-}" || -z "${short_id:-}" || -z "${hostname:-}" ]] \
    && die "malformed v2: missing required segment"

  case "$cli" in
    claude|copilot|codex|gemini) ;;
    *) die "malformed v2: cli not one of claude|copilot|codex|gemini ($cli)";;
  esac
  valid_month "$month" || die "malformed v2: month not YYYY-MM ($month)"
  [[ "$short_id" =~ ^[0-9a-f]{8}$ ]] || die "malformed v2: short-id not 8 hex chars"
  valid_segment "$project" || die "malformed v2: project slug fails charset"
  valid_segment "$hostname" || die "malformed v2: hostname slug fails charset"
  if [[ -n "${tag:-}" ]]; then
    valid_tag_segment "$tag" || die "malformed v2: tag segment fails charset"
  fi

  printf '{"schema":"v2","cli":"%s","short_id":"%s","project":"%s","month":"%s","hostname":"%s"%s}\n' \
    "$cli" "$short_id" "$project" "$month" "$hostname" "$(emit_tags_json "${tag:-}")"
}

# Decode a legacy v1 description (read-only — no encode path). Segments:
#   handoff:v1:<cli>:<short>:<project>:<host>[:<tag>]
decode_v1() {
  local rest="$1"
  IFS=':' read -r cli short_id project hostname tag extra <<<"$rest"

  [[ -n "${extra:-}" ]] && die "malformed v1: too many colon segments"
  [[ -z "${cli:-}" || -z "${short_id:-}" || -z "${project:-}" || -z "${hostname:-}" ]] \
    && die "malformed v1: missing required segment"

  case "$cli" in
    claude|copilot|codex|gemini) ;;
    *) die "malformed v1: cli not one of claude|copilot|codex|gemini ($cli)";;
  esac
  [[ "$short_id" =~ ^[0-9a-f]{8}$ ]] || die "malformed v1: short-id not 8 hex chars"
  valid_segment "$project" || die "malformed v1: project slug fails charset"
  valid_segment "$hostname" || die "malformed v1: hostname slug fails charset"
  if [[ -n "${tag:-}" ]]; then
    valid_tag_segment "$tag" || die "malformed v1: tag segment fails charset"
  fi

  # Emit the same shape as v2's JSON, with month=null (legacy lacks it)
  # and schema=v1 so callers can mark these as "(legacy)" in UI.
  printf '{"schema":"v1","cli":"%s","short_id":"%s","project":"%s","month":null,"hostname":"%s"%s}\n' \
    "$cli" "$short_id" "$project" "$hostname" "$(emit_tags_json "${tag:-}")"
}

cmd_decode() {
  local raw="${1:-}"
  [[ -z "$raw" ]] && die "decode requires the description string"

  case "$raw" in
    handoff:v2:*) decode_v2 "${raw#handoff:v2:}" ;;
    handoff:v1:*) decode_v1 "${raw#handoff:v1:}" ;;
    *) die "malformed: missing handoff:v[12]: prefix" ;;
  esac
}

sub="${1:-}"
[[ -z "$sub" ]] && die "usage: handoff-description.sh <encode|decode> ..."
shift

case "$sub" in
  encode) cmd_encode "$@" ;;
  decode) cmd_decode "$@" ;;
  *) die "unknown subcommand: $sub" ;;
esac
