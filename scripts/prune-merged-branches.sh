#!/usr/bin/env bash
# prune-merged-branches.sh — local-only pruner for empty-diff or merged-PR
# branches matching the handoff cleanup patterns. Default is --dry-run; nothing
# is deleted without an explicit --confirm.
#
# Usage:
#   bash scripts/prune-merged-branches.sh                 # alias for --dry-run
#   bash scripts/prune-merged-branches.sh --dry-run
#   bash scripts/prune-merged-branches.sh --confirm
#
# Local-only by design — the script refuses any flag mentioning push or
# delete-remote. Cleaning up published branches must be a separate, explicit
# operation (no scope creep).

set -euo pipefail

PATTERNS=(
  "feat/handoff-*"
  "fix/handoff-*"
  "test/handoff-*"
)

mode="dry-run"

for arg in "$@"; do
  case "$arg" in
    --dry-run) mode="dry-run" ;;
    --confirm) mode="confirm" ;;
    --help | -h)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *push* | *delete-remote*)
      echo "error: $arg is not supported — this script is local-only by design" >&2
      exit 64
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 64
      ;;
  esac
done

# Resolve the local "main" tip; tolerate detached HEAD by falling back to the
# branch ref directly.
if ! git rev-parse --verify --quiet main >/dev/null; then
  echo "error: no local 'main' branch — refusing to evaluate empty-diff against an unknown base" >&2
  exit 64
fi

deletable=()
kept=()

# Collect branches matching any pattern.
mapfile -t branches < <(
  for pat in "${PATTERNS[@]}"; do
    git for-each-ref --format='%(refname:short)' "refs/heads/$pat" 2>/dev/null
  done | sort -u
)

for branch in "${branches[@]}"; do
  [[ -z "$branch" ]] && continue
  # Skip the currently checked-out branch — it's never safe to delete.
  current=$(git branch --show-current 2>/dev/null || true)
  if [[ "$branch" = "$current" ]]; then
    kept+=("$branch (current branch)")
    continue
  fi

  # Empty-diff against main → deletable.
  if [[ -z "$(git diff "main..$branch" --stat 2>/dev/null || true)" ]]; then
    deletable+=("$branch")
    continue
  fi

  # Otherwise, check if the corresponding remote PR is merged. This requires
  # `gh` and a remote; tolerate absence by treating it as "kept".
  if command -v gh >/dev/null 2>&1; then
    merged_count=$(gh pr list --search "head:$branch" --state merged --json number --jq 'length' 2>/dev/null || echo 0)
    if [[ "${merged_count:-0}" -gt 0 ]]; then
      deletable+=("$branch")
      continue
    fi
  fi

  kept+=("$branch")
done

echo "prune-merged-branches.sh — mode: $mode"
echo "  patterns: ${PATTERNS[*]}"
echo
echo "deletable (${#deletable[@]}):"
for b in "${deletable[@]:-}"; do
  [[ -z "$b" ]] && continue
  echo "  - $b — would delete"
done
[[ "${#deletable[@]}" -eq 0 ]] && echo "  (none)"
echo
echo "kept (${#kept[@]}):"
for b in "${kept[@]:-}"; do
  [[ -z "$b" ]] && continue
  echo "  - $b"
done
[[ "${#kept[@]}" -eq 0 ]] && echo "  (none)"

if [[ "$mode" = "dry-run" ]]; then
  echo
  echo "dry-run: nothing deleted. Re-run with --confirm to delete the listed branches."
  exit 0
fi

echo
echo "deleting (--confirm):"
for b in "${deletable[@]:-}"; do
  [[ -z "$b" ]] && continue
  git branch -D "$b"
done
echo "done."
