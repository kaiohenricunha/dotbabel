#!/usr/bin/env bats
# Behavior tests for plugins/dotclaude/scripts/handoff-resolve.sh.
# Resolves <cli> <identifier> to an absolute JSONL file path.
# Supports: claude (uuid|latest), copilot (uuid|latest),
#           codex (uuid|alias|latest).

load helpers

RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"

# Build a hermetic $HOME with fake session trees for the three CLIs.
# Fixtures are minimal: just enough for path resolution and alias scan.
setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Claude: ~/.claude/projects/<slug>/<uuid>.jsonl
  mkdir -p "$TEST_HOME/.claude/projects/-home-user-projects-demo"
  printf '{"cwd":"/home/user/projects/demo","sessionId":"aaaa1111-1111-1111-1111-111111111111","version":"2.1"}\n' \
    > "$TEST_HOME/.claude/projects/-home-user-projects-demo/aaaa1111-1111-1111-1111-111111111111.jsonl"
  # Make a second, newer claude session so `latest` picks it.
  sleep 0.01
  mkdir -p "$TEST_HOME/.claude/projects/-home-user-projects-other"
  printf '{"cwd":"/home/user/projects/other","sessionId":"bbbb2222-2222-2222-2222-222222222222","version":"2.1"}\n' \
    > "$TEST_HOME/.claude/projects/-home-user-projects-other/bbbb2222-2222-2222-2222-222222222222.jsonl"

  # Third claude session with a customTitle record (the `claude --resume "<name>"` alias).
  sleep 0.01
  mkdir -p "$TEST_HOME/.claude/projects/-home-user-projects-demo"
  CLAUDE_ALIAS_FILE="$TEST_HOME/.claude/projects/-home-user-projects-demo/cccc1111-1111-1111-1111-111111111111.jsonl"
  printf '{"cwd":"/home/user/projects/demo","sessionId":"cccc1111-1111-1111-1111-111111111111","version":"2.1"}\n{"type":"custom-title","customTitle":"my-feature","sessionId":"cccc1111-1111-1111-1111-111111111111"}\n' \
    > "$CLAUDE_ALIAS_FILE"
  export CLAUDE_ALIAS_FILE

  # Copilot: ~/.copilot/session-state/<uuid>/events.jsonl
  mkdir -p "$TEST_HOME/.copilot/session-state/cccc3333-3333-3333-3333-333333333333"
  printf '{"type":"session.start","data":{"cwd":null,"model":null,"sessionId":"cccc3333-3333-3333-3333-333333333333"}}\n' \
    > "$TEST_HOME/.copilot/session-state/cccc3333-3333-3333-3333-333333333333/events.jsonl"
  # Second, newer copilot session for `latest`.
  sleep 0.01
  mkdir -p "$TEST_HOME/.copilot/session-state/dddd4444-4444-4444-4444-444444444444"
  printf '{"type":"session.start","data":{"cwd":"/tmp","model":"gpt","sessionId":"dddd4444-4444-4444-4444-444444444444"}}\n' \
    > "$TEST_HOME/.copilot/session-state/dddd4444-4444-4444-4444-444444444444/events.jsonl"

  # Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
  mkdir -p "$TEST_HOME/.codex/sessions/2026/04/18"
  CODEX_ONE="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T10-00-00-eeee5555-5555-5555-5555-555555555555.jsonl"
  printf '{"type":"session_meta","payload":{"id":"eeee5555-5555-5555-5555-555555555555","cwd":"/work"}}\n{"type":"event_msg","payload":{"thread_id":"eeee5555-5555-5555-5555-555555555555","thread_name":"my-feature","type":"thread_renamed"}}\n' \
    > "$CODEX_ONE"
  # A second, newer codex rollout without a thread_name (for `latest`).
  sleep 0.01
  CODEX_TWO="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T11-00-00-ffff6666-6666-6666-6666-666666666666.jsonl"
  printf '{"type":"session_meta","payload":{"id":"ffff6666-6666-6666-6666-666666666666","cwd":"/work"}}\n' \
    > "$CODEX_TWO"
  export CODEX_ONE CODEX_TWO
}

