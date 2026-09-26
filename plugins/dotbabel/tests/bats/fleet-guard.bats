#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/hooks/fleet-guard.sh, the shell entry
# Claude Code runs for `dotbabel fleet`. The claim logic is covered by
# fleet-cli.test.mjs; these tests pin what only the wrapper does: find the bin
# through the ~/.claude/hooks symlink, forward stdin and the event, and fail
# open.
#
# Liveness is read from /proc, so the two "sessions" are real processes: this
# bats process and a sleeping child.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/hooks/fleet-guard.sh"

# Field 22 of /proc/<pid>/stat, counted after the last ") " of the name.
start_time() {
  awk '{ sub(/.*\) /, ""); print $20 }' "/proc/$1/stat"
}

register() {
  printf '{"pid":%d,"sessionId":"%s","procStart":"%s","name":"%s","status":"busy"}\n' \
    "$1" "$2" "$(start_time "$1")" "$3" >"$CLAUDE_CONFIG_DIR/sessions/$1.json"
}

setup() {
  [ -r /proc/self/stat ] || skip "needs /proc"
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/home/.claude/sessions" "$WORK/hooks" "$WORK/stub"
  # The layout bootstrap.sh creates: ~/.claude/hooks/<hook> -> checkout.
  ln -s "$HOOK" "$WORK/hooks/fleet-guard.sh"
  REPO="$WORK/widget"
  git init -q -b main "$REPO"
  git -C "$REPO" remote add origin git@github.com:acme/widget.git
  echo '{}' >"$REPO/.dotbabel.json"
  export HOME="$WORK/home" CLAUDE_CONFIG_DIR="$WORK/home/.claude" DOTBABEL_FLEET_STATE_DIR="$WORK/state"
  unset DOTBABEL_FLEET_MODE DOTBABEL_FLEET_ESCALATE_MINUTES XDG_STATE_HOME
  sleep 600 &
  PEER_PID=$!
  register "$$" sess-self self-pane
  register "$PEER_PID" sess-peer peer-pane
}

teardown() {
  [ -n "${PEER_PID:-}" ] && kill "$PEER_PID" 2>/dev/null
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  return 0
}

# edit <session-id> <repo-relative path> [hook]
edit() {
  local hook="${3:-$WORK/hooks/fleet-guard.sh}"
  local payload
  payload=$(printf '{"session_id":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/%s"}}' "$1" "$REPO" "$2")
  run bash -c 'printf "%s" "$1" | "$2" pre-edit' _ "$payload" "$hook"
}

@test "resolves its symlink, claims on the first edit, and denies a peer's edit" {
  edit sess-self docs/a.md
  [ "$status" -eq 0 ]
  [ -z "$output" ]

  edit sess-peer docs/a.md
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecision')" = "deny" ]
  printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason' | grep -q '"self-pane"'
}

@test "forwards the session-start event" {
  edit sess-self docs/a.md
  payload=$(printf '{"session_id":"sess-peer","source":"startup","cwd":"%s"}' "$REPO")
  run bash -c 'printf "%s" "$1" | "$2" session-start' _ "$payload" "$WORK/hooks/fleet-guard.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"self-pane"'* ]]
  [[ "$output" == *"docs/a.md"* ]]
}

@test "exits 0 with no output when node is not on PATH" {
  run env PATH="$WORK/stub" /bin/bash "$HOOK" pre-edit </dev/null
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "DOTBABEL_FLEET_MODE=off never starts node" {
  printf '#!/bin/sh\ntouch "%s/node-ran"\n' "$WORK" >"$WORK/stub/node"
  chmod +x "$WORK/stub/node"
  run env PATH="$WORK/stub:$PATH" DOTBABEL_FLEET_MODE=off "$WORK/hooks/fleet-guard.sh" pre-edit </dev/null
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -e "$WORK/node-ran" ]
}

@test "fails open when the bin crashes" {
  printf '#!/bin/sh\necho boom >&2\nexit 3\n' >"$WORK/stub/node"
  chmod +x "$WORK/stub/node"
  run env PATH="$WORK/stub:$PATH" "$WORK/hooks/fleet-guard.sh" pre-edit </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" != *"permissionDecision"* ]]
}

@test "fails open when the bin is not next to it" {
  mkdir -p "$WORK/loose/hooks"
  cp "$HOOK" "$WORK/loose/hooks/fleet-guard.sh"
  edit sess-self docs/a.md "$WORK/loose/hooks/fleet-guard.sh"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -d "$WORK/state" ]
}

# ------------------------------------------------ event feed fast path ----
#
# post-tool runs after every tool call and prompt runs on every prompt, so
# the wrapper decides in bash whether node has work. A stub node records
# each start and the stdin it got.

stub_node() {
  printf '#!/bin/sh\necho started >>"%s/node-calls"\ncat >"%s/node-stdin"\n' "$WORK" "$WORK" >"$WORK/stub/node"
  chmod +x "$WORK/stub/node"
}

post_tool() { # <payload> [event]
  run bash -c 'printf "%s" "$1" | PATH="$2:$PATH" "$3" "$4"' _ "$1" "$WORK/stub" "$WORK/hooks/fleet-guard.sh" "${2:-post-tool}"
}

@test "post-tool starts no node when there is no event and no merge" {
  stub_node
  post_tool '{"session_id":"sess-a","tool_name":"Read","tool_input":{}}'
  [ "$status" -eq 0 ]
  [ ! -e "$WORK/node-calls" ]
  mkdir -p "$WORK/state/events" "$WORK/state/seen"
  echo '{}' >"$WORK/state/events/000000000000001-1.json"
  echo "000000000000001-1.json" >"$WORK/state/seen/sess-a"
  post_tool '{"session_id":"sess-a","tool_name":"Read","tool_input":{}}'
  [ ! -e "$WORK/node-calls" ]
}

@test "post-tool starts node when an event is newer than the session's marker" {
  stub_node
  mkdir -p "$WORK/state/events" "$WORK/state/seen"
  echo "000000000000001-1.json" >"$WORK/state/seen/sess-a"
  echo '{}' >"$WORK/state/events/000000000000002-7.json"
  post_tool '{"session_id":"sess-a","tool_name":"Read","tool_input":{}}'
  [ "$(wc -l <"$WORK/node-calls")" -eq 1 ]
}

@test "post-tool starts node for a gh pr merge command, with the payload on stdin" {
  stub_node
  payload='{"session_id":"sess-a","tool_name":"Bash","tool_input":{"command":"gh pr merge 5 --squash"}}'
  post_tool "$payload"
  [ "$(wc -l <"$WORK/node-calls")" -eq 1 ]
  [ "$(cat "$WORK/node-stdin")" = "$payload" ]
}

@test "prompt ignores a gh pr merge in the prompt text but delivers new events" {
  stub_node
  post_tool '{"session_id":"sess-a","prompt":"please gh pr merge 5"}' prompt
  [ ! -e "$WORK/node-calls" ]
  mkdir -p "$WORK/state/events"
  echo '{}' >"$WORK/state/events/000000000000002-7.json"
  post_tool '{"session_id":"sess-a","prompt":"go on"}' prompt
  [ "$(wc -l <"$WORK/node-calls")" -eq 1 ]
}
