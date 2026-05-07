#!/usr/bin/env bash
# post-pr-review-post-single.sh — post a single inline comment on a PR.
#
# Usage:
#   post-pr-review-post-single.sh <PR#> --commit-id <SHA> --path <file> \
#     --line <int> [--side RIGHT|LEFT] [--start-line <int>] \
#     --body-file <path> [--repo OWNER/REPO]
#
# Each call counts independently against the secondary rate limit. Used by
# `--mode inline` (per-comment loop) or when count == 1.
#
# Side effect: writes response headers to
#   ${TMPDIR:-/tmp}/post-pr-review-single-<PR>-<line>.headers
# so the orchestrator can read x-ratelimit-* between calls.
#
# Exit codes:
#   0  posted
#   1  HTTP non-2xx
#   3  invocation error

set -euo pipefail

PR=""
COMMIT_ID=""
FILE_PATH=""
LINE=""
SIDE="RIGHT"
START_LINE=""
BODY_FILE=""
REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit-id)  COMMIT_ID="$2"; shift 2 ;;
    --path)       FILE_PATH="$2"; shift 2 ;;
    --line)       LINE="$2"; shift 2 ;;
    --side)       SIDE="$2"; shift 2 ;;
    --start-line) START_LINE="$2"; shift 2 ;;
    --body-file)  BODY_FILE="$2"; shift 2 ;;
    --repo)       REPO="$2"; shift 2 ;;
    *)            PR="$1"; shift ;;
  esac
done

if [[ -z "$PR"        ]]; then echo "missing <PR#>" >&2; exit 3; fi
if [[ -z "$COMMIT_ID" ]]; then echo "missing --commit-id" >&2; exit 3; fi
if [[ -z "$FILE_PATH" ]]; then echo "missing --path" >&2; exit 3; fi
if [[ -z "$LINE"      ]]; then echo "missing --line" >&2; exit 3; fi
if [[ ! -f "$BODY_FILE" ]]; then echo "missing or unreadable --body-file" >&2; exit 3; fi

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi

PAYLOAD=$(mktemp)
trap 'rm -f "$PAYLOAD"' EXIT

if [[ -n "$START_LINE" ]]; then
  jq -n \
    --arg commit_id "$COMMIT_ID" \
    --arg path "$FILE_PATH" \
    --argjson line "$LINE" \
    --arg side "$SIDE" \
    --argjson start_line "$START_LINE" \
    --rawfile body "$BODY_FILE" \
    '{commit_id: $commit_id, path: $path, line: $line, side: $side, start_line: $start_line, start_side: $side, body: $body}' >"$PAYLOAD"
else
  jq -n \
    --arg commit_id "$COMMIT_ID" \
    --arg path "$FILE_PATH" \
    --argjson line "$LINE" \
    --arg side "$SIDE" \
    --rawfile body "$BODY_FILE" \
    '{commit_id: $commit_id, path: $path, line: $line, side: $side, body: $body}' >"$PAYLOAD"
fi

HEADERS="${TMPDIR:-/tmp}/post-pr-review-single-${PR}-${LINE}.headers"

if ! gh api "repos/$REPO/pulls/$PR/comments" \
  --method POST \
  --input "$PAYLOAD" \
  --include 2>"$HEADERS"; then
  echo "POST /comments failed (see $HEADERS for details)" >&2
  exit 1
fi
