#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/hooks/fleet-shell-prefix.sh, the
# CLAUDE_CODE_SHELL_PREFIX target of `dotbabel fleet` CPU lanes.
#
# Claude Code runs EVERY shell command it spawns through this wrapper: Bash
# tool calls, hook commands, the status line, and MCP server startup. So most
# of these tests pin fidelity: output, exit code, quoting, and the cwd file
# come out exactly as without the wrapper. The rest pin that only a heavy
# Bash tool command goes to a lane, and that the wrapper never stores the
# command it received.

load helpers

PREFIX="$REPO_ROOT/plugins/dotbabel/hooks/fleet-shell-prefix.sh"

setup() {
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/bin" "$WORK/home"
  # The wrapper starts login shells, as Claude Code does; keep the user's
  # dotfiles out of the test.
  export HOME="$WORK/home"
  export DOTBABEL_FLEET_STATE_DIR="$WORK/state"
  export SHELL=/bin/bash
  unset DOTBABEL_FLEET_LANES DOTBABEL_FLEET_LANE_COUNT DOTBABEL_FLEET_NCPU DOTBABEL_LANE
  # A fake npm that reports how many CPUs it may use.
  printf '#!/bin/sh\nnproc\n' >"$WORK/bin/npm"
  chmod +x "$WORK/bin/npm"
  export PATH="$WORK/bin:$PATH"
}

teardown() {
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  return 0
}

needs_tools() {
  command -v flock >/dev/null && command -v taskset >/dev/null || skip "needs flock and taskset"
}

# The script Claude Code passes for a Bash tool call:
#   <setup> && eval '<command>' [< /dev/null] && pwd -P >| <cwd file>
# with each ' in the command written as '"'"'.
bash_tool_script() {
  local cmd="$1" stdin_null="${2:-}" q="'"
  local escaped=${cmd//$q/$q\"$q\"$q}
  local redirect=""
  [ -n "$stdin_null" ] && redirect=" < /dev/null"
  printf '%s' "{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval '$escaped'$redirect && pwd -P >| $WORK/cwd"
}

# ------------------------------------------------------------- fidelity ----

@test "runs a hook-style command unchanged, with its output and exit code" {
  run "$PREFIX" 'echo "$HOME" | tr a-z A-Z; exit 3'
  [ "$status" -eq 3 ]
  [ "$output" = "$(printf '%s' "$HOME" | tr a-z A-Z)" ]
}

@test "runs an MCP-style startup command unchanged" {
  run "$PREFIX" "printf '%s-%s' one two"
  [ "$status" -eq 0 ]
  [ "$output" = "one-two" ]
}

@test "runs a Bash tool script: output, quoting, exit code, and the cwd file" {
  cd "$WORK"
  run "$PREFIX" "$(bash_tool_script "echo 'a  b' \"c'd\"")"
  [ "$status" -eq 0 ]
  [ "$output" = "a  b c'd" ]
  [ "$(cat "$WORK/cwd")" = "$(pwd -P)" ]

  run "$PREFIX" "$(bash_tool_script 'false' stdin-null)"
  [ "$status" -eq 1 ]
}

@test "runs a Bash tool script with the user's zsh when SHELL is zsh" {
  command -v zsh >/dev/null || skip "zsh not installed"
  SHELL="$(command -v zsh)" run "$PREFIX" "$(bash_tool_script 'echo "zsh=${ZSH_VERSION:+yes}"')"
  [ "$output" = "zsh=yes" ]
}

@test "passes other argument shapes straight through" {
  run "$PREFIX" echo two words
  [ "$output" = "two words" ]
  run "$PREFIX"
  [ "$status" -eq 0 ]
}

# ------------------------------------------------------------------ lanes ----

@test "runs a heavy Bash tool command in a CPU lane" {
  needs_tools
  DOTBABEL_FLEET_LANES=0 run "$PREFIX" "$(bash_tool_script 'npm test')"
  [ "$status" -eq 0 ]
  [ "$output" = "1" ]
}

@test "leaves a command that only mentions a test tool alone" {
  needs_tools
  [ "$(nproc)" -gt 1 ] || skip "needs more than one CPU"
  DOTBABEL_FLEET_LANES=0 run "$PREFIX" "$(bash_tool_script 'npm install')"
  [ "$output" -gt 1 ]
}

@test "leaves hook commands alone even when they name a test tool" {
  needs_tools
  [ "$(nproc)" -gt 1 ] || skip "needs more than one CPU"
  DOTBABEL_FLEET_LANES=0 run "$PREFIX" 'npm test'
  [ "$output" -gt 1 ]
}

@test "skips the lane when lanes are off or the kill-switch file exists" {
  needs_tools
  [ "$(nproc)" -gt 1 ] || skip "needs more than one CPU"
  DOTBABEL_FLEET_LANES=off run "$PREFIX" "$(bash_tool_script 'npm test')"
  [ "$output" -gt 1 ]
  mkdir -p "$WORK/state" && touch "$WORK/state/lanes.off"
  DOTBABEL_FLEET_LANES=0 run "$PREFIX" "$(bash_tool_script 'npm test')"
  [ "$output" -gt 1 ]
}

@test "never stores the command it received" {
  needs_tools
  DOTBABEL_FLEET_LANES=0 run "$PREFIX" "$(bash_tool_script 'npm test -- --token=SECRET123')"
  [ "$status" -eq 0 ]
  run grep -rq SECRET123 "$WORK/state"
  [ "$status" -ne 0 ]
}

@test "runs the command unchanged when node is not available" {
  [ "$(nproc)" -gt 1 ] || skip "needs more than one CPU"
  mkdir -p "$WORK/nonode"
  for tool in bash nproc; do ln -s "$(command -v "$tool")" "$WORK/nonode/$tool"; done
  printf '#!/bin/sh\nnproc\n' >"$WORK/nonode/npm"
  chmod +x "$WORK/nonode/npm"
  DOTBABEL_FLEET_LANES=0 run env PATH="$WORK/nonode" "$(command -v bash)" "$PREFIX" "$(bash_tool_script 'npm test')"
  [ "$status" -eq 0 ]
  # A login shell with this bare PATH can print profile noise first.
  [ "${lines[${#lines[@]}-1]}" -gt 1 ]
}
