#!/usr/bin/env bash
# Claude Code SessionStart hook for `dotbabel task`: print the open tasks of
# the session's worktree as context.
#
# Register it in ~/.claude/settings.json (see docs/hooks.md):
#   SessionStart:   task-context.sh
#
# A task is the contract (goal, done_when) and the state (phase, decisions,
# pending) of work without a spec, kept in <git-dir>/dotbabel/tasks/. This
# hook lets a new or resumed session read that state instead of a retelling.
#
# This file only finds and runs bin/dotbabel-task.mjs, which holds the logic.
# bootstrap.sh symlinks it into ~/.claude/hooks/, so it resolves its own
# symlink to locate the checkout.
#
# Fails open: without node, without the bin, or on any error it exits 0 with
# no output, and the session starts as usual.

command -v node >/dev/null 2>&1 || exit 0

src="${BASH_SOURCE[0]}"
while [ -L "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)" || exit 0
  src="$(readlink "$src")"
  case "$src" in
    /*) ;;
    *) src="$dir/$src" ;;
  esac
done
here="$(cd -P "$(dirname "$src")" && pwd)" || exit 0
bin="$here/../bin/dotbabel-task.mjs"
[ -f "$bin" ] || exit 0

node "$bin" hook session-start || exit 0
