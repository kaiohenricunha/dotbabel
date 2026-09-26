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
# post-tool     PostToolUse on every tool: records a `gh pr merge` the session
#               ran, then tells the session about merges it has not seen.
# prompt        UserPromptSubmit: tells an idle session about those merges.
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

# post-tool and prompt run on every tool call and every prompt, so bash
# decides whether node has work: a `gh pr merge` to record (post-tool only),
# or an event newer than this session's seen marker. Otherwise exit at once.
input=""
case "${1:-}" in
  post-tool | prompt)
    input=$(cat)
    LC_ALL=C # glob order and [[ > ]] must match node's byte order
    state="${DOTBABEL_FLEET_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-}/.local/state}/dotbabel/fleet}"
    work=0
    if [ "$1" = post-tool ] && [[ $input =~ \"tool_name\"[[:space:]]*:[[:space:]]*\"Bash\" ]] && [[ $input == *"gh pr merge"* ]]; then
      work=1
    elif [[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([A-Za-z0-9_-]+)\" ]]; then
      sid=${BASH_REMATCH[1]}
      newest=""
      for f in "$state"/events/*.json; do [ -e "$f" ] && newest=${f##*/}; done
      seen=""
      [ -r "$state/seen/$sid" ] && read -r seen <"$state/seen/$sid"
      [ -n "$newest" ] && [[ $newest > $seen ]] && work=1
    fi
    [ "$work" = 1 ] || exit 0
    ;;
esac

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

if [ -n "$input" ]; then
  printf '%s' "$input" | node "$bin" hook "$1" || exit 0
else
  node "$bin" hook "${1:-}" || exit 0
fi
