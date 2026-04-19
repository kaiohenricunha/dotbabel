#!/usr/bin/env bats
# High-cardinality stress tests. Each test is wrapped in `timeout` so a
# runaway N² hang fails fast instead of stalling CI — the budget is an
# upper bound ("not quadratic"), not a performance target.

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"
EXTRACT="$REPO_ROOT/plugins/dotclaude/scripts/handoff-extract.sh"

setup() {
  [ -x "$EXTRACT" ] || chmod +x "$EXTRACT"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
}

teardown() {
  rm -rf "$TEST_HOME" ${TRANSPORT_REPO:+"$TRANSPORT_REPO"}
}

@test "list --local over 10k codex sessions completes under 30s" {
  make_many_codex_sessions "$TEST_HOME" 10000
  # Count what was actually created (filesystem limits may cap the loop).
  local file_count
  file_count=$(find "$TEST_HOME/.codex/sessions" -name "rollout-*.jsonl" 2>/dev/null | wc -l)
  file_count=$(( file_count + 0 ))  # strip whitespace
  run timeout 30s node "$BIN" list --local
  [ "$status" -eq 0 ]
  local line_count
  line_count=$(printf '%s\n' "$output" | wc -l)
  # The list must enumerate substantially all created sessions (≥ 90%).
  # If file_count < 100 the fixture seeder itself failed; fail the gate.
  [ "$file_count" -ge 100 ]
  [ "$line_count" -ge $(( file_count * 9 / 10 )) ]
}

@test "pull <short-uuid> against 10k transport branches completes under 30s" {
  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"
  make_many_transport_branches "$TRANSPORT_REPO" 10000

  # index 5000 → 00001388 (seeded by make_many_transport_branches as %08x).
  run timeout 30s node "$BIN" pull 00001388 --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "extract meta against a file being appended returns a consistent snapshot" {
  # jq's `first(inputs | select(...))` short-circuits at the first match,
  # so the streaming read finishes before the background appender can
  # write. The output must reflect only the pre-append state.
  local uuid="aaaa1111-1111-1111-1111-111111111111"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  printf '{"cwd":"/snap","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$file"

  (
    sleep 0.2
    printf '{"cwd":"/LEAKED","sessionId":"bbbb2222-2222-2222-2222-222222222222"}\n' >> "$file"
  ) &
  local appender=$!

  run timeout 10s "$EXTRACT" meta claude "$file"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cwd":"/snap"'* ]]
  [[ "$output" != *'LEAKED'* ]]
  wait "$appender"
}

@test "extract meta on a file with a truncated final record succeeds by short-circuiting before the tail" {
  # jq's streaming first() short-circuits before reaching the truncated
  # tail, so the first valid record is still extractable. The contract
  # here is "does not hang, does not leak partial JSON".
  local uuid="cccc3333-3333-3333-3333-333333333333"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  {
    printf '{"cwd":"/ok","sessionId":"%s"}\n' "$uuid"
    printf '{"cwd":"/dang'
  } > "$file"

  run timeout 10s "$EXTRACT" meta claude "$file"
  [ "$status" -eq 0 ]
  [[ "$output" == *"\"session_id\":\"$uuid\""* ]]
  [[ "$output" != *'"/dang'* ]]
}
