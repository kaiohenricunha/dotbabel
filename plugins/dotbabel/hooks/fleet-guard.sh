#!/usr/bin/env bash
# Claude Code hook entry for `dotbabel fleet`: cross-session file claims.
#
# Register it in ~/.claude/settings.json (see docs/fleet.md):
#   PreToolUse, matcher "Edit|Write|MultiEdit|NotebookEdit":  fleet-guard.sh pre-edit
#   SessionStart:                                              fleet-guard.sh session-start
#
# pre-edit      The first edit to a file in a governed repo claims it for the
#               session. An edit to a path that another live session claims
#               gets a PreToolUse "deny" whose reason names the owner to
#               SendMessage; after the escalation window it becomes an "ask".
# session-start Prints the live claims of the session's repo as context.
#
# This file only finds and runs bin/dotbabel-fleet.mjs, which holds the
# logic. bootstrap.sh symlinks it into ~/.claude/hooks/, so it resolves its
# own symlink to locate the checkout.
#
# Fails open: without node, without the bin, or on any error it exits 0 with
# no output, and the edit goes ahead. A broken ledger never blocks work.
#
# Off switch: DOTBABEL_FLEET_MODE=off in the environment Claude Code starts
# with, or "fleet": { "mode": "off" } in a repo's .dotbabel.json.

[ "${DOTBABEL_FLEET_MODE:-}" = "off" ] && exit 0
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
bin="$here/../bin/dotbabel-fleet.mjs"
[ -f "$bin" ] || exit 0

node "$bin" hook "${1:-}" || exit 0
