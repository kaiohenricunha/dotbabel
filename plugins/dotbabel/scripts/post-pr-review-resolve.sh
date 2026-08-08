#!/usr/bin/env bash
# post-pr-review-resolve.sh — resolve a PR for the post-pr-review skill.
#
# Usage:
#   post-pr-review-resolve.sh [<PR#>] [--repo OWNER/REPO]
#
# If <PR#> is omitted, autodetects from the current branch via `gh pr view`.
#
# Output: JSON object with the fields:
#   number, headRefOid, state, isDraft, headRepository, baseRepository,
#   isCrossRepository, url
#
# Exit codes:
#   0  resolved
#   1  no PR found / unresolvable
#   2  gh not authed
#   3  invocation error

set -euo pipefail

PR=""
REPO=""
REPO_FLAG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      REPO_FLAG+=(--repo "$2")
      shift 2
      ;;
    *)
      PR="$1"
      shift
      ;;
  esac
done

if ! gh auth status >/dev/null 2>&1; then
  echo '{"error":"gh auth missing — run gh auth login"}' >&2
  exit 2
fi

# `gh pr view --json` has NO `baseRepository` field — requesting it makes every
# invocation fail with "Unknown JSON field". The base repo is simply the repo
# the PR lives in, so derive it the way the sibling scripts already do
# (post-pr-review-list-markers.sh:39, post-batch.sh:58, post-single.sh:52)
# and splice it into the output, preserving this script's documented contract.
FIELDS="number,headRefOid,state,isDraft,headRepository,isCrossRepository,url"

if [[ -n "$PR" ]]; then
  if ! RAW=$(gh pr view "$PR" "${REPO_FLAG[@]}" --json "$FIELDS" 2>&1); then
    # Surface gh's own diagnostic. Collapsing every failure to "PR not found"
    # is what hid this bug: a malformed request read as a missing PR.
    printf '%s\n' "$RAW" >&2
    exit 1
  fi
else
  if ! RAW=$(gh pr view "${REPO_FLAG[@]}" --json "$FIELDS" 2>&1); then
    printf '%s\n' "$RAW" >&2
    echo 'no PR for current branch — pass <PR#> explicitly: /post-pr-review 123' >&2
    exit 1
  fi
fi

if [[ -z "$REPO" ]]; then
  if ! REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>&1); then
    printf '%s\n' "$REPO" >&2
    exit 1
  fi
fi

jq --arg owner "${REPO%%/*}" --arg name "${REPO##*/}" \
  '. + {baseRepository: {owner: {login: $owner}, name: $name, nameWithOwner: ($owner + "/" + $name)}}' \
  <<<"$RAW"
