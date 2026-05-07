#!/usr/bin/env bash
# post-pr-review-post-batch.sh — post an atomic PR review with bundled inline
# comments.
#
# Usage:
#   post-pr-review-post-batch.sh <PR#> --comments-json <path> \
#     [--body-file <path>] [--event COMMENT|REQUEST_CHANGES|APPROVE] \
#     [--repo OWNER/REPO]
#
# --comments-json: path to a JSON file containing an array:
#   [
#     {"path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "..."}
#   ]
#
# Posts ONE atomic POST /reviews call. All comments + event are committed
# together. Counts as one content-creating request against the secondary rate
# limit, regardless of how many inline comments are bundled.
#
# Side effect: writes raw response headers (`gh api --include`) to
#   ${TMPDIR:-/tmp}/post-pr-review-batch-<PR>.headers
# so the orchestrator can read x-ratelimit-* via post-pr-review-ratelimit.sh.
#
# Output: response JSON from gh api (created review id, url, etc.).
#
# Exit codes:
#   0  posted successfully
#   1  HTTP non-2xx (body printed to stderr)
#   3  invocation error

set -euo pipefail

PR=""
COMMENTS=""
BODY_FILE=""
EVENT="COMMENT"
REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --comments-json) COMMENTS="$2"; shift 2 ;;
    --body-file)     BODY_FILE="$2"; shift 2 ;;
    --event)         EVENT="$2"; shift 2 ;;
    --repo)          REPO="$2"; shift 2 ;;
    *)               PR="$1"; shift ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "usage: $0 <PR#> --comments-json <path> [--body-file <path>] [--event COMMENT|REQUEST_CHANGES|APPROVE]" >&2
  exit 3
fi
if [[ ! -f "$COMMENTS" ]]; then
  echo "comments file not found: $COMMENTS" >&2
  exit 3
fi

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi

PAYLOAD=$(mktemp)
trap 'rm -f "$PAYLOAD"' EXIT

if [[ -n "$BODY_FILE" && -f "$BODY_FILE" ]]; then
  jq -n \
    --arg event "$EVENT" \
    --rawfile body "$BODY_FILE" \
    --slurpfile comments "$COMMENTS" \
    '{event: $event, body: $body, comments: $comments[0]}' >"$PAYLOAD"
else
  jq -n \
    --arg event "$EVENT" \
    --slurpfile comments "$COMMENTS" \
    '{event: $event, comments: $comments[0]}' >"$PAYLOAD"
fi

HEADERS="${TMPDIR:-/tmp}/post-pr-review-batch-${PR}.headers"

if ! gh api "repos/$REPO/pulls/$PR/reviews" \
  --method POST \
  --input "$PAYLOAD" \
  --include 2>"$HEADERS"; then
  echo "POST /reviews failed (see $HEADERS for details)" >&2
  exit 1
fi
