#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/hooks/task-context.sh, the SessionStart
# entry Claude Code runs for `dotbabel task`. The task logic is covered by
# task-cli.test.mjs; these tests pin what only the wrapper does: find the bin
# through the ~/.claude/hooks symlink, forward stdin, and fail open.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/hooks/task-context.sh"
BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-task.mjs"

setup() {
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/hooks" "$WORK/stub"
  # The layout bootstrap.sh creates: ~/.claude/hooks/<hook> -> checkout.
  ln -s "$HOOK" "$WORK/hooks/task-context.sh"
  REPO="$WORK/widget"
  git init -q -b main "$REPO"
  PAYLOAD=$(printf '{"session_id":"s","source":"startup","cwd":"%s"}' "$REPO")
}

teardown() {
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  return 0
}

start() {
  local hook="${1:-$WORK/hooks/task-context.sh}"
  run bash -c 'printf "%s" "$1" | "$2"' _ "$PAYLOAD" "$hook"
}

@test "resolves its symlink and prints an open task as context" {
  (cd "$REPO" && node "$BIN" new fix-login --goal "keep the target page" --done-when "the suite passes" >/dev/null)
  start
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "SessionStart" ]
  printf '%s' "$output" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "fix-login"
}

@test "is silent when the worktree has no open task" {
  start
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "exits 0 with no output when node is not on PATH" {
  run env PATH="$WORK/stub" /bin/bash "$HOOK" </dev/null
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "fails open when the bin crashes" {
  printf '#!/bin/sh\necho boom >&2\nexit 3\n' >"$WORK/stub/node"
  chmod +x "$WORK/stub/node"
  run env PATH="$WORK/stub:$PATH" "$WORK/hooks/task-context.sh" </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" != *"hookSpecificOutput"* ]]
}

@test "fails open when the bin is not next to it" {
  (cd "$REPO" && node "$BIN" new fix-login --goal "g" --done-when "d" >/dev/null)
  mkdir -p "$WORK/loose/hooks"
  cp "$HOOK" "$WORK/loose/hooks/task-context.sh"
  start "$WORK/loose/hooks/task-context.sh"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
