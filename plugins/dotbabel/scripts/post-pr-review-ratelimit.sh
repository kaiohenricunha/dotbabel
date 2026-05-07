#!/usr/bin/env bash
# post-pr-review-ratelimit.sh — parse x-ratelimit-* headers from a saved
# `gh api --include` response.
#
# Usage:
#   post-pr-review-ratelimit.sh <headers-file>
#
# Output: JSON {limit, remaining, used, reset}.
#
# Exit codes:
#   0  parsed ok
#   1  headers file missing or no x-ratelimit-* present (likely the call
#      itself failed; check the headers file directly)
#   3  invocation error
#
# Designed to be called immediately after post-pr-review-post-batch.sh or
# post-pr-review-post-single.sh by the orchestrator, which then decides
# whether to slow down (remaining < 50), stop and defer (remaining < 10),
# or proceed normally.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <headers-file>" >&2
  exit 3
fi

HEADERS="$1"
if [[ ! -f "$HEADERS" ]]; then
  echo "headers file not found: $HEADERS" >&2
  exit 1
fi

# Header casing varies across gh versions; match case-insensitively.
limit=$(grep -i '^x-ratelimit-limit:'     "$HEADERS" | awk '{print $2}' | tr -d '\r' | tail -1 || true)
remain=$(grep -i '^x-ratelimit-remaining:' "$HEADERS" | awk '{print $2}' | tr -d '\r' | tail -1 || true)
used=$(grep -i '^x-ratelimit-used:'        "$HEADERS" | awk '{print $2}' | tr -d '\r' | tail -1 || true)
reset=$(grep -i '^x-ratelimit-reset:'      "$HEADERS" | awk '{print $2}' | tr -d '\r' | tail -1 || true)

if [[ -z "$remain" ]]; then
  echo "no x-ratelimit-remaining in headers — call may have failed" >&2
  exit 1
fi

jq -n \
  --argjson limit "${limit:-0}" \
  --argjson remaining "$remain" \
  --argjson used "${used:-0}" \
  --argjson reset "${reset:-0}" \
  '{limit: $limit, remaining: $remaining, used: $used, reset: $reset}'
