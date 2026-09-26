#!/usr/bin/env bash
# CLAUDE_CODE_SHELL_PREFIX target for the `dotbabel fleet` CPU lanes.
#
# Set it in ~/.claude/settings.json, then restart each Claude Code session
# (see docs/fleet.md):
#   "env": { "CLAUDE_CODE_SHELL_PREFIX": "/home/<you>/.claude/hooks/fleet-shell-prefix.sh" }
#
# Claude Code then runs EVERY shell command it spawns as
#   fleet-shell-prefix.sh '<command line>'
# (Bash tool calls, hook commands, the status line, MCP server startup). This
# script sends a Bash tool call that runs a heavy test command — npm test,
# vitest, go test, pytest, and the like — through scripts/fleet-lane.sh, which
# waits for a free CPU lane and pins the command to it. Everything else runs
# at once, with the shell and flags Claude Code itself uses. The command text
# never changes, so permission rules still match it.
#
# Rules, because every command passes through here:
#   - Never write the command line anywhere. MCP server command lines carry
#     API keys, and Bash commands carry tokens.
#   - On any doubt, run the command unchanged.
#   - Stay bash 3.2 compatible (stock macOS) on the pass-through path.
#
# Off switches:
#   touch <state>/lanes.off      at once, in every session, no restart
#   DOTBABEL_FLEET_LANES=off     in the environment Claude Code starts with
# where <state> is $DOTBABEL_FLEET_STATE_DIR, else $XDG_STATE_HOME/dotbabel/fleet,
# else ~/.local/state/dotbabel/fleet.

# The documented shape is one argument. Anything else runs as it came.
if [ "$#" -ne 1 ]; then
  [ "$#" -eq 0 ] && exit 0
  exec "$@"
fi
script=$1

# A Bash tool call reads: <setup> && eval '<command>' [< /dev/null] && pwd -P >| <cwd file>
case "$script" in
  *"eval '"*"' && pwd -P >| "* | *"eval '"*"' < /dev/null && pwd -P >| "*) ;;
  *) exec bash -c "$script" ;; # hooks, the status line, MCP server startup
esac

# Claude Code runs a Bash tool call as `$SHELL -c -l <script>`; do the same.
shell=bash
case "${SHELL:-}" in
  */zsh | */bash) [ -x "$SHELL" ] && shell=$SHELL ;;
esac
run() { exec "$shell" -c -l "$script"; }

[ "${DOTBABEL_FLEET_LANES:-}" = off ] && run
[ -n "${DOTBABEL_LANE:-}" ] && run
state="${DOTBABEL_FLEET_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-}/.local/state}/dotbabel/fleet}"
[ -e "$state/lanes.off" ] && run

# The command Claude ran, with its '"'"' escapes undone.
rest=${script#*"eval '"}
case "$rest" in
  *"' < /dev/null && pwd -P >| "*) cmd=${rest%"' < /dev/null && pwd -P >| "*} ;;
  *) cmd=${rest%"' && pwd -P >| "*} ;;
esac
q="'"
cmd=${cmd//"$q\"$q\"$q"/$q}

# Start node only for a command that names a test tool AND a test verb, so
# `npm install` or `node -e` never pays for the check. Every command the
# detector (src/fleet/heavy.mjs) calls heavy must match both; a test pins that.
tools='(^|[^[:alnum:]_.-])(npm|pnpm|pnpx|yarn|bun|bunx|npx|vitest|jest|bats|playwright|stryker|go|pytest|py\.test|python[0-9.]*|uv|poetry|pipenv|hatch|tox|nox|make|gmake|cargo|mvn|mvnw|gradle|gradlew|node|dotbabel|dotbabel-local-attest|dotbabel-quality)([^[:alnum:]_-]|$)'
verbs='(^|[^[:alnum:]_-])(test|t|tst|coverage|attest|mutation|e2e|vitest|jest|bats|pytest|py\.test|tox|nox|nextest|verify|check|integration-test|stryker|local-attest|dotbabel-local-attest|--test|(test|check|coverage|e2e)[-_:.][[:alnum:]_:.-]*|[[:alnum:]]*Test)([^[:alnum:]_-]|$)'
[[ $cmd =~ $tools ]] && [[ $cmd =~ $verbs ]] || run
command -v node >/dev/null 2>&1 || run

# ~/.claude/hooks/<this> is a symlink into the dotbabel checkout.
src=${BASH_SOURCE[0]}
while [ -L "$src" ]; do
  dir=$(cd -P "$(dirname "$src")" && pwd) || run
  src=$(readlink "$src") || run
  case "$src" in
    /*) ;;
    *) src="$dir/$src" ;;
  esac
done
here=$(cd -P "$(dirname "$src")" && pwd) || run
check="$here/../scripts/fleet-lane-check.mjs"
lane="$here/../scripts/fleet-lane.sh"
[ -f "$check" ] && [ -f "$lane" ] || run

label=$(printf '%s' "$cmd" | node "$check" 2>/dev/null) || run
[ -n "$label" ] || run
exec bash "$lane" --name "$label" -- "$shell" -c -l "$script"
