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
REPO_FLAG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
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

FIELDS="number,headRefOid,state,isDraft,headRepository,baseRepository,isCrossRepository,url"

if [[ -n "$PR" ]]; then
  if ! gh pr view "$PR" "${REPO_FLAG[@]}" --json "$FIELDS" 2>/dev/null; then
    echo '{"error":"PR not found"}' >&2
    exit 1
  fi
else
  if ! gh pr view "${REPO_FLAG[@]}" --json "$FIELDS" 2>/dev/null; then
    echo '{"error":"no PR for current branch — pass <PR#> explicitly: /post-pr-review 123"}' >&2
    exit 1
  fi
fi
