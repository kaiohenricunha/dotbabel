#!/usr/bin/env bash
# refresh-worktrees.sh — for each active worktree under .claude/worktrees/,
# run `git fetch origin main` and `git merge --ff-only origin/main` if the
# worktree is clean. Report (and skip) any dirty worktree.

set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

WT_BASE="$ROOT/.claude/worktrees"
[ -d "$WT_BASE" ] || { echo "no worktrees at $WT_BASE"; exit 0; }

git fetch origin main

for wt in "$WT_BASE"/*/; do
  [ -d "$wt" ] || continue
  name=$(basename "$wt")
  (
    cd "$wt"
    if ! git diff --quiet || ! git diff --cached --quiet; then
      echo "SKIP (dirty): $name"
      exit 0
    fi
    if git merge-base --is-ancestor origin/main HEAD; then
      echo "OK:   $name (up to date)"
      exit 0
    fi
    if git merge --ff-only origin/main; then
      echo "FF:   $name"
    else
      echo "CONFLICT: $name (manual resolution needed)"
    fi
  )
done
