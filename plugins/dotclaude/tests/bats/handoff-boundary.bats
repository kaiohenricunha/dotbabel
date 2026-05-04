#!/usr/bin/env bats
# Boundary tests for handoff shell scripts and JS CLI.
# Degenerate inputs: empty files, unicode, CRLF, whitespace in paths,
# prefix collisions, and negative/zero --limit values.

bats_require_minimum_version 1.5.0

load helpers

RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"
EXTRACT="$REPO_ROOT/plugins/dotclaude/scripts/handoff-extract.sh"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  [ -x "$EXTRACT" ] || chmod +x "$EXTRACT"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
}

teardown() {
  rm -rf "$TEST_HOME"
}

# -- empty-file behavior, per CLI ---------------------------------------

@test "extract meta claude on empty file returns null fields, exit 0" {
  # Claude meta uses `first(inputs | select(...)) // {}` — no match means
  # an empty shell; session_id becomes null via the fallback chain.
  local empty
  empty=$(mktemp)
  run "$EXTRACT" meta claude "$empty"
  rm -f "$empty"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"session_id":null'* ]]
}

@test "extract meta codex on empty file exits 2 with structured error" {
  local empty
  empty=$(mktemp)
  run "$EXTRACT" meta codex "$empty"
  rm -f "$empty"
  [ "$status" -eq 2 ]
  [[ "$output" == *"no session_meta record"* ]]
}

@test "extract meta copilot on empty file exits 2 with structured error" {
  local empty
  empty=$(mktemp)
  run "$EXTRACT" meta copilot "$empty"
  rm -f "$empty"
  [ "$status" -eq 2 ]
  [[ "$output" == *"no session.start record"* ]]
}

# -- JSONL format edge cases --------------------------------------------

@test "extract meta claude parses file with no trailing newline" {
  local uuid="aaaa1111-1111-1111-1111-111111111111"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  # No trailing newline — jq must still read the last record.
  printf '{"cwd":"/x","sessionId":"%s","version":"2.1"}' "$uuid" > "$file"
  run "$EXTRACT" meta claude "$file"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cwd":"/x"'* ]]
  [[ "$output" == *"\"session_id\":\"$uuid\""* ]]
}

@test "extract prompts claude preserves unicode verbatim" {
  local uuid="bbbb2222-2222-2222-2222-222222222222"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  printf '{"cwd":"/x","sessionId":"%s"}\n{"type":"user","message":{"content":"héllo wörld — 日本語 ✓"}}\n' \
    "$uuid" > "$file"
  run "$EXTRACT" prompts claude "$file"
  [ "$status" -eq 0 ]
  [[ "$output" == *"héllo wörld"* ]]
  [[ "$output" == *"日本語"* ]]
}

@test "resolve claude customTitle alias with emoji matches literally" {
  local uuid="cccc3333-3333-3333-3333-333333333333"
  local dir="$TEST_HOME/.claude/projects/-demo"
  mkdir -p "$dir"
  printf '{"cwd":"/x","sessionId":"%s"}\n{"type":"custom-title","customTitle":"🚀 launch","sessionId":"%s"}\n' \
    "$uuid" "$uuid" > "$dir/$uuid.jsonl"
  run --separate-stderr "$RESOLVE" claude "🚀 launch"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$uuid.jsonl" ]]
}

# -- whitespace in session roots ----------------------------------------

@test "resolve tolerates session roots with spaces in path" {
  # Locked in regression in Phase 1 too; repeat here under a boundary
  # framing to make the edge visible in the suite directory.
  export HOME="$TEST_HOME/home with spaces"
  mkdir -p "$HOME"
  make_claude_session_tree "$HOME" "dddd4444-4444-4444-4444-444444444444"
  run --separate-stderr "$RESOLVE" claude dddd4444
  [ "$status" -eq 0 ]
  [[ "$output" == *"dddd4444-4444-4444-4444-444444444444.jsonl" ]]
}

# -- short-UUID prefix collisions ---------------------------------------

@test "resolve picks newest when short-UUID prefix matches multiple files" {
  # Seed three claude sessions all starting with "abcd1234".
  local dir="$TEST_HOME/.claude/projects/-multi"
  mkdir -p "$dir"
  local older="$dir/abcd1234-0000-0000-0000-000000000001.jsonl"
  local mid="$dir/abcd1234-0000-0000-0000-000000000002.jsonl"
  local newer="$dir/abcd1234-0000-0000-0000-000000000003.jsonl"
  printf '{"cwd":"/x","sessionId":"abcd1234-0000-0000-0000-000000000001"}\n' > "$older"
  printf '{"cwd":"/x","sessionId":"abcd1234-0000-0000-0000-000000000002"}\n' > "$mid"
  printf '{"cwd":"/x","sessionId":"abcd1234-0000-0000-0000-000000000003"}\n' > "$newer"
  if ! touch -d '2026-01-01 00:00:00.100000000' "$older" 2>/dev/null; then
    skip "fractional-second touch not supported"
  fi
  touch -d '2026-01-01 00:00:00.500000000' "$mid"
  touch -d '2026-01-01 00:00:00.900000000' "$newer"
  run --separate-stderr "$RESOLVE" claude abcd1234
  [ "$status" -eq 0 ]
  [[ "$output" == *"000000000003.jsonl" ]]
}

# -- empty session tree --------------------------------------------------

@test "resolve any latest with no session roots exits 2" {
  # HOME has nothing under .claude/.copilot/.codex — all three die_runtime
  # and resolve_any reports "no session roots" or "no sessions found".
  run "$RESOLVE" any latest
  [ "$status" -eq 2 ]
  # Either branch of the error path is acceptable — both signal absence.
  [[ "$output" == *"no session"* ]]
}

@test "resolve any <id> with no session roots exits 2 with no-match error" {
  run "$RESOLVE" any aaaa1111
  [ "$status" -eq 2 ]
  [[ "$output" == *"no session"* ]]
}

# -- extract turns: limit normalization ---------------------------------

@test "extract turns with limit=0 is unbounded (returns every turn)" {
  # `0` is the documented unbounded sentinel — search uses it to scan every
  # assistant turn, not just the last 20. `handoff-extract.sh` translates
  # it to `tail -n +1`. Previous behavior (SIGPIPE from `tail -n 0`) was
  # a contract bug: search dropped matches in long sessions.
  local uuid="ffff6666-6666-6666-6666-666666666666"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  {
    printf '{"cwd":"/x","sessionId":"%s"}\n' "$uuid"
    for i in 1 2 3 4 5; do
      printf '{"type":"assistant","message":{"content":[{"type":"text","text":"turn %d"}]}}\n' "$i"
    done
  } > "$file"
  run "$EXTRACT" turns claude "$file" 0
  [ "$status" -eq 0 ]
  [[ "$output" == *"turn 1"* ]]
  [[ "$output" == *"turn 5"* ]]
}

@test "extract turns with absurdly large limit returns all turns" {
  local uuid="eeee5555-5555-5555-5555-555555555555"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  {
    printf '{"cwd":"/x","sessionId":"%s"}\n' "$uuid"
    for i in 1 2 3; do
      printf '{"type":"assistant","message":{"content":[{"type":"text","text":"turn-%d"}]}}\n' "$i"
    done
  } > "$file"
  run "$EXTRACT" turns claude "$file" 999999
  [ "$status" -eq 0 ]
  [[ "$output" == *"turn-1"* ]]
  [[ "$output" == *"turn-3"* ]]
}
