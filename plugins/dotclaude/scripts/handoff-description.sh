#!/usr/bin/env bash
# handoff-description.sh — encode/decode the gist description schema.
#
# Schema: handoff:v1:<cli>:<short-uuid>:<project-slug>:<hostname>[:<tag>]
#
# Usage:
#   handoff-description.sh encode \
#     --cli <claude|copilot|codex> \
#     --short-id <8 hex chars> \
#     --project <slug> \
#     --hostname <slug> \
#     [--tag <slug>]
#
#   handoff-description.sh decode "<handoff:v1:...>"
#
# encode: prints the composed string on stdout, exit 0.
# decode: prints a JSON object on stdout, exit 0. Exits non-zero with
# a structured error on malformed input.

set -euo pipefail

die() { printf 'handoff-description: %s\n' "$1" >&2; exit 2; }

# Lower-cases input and replaces non-[a-z0-9-] with '-', trims to 40 chars.
slugify() {
  local raw="$1"
  raw="$(printf '%s' "$raw" | LC_ALL=C tr '[:upper:]' '[:lower:]')"
  raw="$(printf '%s' "$raw" | LC_ALL=C tr -c 'a-z0-9-' '-')"
  # Trim leading/trailing dashes and collapse runs.
  raw="$(printf '%s' "$raw" | sed -E 's/-+/-/g; s/^-+//; s/-+$//')"
  [[ -z "$raw" ]] && raw="adhoc"
  printf '%s' "${raw:0:40}"
}

# Validates an already-slugified segment matches [a-z0-9-]{1,40}.
valid_segment() {
  [[ "$1" =~ ^[a-z0-9-]{1,40}$ ]]
}

cmd_encode() {
  local cli="" short_id="" project="" hostname="" tag=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cli) cli="$2"; shift 2;;
      --short-id) short_id="$2"; shift 2;;
      --project) project="$2"; shift 2;;
      --hostname) hostname="$2"; shift 2;;
      --tag) tag="$2"; shift 2;;
      *) die "unknown encode flag: $1";;
    esac
  done

  [[ -z "$cli" ]] && die "encode requires --cli"
  [[ -z "$short_id" ]] && die "encode requires --short-id"
  [[ -z "$project" ]] && die "encode requires --project"
  [[ -z "$hostname" ]] && die "encode requires --hostname"

  case "$cli" in
    claude|copilot|codex) ;;
    *) die "--cli must be one of: claude, copilot, codex";;
  esac

  [[ "$short_id" =~ ^[0-9a-f]{8}$ ]] || die "--short-id must be exactly 8 hex chars"

  local project_slug hostname_slug tag_slug=""
  project_slug="$(slugify "$project")"
  hostname_slug="$(slugify "$hostname")"
  valid_segment "$project_slug" || die "project slug invalid after normalization: $project_slug"
  valid_segment "$hostname_slug" || die "hostname slug invalid after normalization: $hostname_slug"

  local out="handoff:v1:${cli}:${short_id}:${project_slug}:${hostname_slug}"
  if [[ -n "$tag" ]]; then
    tag_slug="$(slugify "$tag")"
    valid_segment "$tag_slug" || die "tag slug invalid after normalization: $tag_slug"
    out="${out}:${tag_slug}"
  fi

  printf '%s\n' "$out"
}

cmd_decode() {
  local raw="${1:-}"
  [[ -z "$raw" ]] && die "decode requires the description string"

  # Strict parse: reject anything that doesn't start with handoff:v1:.
  [[ "$raw" =~ ^handoff:v1: ]] || die "malformed: missing handoff:v1: prefix"

  local rest="${raw#handoff:v1:}"
  IFS=':' read -r cli short_id project hostname tag extra <<<"$rest"

  [[ -n "${extra:-}" ]] && die "malformed: too many colon segments"
  [[ -z "${cli:-}" || -z "${short_id:-}" || -z "${project:-}" || -z "${hostname:-}" ]] \
    && die "malformed: missing required segment"

  case "$cli" in
    claude|copilot|codex) ;;
    *) die "malformed: cli not one of claude|copilot|codex ($cli)";;
  esac
  [[ "$short_id" =~ ^[0-9a-f]{8}$ ]] || die "malformed: short-id not 8 hex chars"
  valid_segment "$project" || die "malformed: project slug fails charset"
  valid_segment "$hostname" || die "malformed: hostname slug fails charset"
  if [[ -n "${tag:-}" ]]; then
    valid_segment "$tag" || die "malformed: tag slug fails charset"
  fi

  # Emit JSON. Keep it hand-rolled to avoid a jq hard-dep.
  if [[ -n "${tag:-}" ]]; then
    printf '{"cli":"%s","short_id":"%s","project":"%s","hostname":"%s","tag":"%s"}\n' \
      "$cli" "$short_id" "$project" "$hostname" "$tag"
  else
    printf '{"cli":"%s","short_id":"%s","project":"%s","hostname":"%s","tag":null}\n' \
      "$cli" "$short_id" "$project" "$hostname"
  fi
}

sub="${1:-}"
[[ -z "$sub" ]] && die "usage: handoff-description.sh <encode|decode> ..."
shift

case "$sub" in
  encode) cmd_encode "$@" ;;
  decode) cmd_decode "$@" ;;
  *) die "unknown subcommand: $sub" ;;
esac
