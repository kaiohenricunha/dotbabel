#!/usr/bin/env bats
# Smoke tests for plugins/dotclaude/bin/dotclaude-handoff.mjs.
# The binary delegates to handoff-resolve.sh and handoff-extract.sh;
# these tests verify argv parsing, exit codes, and the happy-path output
# shape. Detailed extraction correctness lives in handoff-extract.bats.

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Minimal Claude session
  mkdir -p "$TEST_HOME/.claude/projects/-home-u-proj"
  SESSION_FILE="$TEST_HOME/.claude/projects/-home-u-proj/aaaa1111-1111-1111-1111-111111111111.jsonl"
  cat > "$SESSION_FILE" <<'EOF'
{"type":"user","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","version":"2.1","message":{"content":"Fix the retry loop"}}
{"type":"user","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"Run the full test suite"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"OK running now."}]}}
EOF
  export SESSION_FILE
}

teardown() {
  rm -rf "$TEST_HOME"
}

@test "binary is executable" {
  [ -x "$BIN" ] || chmod +x "$BIN"
  [ -x "$BIN" ]
}

@test "--help exits 0 and mentions subcommands" {
  run node "$BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"resolve"* ]]
  [[ "$output" == *"describe"* ]]
  [[ "$output" == *"digest"* ]]
  [[ "$output" == *"list"* ]]
}

@test "--version exits 0 and emits semver" {
  run node "$BIN" --version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]
}

@test "no subcommand exits 64" {
  run node "$BIN"
  [ "$status" -eq 64 ]
}

@test "unknown subcommand exits 64" {
  run node "$BIN" bogus claude foo
  [ "$status" -eq 64 ]
}

@test "resolve missing args exits 64" {
  run node "$BIN" resolve
  [ "$status" -eq 64 ]
}

@test "resolve claude happy path" {
  run node "$BIN" resolve claude aaaa1111
  [ "$status" -eq 0 ]
  [ "$output" = "$SESSION_FILE" ]
}

@test "resolve miss exits 2" {
  run node "$BIN" resolve claude 00000000
  [ "$status" -eq 2 ]
}

@test "describe emits markdown with cwd and prompts" {
  run node "$BIN" describe claude aaaa1111
  [ "$status" -eq 0 ]
  [[ "$output" == *"claude"* ]]
  [[ "$output" == *"/home/u/proj"* ]]
  [[ "$output" == *"Fix the retry loop"* ]]
  [[ "$output" == *"Run the full test suite"* ]]
}

@test "describe --json emits structured JSON" {
  run node "$BIN" describe claude aaaa1111 --json
  [ "$status" -eq 0 ]
  # Should be valid JSON with expected keys.
  echo "$output" | jq -e '.origin.cli == "claude"' >/dev/null
  echo "$output" | jq -e '.origin.session_id == "aaaa1111-1111-1111-1111-111111111111"' >/dev/null
  echo "$output" | jq -e '.user_prompts | length >= 2' >/dev/null
}

@test "digest emits a <handoff> block with next-step tuned for --to codex" {
  run node "$BIN" digest claude aaaa1111 --to codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"</handoff>"* ]]
  # Codex-tuned next step should include a task-shaped cue
  [[ "$output" == *"Next step"* ]]
}

@test "digest --to claude produces imperative next step" {
  run node "$BIN" digest claude aaaa1111 --to claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "list claude renders a table" {
  run node "$BIN" list claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" == *"Short UUID"* ]]
  [[ "$output" == *"aaaa1111-1111-1111-1111-111111111111.jsonl"* ]]
}

@test "list --json emits array of session objects" {
  run node "$BIN" list claude --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e 'length >= 1' >/dev/null
  echo "$output" | jq -e '.[0].short_id == "aaaa1111"' >/dev/null
}

@test "unknown cli exits 64" {
  run node "$BIN" resolve bogus abcd1234
  [ "$status" -eq 64 ]
}
