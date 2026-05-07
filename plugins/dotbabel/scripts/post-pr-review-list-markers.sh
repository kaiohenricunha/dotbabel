#!/usr/bin/env bash
# post-pr-review-list-markers.sh — list existing post-pr-review marker hashes
# for dedup.
#
# Usage:
#   post-pr-review-list-markers.sh <PR#> [--repo OWNER/REPO]
#
# Output: one marker hash per line (the 16-hex tail after
# `post-pr-review:v1:`). Empty output = no prior runs.
#
# Exit codes:
#   0  ok (even if no markers found)
#   1  gh API failure
#   3  invocation error

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <PR#> [--repo OWNER/REPO]" >&2
  exit 3
fi

PR="$1"
shift
REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$REPO" ]]; then
  if ! REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null); then
    echo "could not resolve repo" >&2
    exit 1
  fi
fi

if ! gh api "repos/$REPO/pulls/$PR/comments" --paginate --jq '.[].body' 2>/dev/null \
  | grep -oE 'post-pr-review:v1:[0-9a-f]{16}' \
  | sed 's/post-pr-review:v1://' \
  | sort -u; then
  # grep exit 1 is "no matches" — that's a normal case, not an error.
  exit 0
fi
