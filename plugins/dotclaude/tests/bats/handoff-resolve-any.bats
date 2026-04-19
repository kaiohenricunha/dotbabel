#!/usr/bin/env bats
# Behavior tests for the `any` mode of plugins/dotclaude/scripts/handoff-resolve.sh.
#
# The `any` mode probes all three session roots (claude, copilot, codex)
# and:
#   - returns the single matching path when exactly one root resolves
#   - on collision (two or more roots match), exits 2 with a TSV
#     candidate list on stderr. One line per candidate:
#       <cli>\t<session-id>\t<path>\t<label>
#   - on no match, exits 2 with a "no session matches" message

load helpers

RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Claude fixture: a session with customTitle "refactor" (for collision test),
  # plus a plain one and a newer one for `latest`.
  mkdir -p "$TEST_HOME/.claude/projects/-home-u-demo"
  CLAUDE_ALIAS_FILE="$TEST_HOME/.claude/projects/-home-u-demo/cccc1111-1111-1111-1111-111111111111.jsonl"
  printf '{"cwd":"/home/u/demo","sessionId":"cccc1111-1111-1111-1111-111111111111","version":"2.1"}\n{"type":"custom-title","customTitle":"refactor","sessionId":"cccc1111-1111-1111-1111-111111111111"}\n' \
    > "$CLAUDE_ALIAS_FILE"
  CLAUDE_PLAIN_FILE="$TEST_HOME/.claude/projects/-home-u-demo/aaaa2222-2222-2222-2222-222222222222.jsonl"
  printf '{"cwd":"/home/u/demo","sessionId":"aaaa2222-2222-2222-2222-222222222222","version":"2.1"}\n' \
    > "$CLAUDE_PLAIN_FILE"

  # Copilot fixture
  COPILOT_DIR="$TEST_HOME/.copilot/session-state/dddd3333-3333-3333-3333-333333333333"
  mkdir -p "$COPILOT_DIR"
  COPILOT_FILE="$COPILOT_DIR/events.jsonl"
  printf '{"type":"session.start","data":{"cwd":"/tmp","model":"gpt","sessionId":"dddd3333-3333-3333-3333-333333333333"}}\n' \
    > "$COPILOT_FILE"

  # Codex fixture: a rollout WITH thread_name "refactor" (collision with claude)
  mkdir -p "$TEST_HOME/.codex/sessions/2026/04/18"
  CODEX_ALIAS_FILE="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T10-00-00-eeee5555-5555-5555-5555-555555555555.jsonl"
  printf '{"type":"session_meta","payload":{"id":"eeee5555-5555-5555-5555-555555555555","cwd":"/work"}}\n{"type":"event_msg","payload":{"thread_id":"eeee5555-5555-5555-5555-555555555555","thread_name":"refactor","type":"thread_renamed"}}\n' \
    > "$CODEX_ALIAS_FILE"

  # Newer codex rollout — explicit mtime ordering via `touch -t` (POSIX,
  # portable across GNU and BSD/macOS), since `sleep` fractions are
  # unreliable across filesystems (tmpfs mtime resolution is often 1s).
  CODEX_NEWEST_FILE="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T11-00-00-ffff6666-6666-6666-6666-666666666666.jsonl"
  printf '{"type":"session_meta","payload":{"id":"ffff6666-6666-6666-6666-666666666666","cwd":"/work"}}\n' \
    > "$CODEX_NEWEST_FILE"
  touch -t 202604180900.00 "$CLAUDE_ALIAS_FILE"
  touch -t 202604181000.00 "$CLAUDE_PLAIN_FILE"
  touch -t 202604181100.00 "$COPILOT_FILE"
  touch -t 202604181200.00 "$CODEX_ALIAS_FILE"
  touch -t 202604181300.00 "$CODEX_NEWEST_FILE"

  export CLAUDE_ALIAS_FILE CLAUDE_PLAIN_FILE COPILOT_FILE CODEX_ALIAS_FILE CODEX_NEWEST_FILE
}

teardown() {
  rm -rf "$TEST_HOME"
}

@test "any: resolves claude full UUID" {
  run "$RESOLVE" any aaaa2222-2222-2222-2222-222222222222
  [ "$status" -eq 0 ]
  [ "$output" = "$CLAUDE_PLAIN_FILE" ]
}

@test "any: resolves claude short UUID" {
  run "$RESOLVE" any aaaa2222
  [ "$status" -eq 0 ]
  [ "$output" = "$CLAUDE_PLAIN_FILE" ]
}

@test "any: resolves claude customTitle alias when unique" {
  # Temporarily break the codex collision fixture to ensure customTitle
  # scan still works. Rename just the codex alias record away.
  sed -i 's/refactor/refactor-codex/' "$CODEX_ALIAS_FILE"
  run "$RESOLVE" any refactor
  [ "$status" -eq 0 ]
  [ "$output" = "$CLAUDE_ALIAS_FILE" ]
}

@test "any: resolves codex thread_name alias when unique" {
  # Temporarily break the claude collision fixture.
  sed -i 's/refactor/refactor-claude/' "$CLAUDE_ALIAS_FILE"
  run "$RESOLVE" any refactor
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_ALIAS_FILE" ]
}

@test "any: resolves codex full UUID" {
  run "$RESOLVE" any eeee5555-5555-5555-5555-555555555555
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_ALIAS_FILE" ]
}

@test "any: resolves copilot full UUID" {
  run "$RESOLVE" any dddd3333-3333-3333-3333-333333333333
  [ "$status" -eq 0 ]
  [ "$output" = "$COPILOT_FILE" ]
}

@test "any: latest picks newest across all three roots" {
  run "$RESOLVE" any latest
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_NEWEST_FILE" ]
}

@test "any: unknown identifier exits 2 with structured error" {
  run "$RESOLVE" any nonexistent-alias-xyz
  [ "$status" -eq 2 ]
  [[ "$output" == *"no session matches"* ]]
}

@test "any: collision across two CLIs exits 2 with TSV candidate list on stderr" {
  # Both claude customTitle and codex thread_name are "refactor" in the
  # default fixture.
  run "$RESOLVE" any refactor
  [ "$status" -eq 2 ]
  # Expect at least two candidate lines, each with 4 TSV fields.
  # Candidate line shape: <cli>\t<session-id>\t<path>\t<label>
  # bats' $output includes both stdout and stderr.
  [[ "$output" == *"claude"* ]]
  [[ "$output" == *"codex"* ]]
  [[ "$output" == *"cccc1111"* ]]
  [[ "$output" == *"eeee5555"* ]]
}

@test "any: missing identifier exits 64" {
  run "$RESOLVE" any
  [ "$status" -eq 64 ]
}

@test "any: graceful degrade when only one root exists" {
  # Remove copilot and codex fixtures; any <claude-uuid> should still work.
  rm -rf "$TEST_HOME/.copilot" "$TEST_HOME/.codex"
  run "$RESOLVE" any aaaa2222
  [ "$status" -eq 0 ]
  [ "$output" = "$CLAUDE_PLAIN_FILE" ]
}
