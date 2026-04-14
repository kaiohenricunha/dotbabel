#!/usr/bin/env bats
# Behavior tests for plugins/harness/hooks/guard-destructive-git.sh
#
# Every test exercises the hook via stdin JSON, not a real Bash tool call,
# so the suite is hermetic and doesn't depend on Claude Code being installed.

load helpers

HOOK="$REPO_ROOT/plugins/harness/hooks/guard-destructive-git.sh"

setup() {
  [ -x "$HOOK" ] || chmod +x "$HOOK"
}

# ---------------- block paths ----------------

@test "blocks git reset --hard" {
  feed_hook_json "$HOOK" "git reset --hard HEAD~1"
  [ "$status" -eq 2 ]
  [[ "$output" == *"BLOCKED"* ]]
  [[ "$output" == *"BYPASS_DESTRUCTIVE_GIT=1"* ]]
}

@test "blocks git push --force" {
  feed_hook_json "$HOOK" "git push origin main --force"
  [ "$status" -eq 2 ]
}

@test "blocks git push -f" {
  feed_hook_json "$HOOK" "git push origin main -f"
  [ "$status" -eq 2 ]
}

@test "blocks git push --force-with-lease" {
  feed_hook_json "$HOOK" "git push origin main --force-with-lease"
  [ "$status" -eq 2 ]
}

@test "blocks git clean -fd" {
  feed_hook_json "$HOOK" "git clean -fd"
  [ "$status" -eq 2 ]
}

@test "blocks git clean -fx" {
  feed_hook_json "$HOOK" "git clean -fx"
  [ "$status" -eq 2 ]
}

@test "blocks git checkout ." {
  feed_hook_json "$HOOK" "git checkout ."
  [ "$status" -eq 2 ]
}

@test "blocks git restore ." {
  feed_hook_json "$HOOK" "git restore ."
  [ "$status" -eq 2 ]
}

@test "blocks git branch -D" {
  feed_hook_json "$HOOK" "git branch -D feature-branch"
  [ "$status" -eq 2 ]
}

@test "blocks git reset --hard with tab whitespace" {
  feed_hook_json "$HOOK" $'git\treset\t--hard'
  [ "$status" -eq 2 ]
}

@test "blocks chained: foo && git reset --hard" {
  feed_hook_json "$HOOK" "cd /tmp && git reset --hard HEAD~1"
  [ "$status" -eq 2 ]
}

# ---------------- allow paths ----------------

@test "allows git status" {
  feed_hook_json "$HOOK" "git status"
  [ "$status" -eq 0 ]
}

@test "allows git reset --soft (harmless)" {
  feed_hook_json "$HOOK" "git reset --soft HEAD~1"
  [ "$status" -eq 0 ]
}

@test "allows git push origin main (no force)" {
  feed_hook_json "$HOOK" "git push origin main"
  [ "$status" -eq 0 ]
}

@test "allows non-Bash tool calls" {
  run bash -c 'printf "%s" "$1" | "$2"' _ \
    '{"tool_name":"Read","tool_input":{"path":"foo.txt"}}' \
    "$HOOK"
  [ "$status" -eq 0 ]
}

@test "allows literal 'git reset --hard' inside a quoted echo" {
  # The command itself is not a git invocation — it's an echo of text. The
  # hook should inspect the shell command, which starts with `echo`, not `git`.
  feed_hook_json "$HOOK" 'echo "git reset --hard is dangerous"'
  [ "$status" -eq 0 ]
}

# ---------------- bypass ----------------

@test "BYPASS_DESTRUCTIVE_GIT=1 allows otherwise-blocked command" {
  payload=$(jq -n '{tool_name:"Bash", tool_input:{command:"git reset --hard"}}')
  run env BYPASS_DESTRUCTIVE_GIT=1 bash -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
}
