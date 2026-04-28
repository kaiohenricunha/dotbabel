#!/usr/bin/env bats
# Tests for dotclaude-handoff.mjs: the canonical `pull` verb (--summary, -o,
# --json) + deprecated power-user aliases (describe/digest/file). `pull`
# collapses the old four-form local surface under one verb (#87).
#
# Remote transport tests (push/fetch/list) live in dotclaude-handoff-five-form.bats.

load helpers

bats_require_minimum_version 1.5.0

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

@test "--help exits 0 and mentions pull fetch and list" {
  run node "$BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"push"* ]]
  [[ "$output" == *"pull"* ]]
  [[ "$output" == *"fetch"* ]]
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

# -- canonical `pull` verb --------------------------------------------------

@test "pull --summary emits markdown with cwd and prompts" {
  run node "$BIN" pull aaaa1111 --summary
  [ "$status" -eq 0 ]
  [[ "$output" == *"claude"* ]]
  [[ "$output" == *"/home/u/proj"* ]]
  [[ "$output" == *"Fix the retry loop"* ]]
  [[ "$output" == *"Run the full test suite"* ]]
}

@test "pull --summary --json emits structured JSON" {
  run node "$BIN" pull aaaa1111 --summary --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.origin.cli == "claude"' >/dev/null
  echo "$output" | jq -e '.origin.session_id == "aaaa1111-1111-1111-1111-111111111111"' >/dev/null
  echo "$output" | jq -e '.user_prompts | length >= 2' >/dev/null
}

@test "pull --json emits structured digest JSON" {
  run node "$BIN" pull aaaa1111 --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.origin.cli == "claude"' >/dev/null
  echo "$output" | jq -e '.user_prompts | length >= 2' >/dev/null
  echo "$output" | jq -e '.assistant_turns | type == "array"' >/dev/null
  echo "$output" | jq -e '.next_step_suggestion | type == "string"' >/dev/null
  echo "$output" | jq -e '.to == "claude"' >/dev/null
}

@test "pull -o - forces stdout" {
  run node "$BIN" pull aaaa1111 -o -
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "pull -o <tmpfile> writes to exact path" {
  local outfile
  outfile=$(mktemp)
  run node "$BIN" pull aaaa1111 -o "$outfile"
  [ "$status" -eq 0 ]
  [ -f "$outfile" ]
  grep -q '<handoff' "$outfile"
  rm -f "$outfile"
}

@test "pull -o auto writes a handoff doc to disk (non-git fallback)" {
  # Run from a non-git temp dir so the binary falls back to
  # $HOME/.claude/handoffs/ instead of <repo>/docs/handoffs/.
  run bash -c "cd \"$TEST_HOME\" && HOME=\"$TEST_HOME\" node \"$BIN\" pull aaaa1111 -o auto"
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  [ -f "$output" ]
  grep -q '<handoff' "$output"
}

@test "pull --summary -o auto writes a summary note to disk" {
  run bash -c "cd \"$TEST_HOME\" && HOME=\"$TEST_HOME\" node \"$BIN\" pull aaaa1111 --summary -o auto"
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  [ -f "$output" ]
  grep -q 'Fix the retry loop' "$output"
}

@test "pull <cli> <uuid> exits 64 with the breaking-change message" {
  run node "$BIN" pull claude aaaa1111
  [ "$status" -eq 64 ]
  [[ "$output" == *"no longer takes a <cli> positional"* ]]
  [[ "$output" == *"--from claude"* ]]
}

@test "pull <unmatched> with DOTCLAUDE_HANDOFF_REPO set appends fetch hint" {
  run --separate-stderr env HOME="$TEST_HOME" DOTCLAUDE_HANDOFF_REPO="/tmp/fake-repo" \
    node "$BIN" pull nonexistent-xyz
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"fetch"* ]]
}

@test "pull <unmatched> without DOTCLAUDE_HANDOFF_REPO emits no fetch hint" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    node "$BIN" pull nonexistent-xyz
  [ "$status" -eq 2 ]
  [[ "$stderr" != *"fetch <id>"* ]]
}

# -- deprecated aliases (describe / digest / file) -------------------------

@test "describe emits deprecation warning on stderr" {
  run --separate-stderr node "$BIN" describe claude aaaa1111
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"deprecated"* ]]
  [[ "$stderr" == *"pull aaaa1111 --summary"* ]]
  [[ "$output" == *"Fix the retry loop"* ]]
}

@test "digest emits deprecation warning on stderr" {
  run --separate-stderr node "$BIN" digest claude aaaa1111
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"deprecated"* ]]
  [[ "$stderr" == *"pull aaaa1111"* ]]
  [[ "$output" == *"<handoff"* ]]
}

@test "file emits deprecation warning on stderr" {
  run --separate-stderr bash -c "cd \"$TEST_HOME\" && HOME=\"$TEST_HOME\" node \"$BIN\" file claude aaaa1111"
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"deprecated"* ]]
  [[ "$stderr" == *"pull aaaa1111 -o auto"* ]]
}

@test "DOTCLAUDE_QUIET=1 suppresses deprecation on describe" {
  run --separate-stderr env HOME="$TEST_HOME" DOTCLAUDE_QUIET=1 \
    node "$BIN" describe claude aaaa1111
  [ "$status" -eq 0 ]
  [[ "$stderr" != *"deprecated"* ]]
  [[ "$output" == *"Fix the retry loop"* ]]
}

@test "unknown cli in power-user sub exits 64" {
  run node "$BIN" resolve bogus abcd1234
  [ "$status" -eq 64 ]
}
