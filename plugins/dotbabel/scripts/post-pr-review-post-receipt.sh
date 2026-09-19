#!/usr/bin/env bash
# post-pr-review-post-receipt.sh — leave a receipt that a post-pr-review run
# happened, so "the review ran" is observable on the pull request.
#
# Usage:
#   post-pr-review-post-receipt.sh <PR#> --sha <40-hex> --posted <N> \
#     [--skipped <N>] [--agents <csv>] [--profile <name>] [--repo OWNER/REPO]
#
# Why it exists: a run that finds nothing posts no comment at all, so a pull
# request whose review ran clean looks exactly like one that was never reviewed.
# The conductor's review-complete marker has to tell them apart, so every run
# ends here, findings or none.
#
# What it posts: ONE body-only review (POST /reviews with `commit_id`), whose
# first line is the receipt marker. The review is pinned by GitHub to `--sha`,
# the head the run reviewed, and carries an author association GitHub sets. The
# marker text lives in this file and in review-evidence.mjs
# (POST_PR_REVIEW_RECEIPT_MARKER); a bats test pins the two together.
#
# The receipt is guarded by plugins/dotbabel/hooks/guard-criteria-evidence.sh,
# so this script is the only sanctioned writer and never carries the marker in
# its own command text.
#
# Exit codes:
#   0  posted
#   1  HTTP non-2xx
#   3  invocation error

set -euo pipefail

MARKER='<!-- post-pr-review:v1:receipt -->'

PR=""
SHA=""
POSTED=""
SKIPPED="0"
AGENTS=""
PROFILE=""
REPO=""

usage() {
  echo "usage: $0 <PR#> --sha <40-hex> --posted <N> [--skipped <N>] [--agents <csv>] [--profile <name>] [--repo OWNER/REPO]" >&2
  exit 3
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha)     [[ $# -ge 2 ]] || usage; SHA="$2"; shift 2 ;;
    --posted)  [[ $# -ge 2 ]] || usage; POSTED="$2"; shift 2 ;;
    --skipped) [[ $# -ge 2 ]] || usage; SKIPPED="$2"; shift 2 ;;
    --agents)  [[ $# -ge 2 ]] || usage; AGENTS="$2"; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || usage; PROFILE="$2"; shift 2 ;;
    --repo)    [[ $# -ge 2 ]] || usage; REPO="$2"; shift 2 ;;
    --*)       usage ;;
    *)         [[ -z "$PR" ]] || usage; PR="$1"; shift ;;
  esac
done

# Validate before anything reaches the network. `--sha` becomes `commit_id`, and
# a receipt pinned to the wrong commit would vouch for a review that never saw it.
[[ "$PR" =~ ^[0-9]+$ ]] || usage
[[ "$SHA" =~ ^[0-9a-fA-F]{40}$ ]] || usage
[[ "$POSTED" =~ ^[0-9]+$ ]] || usage
[[ "$SKIPPED" =~ ^[0-9]+$ ]] || usage

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi

BODY="${MARKER}"$'\n'"post-pr-review: ${POSTED} posted, ${SKIPPED} skipped (already posted) on ${SHA:0:8}"
if [[ -n "$AGENTS" ]]; then
  BODY+=$'\n'"agents: ${AGENTS}"
  [[ -n "$PROFILE" ]] && BODY+=" (profile: ${PROFILE})"
elif [[ -n "$PROFILE" ]]; then
  BODY+=$'\n'"profile: ${PROFILE}"
fi

PAYLOAD=$(mktemp)
trap 'rm -f "$PAYLOAD"' EXIT

# jq --arg keeps every free-text value data: nothing here is ever re-parsed by a shell.
jq -n --arg sha "$SHA" --arg body "$BODY" \
  '{commit_id: $sha, event: "COMMENT", body: $body}' >"$PAYLOAD"

if ! gh api "repos/$REPO/pulls/$PR/reviews" --method POST --input "$PAYLOAD"; then
  echo "POST /reviews failed" >&2
  exit 1
fi
