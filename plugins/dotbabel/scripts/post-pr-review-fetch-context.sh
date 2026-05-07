#!/usr/bin/env bash
# post-pr-review-fetch-context.sh — fetch the diff + PR metadata.
#
# Usage:
#   post-pr-review-fetch-context.sh <PR#> [--repo OWNER/REPO]
#
# Side effect: writes the unified diff to /tmp/post-pr-review-<PR>.diff.
#
# Output: JSON with fields:
#   headSHA, diffPath, files (array), title, body
#
# Exit codes:
#   0  ok
#   1  PR not found / API failure
#   3  invocation error

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <PR#> [--repo OWNER/REPO]" >&2
  exit 3
fi

PR="$1"
shift
REPO_FLAG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_FLAG+=(--repo "$2")
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

DIFFPATH="/tmp/post-pr-review-${PR}.diff"

if ! gh pr diff "$PR" "${REPO_FLAG[@]}" >"$DIFFPATH" 2>/dev/null; then
  echo '{"error":"failed to fetch diff"}' >&2
  exit 1
fi

if ! META=$(gh pr view "$PR" "${REPO_FLAG[@]}" --json headRefOid,title,body,files 2>/dev/null); then
  echo '{"error":"failed to fetch metadata"}' >&2
  exit 1
fi

echo "$META" | jq --arg p "$DIFFPATH" \
  '. + {diffPath: $p, headSHA: .headRefOid} | del(.headRefOid)'
