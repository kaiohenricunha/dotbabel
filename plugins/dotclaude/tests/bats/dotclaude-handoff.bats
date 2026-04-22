#!/usr/bin/env bats
# Power-user sub-command tests for plugins/dotclaude/bin/dotclaude-handoff.mjs.
#
# The PRIMARY public surface (bare <query>, push, pull, list) is covered
# by dotclaude-handoff-five-form.bats. This file covers the legacy
# power-user subs still reachable for scripting: resolve / describe /
# digest / file. Each takes an explicit <cli> <id>.

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  mkdir -p "$TEST_HOME/.claude/projects/-home-u-proj"
  SESSION_FILE="$TEST_HOME/.claude/projects/-home-u-proj/aaaa1111-1111-1111-1111-111111111111.jsonl"
  cat > "$SESSION_FILE" <<'EOF'
{"type":"user","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","version":"2.1","message":{"content":"Fix the retry loop"}}
{"type":"user","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"Run the full test suite"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"OK running now."}]}}
{"type":"custom-title","customTitle":"my-feature","sessionId":"aaaa1111-1111-1111-1111-111111111111"}
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

@test "--version exits 0 and emits semver" {
  run node "$BIN" --version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]
}

@test "--help exits 0 and mentions the five forms" {
  run node "$BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"push"* ]]
  [[ "$output" == *"pull"* ]]
  [[ "$output" == *"list"* ]]
}

@test "bare dotclaude-handoff prints usage and exits 0 (no push)" {
  run node "$BIN"
  [ "$status" -eq 0 ]
  [[ "$output" == *"push"* ]]
  [[ "$output" == *"pull"* ]]
  [[ "$output" == *"list"* ]]
  # Guardrail: a successful push would emit `[scrubbed N secrets]` and
  # a `handoff/<cli>/...` branch name. Neither may appear.
  [[ "$output" != *"scrubbed"* ]]
  [[ "$output" != *"handoff/dotclaude/"* ]]
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
  echo "$output" | jq -e '.origin.cli == "claude"' >/dev/null
  echo "$output" | jq -e '.origin.session_id == "aaaa1111-1111-1111-1111-111111111111"' >/dev/null
  echo "$output" | jq -e '.user_prompts | length >= 2' >/dev/null
}

@test "digest emits a <handoff> block with next-step tuned for --to codex" {
  run node "$BIN" digest claude aaaa1111 --to codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"</handoff>"* ]]
  [[ "$output" == *"Next step"* ]]
}

@test "digest --to claude produces imperative next step" {
  run node "$BIN" digest claude aaaa1111 --to claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "unknown cli in power-user sub exits 64" {
  run node "$BIN" resolve bogus abcd1234
  [ "$status" -eq 64 ]
}