teardown() {
  rm -rf "$TEST_HOME"
}

# -- claude ---------------------------------------------------------------

@test "resolve claude by full UUID" {
  run "$RESOLVE" claude aaaa1111-1111-1111-1111-111111111111
  [ "$status" -eq 0 ]
  [ "$output" = "$TEST_HOME/.claude/projects/-home-user-projects-demo/aaaa1111-1111-1111-1111-111111111111.jsonl" ]
}

@test "resolve claude by short UUID (first 8 hex)" {
  run "$RESOLVE" claude aaaa1111
  [ "$status" -eq 0 ]
  [ "$output" = "$TEST_HOME/.claude/projects/-home-user-projects-demo/aaaa1111-1111-1111-1111-111111111111.jsonl" ]
}

@test "resolve claude latest picks newest mtime" {
  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  # cccc1111 is created last (sleep 0.01 after bbbb2222) so it is the newest.
  [[ "$output" == *"cccc1111-1111-1111-1111-111111111111.jsonl" ]]
}

@test "resolve claude miss exits 2 with structured error" {
  run "$RESOLVE" claude 00000000-0000-0000-0000-000000000000
  [ "$status" -eq 2 ]
  [[ "$output" == *"handoff-resolve:"* ]]
  [[ "$output" == *"not found"* ]]
}

@test "resolve claude by customTitle alias" {
  run "$RESOLVE" claude my-feature
  [ "$status" -eq 0 ]
  [ "$output" = "$CLAUDE_ALIAS_FILE" ]
}

@test "resolve claude unknown customTitle exits 2" {
  run "$RESOLVE" claude nonexistent-feature-alias
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

# -- copilot --------------------------------------------------------------

@test "resolve copilot by full UUID" {
  run "$RESOLVE" copilot cccc3333-3333-3333-3333-333333333333
  [ "$status" -eq 0 ]
  [ "$output" = "$TEST_HOME/.copilot/session-state/cccc3333-3333-3333-3333-333333333333/events.jsonl" ]
}

@test "resolve copilot by short UUID" {
  run "$RESOLVE" copilot cccc3333
  [ "$status" -eq 0 ]
  [[ "$output" == *"cccc3333-3333-3333-3333-333333333333/events.jsonl" ]]
}

@test "resolve copilot latest picks newest mtime" {
  run "$RESOLVE" copilot latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"dddd4444-4444-4444-4444-444444444444/events.jsonl" ]]
}

@test "resolve copilot miss exits 2" {
  run "$RESOLVE" copilot 00000000-0000-0000-0000-000000000000
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

# -- codex ----------------------------------------------------------------

@test "resolve codex by full UUID" {
  run "$RESOLVE" codex eeee5555-5555-5555-5555-555555555555
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_ONE" ]
}

@test "resolve codex by short UUID" {
  run "$RESOLVE" codex eeee5555
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_ONE" ]
}

@test "resolve codex latest picks newest mtime" {
  run "$RESOLVE" codex latest
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_TWO" ]
}

@test "resolve codex by alias (thread_name scan)" {
  run "$RESOLVE" codex my-feature
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_ONE" ]
}

@test "resolve codex alias miss exits 2" {
  run "$RESOLVE" codex nonexistent-alias
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

@test "resolve codex UUID-shaped miss falls through to alias scan and exits 2" {
  # A UUID-shaped string that does not match any file or alias.
  run "$RESOLVE" codex 99999999-9999-9999-9999-999999999999
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

# -- usage / error paths --------------------------------------------------

@test "missing cli exits 64 with usage" {
  run "$RESOLVE"
  [ "$status" -eq 64 ]
  [[ "$output" == *"usage:"* ]]
}

@test "unknown cli exits 64" {
  run "$RESOLVE" foocli someid
  [ "$status" -eq 64 ]
  [[ "$output" == *"cli must be one of"* ]]
}

@test "missing identifier exits 64" {
  run "$RESOLVE" claude
  [ "$status" -eq 64 ]
  [[ "$output" == *"usage:"* ]]
}
