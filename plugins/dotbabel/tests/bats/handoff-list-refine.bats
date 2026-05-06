#!/usr/bin/env bats
# Behavior tests for `handoff list` refinements (issue #89):
# - uniform row schema: Location | CLI | Short UUID | When
# - --from <cli> filter
# - --since <ISO> filter
# - --limit <N> / --all
# - stderr warning when --remote + missing DOTBABEL_HANDOFF_REPO
# - --json shape preserved with new fields

load helpers

bats_require_minimum_version 1.5.0

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Claude fixture (newest)
  mkdir -p "$TEST_HOME/.claude/projects/-home-u-demo"
  CLAUDE_FILE="$TEST_HOME/.claude/projects/-home-u-demo/aaaa1111-1111-1111-1111-111111111111.jsonl"
  cat > "$CLAUDE_FILE" <<'EOF'
{"type":"user","cwd":"/home/u/demo","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"hi"}}
EOF

  # Codex fixture (older by mtime)
  mkdir -p "$TEST_HOME/.codex/sessions/2026/04/18"
  CODEX_FILE="$TEST_HOME/.codex/sessions/2026/04/18/rollout-bbbb2222-2222-2222-2222-222222222222.jsonl"
  cat > "$CODEX_FILE" <<'EOF'
{"type":"session_meta","payload":{"id":"bbbb2222-2222-2222-2222-222222222222","cwd":"/work/demo","cli_version":"0.1"}}
EOF
  # Force codex file to be older than claude
  touch -d "2025-01-01 00:00:00" "$CODEX_FILE"

  # Bare transport repo
  TRANSPORT_REPO=$(mktemp -d)
  rm -rf "$TRANSPORT_REPO"
  git init -q --bare "$TRANSPORT_REPO"
  export DOTBABEL_HANDOFF_REPO="$TRANSPORT_REPO"

  export CLAUDE_FILE CODEX_FILE TRANSPORT_REPO
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

# -- Gap 4: uniform row schema --------------------------------------------

@test "list: header uses uniform schema Location | CLI | Short UUID | When" {
  run node "$BIN" list </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"Location"* ]]
  [[ "$output" == *"CLI"* ]]
  [[ "$output" == *"Short UUID"* ]]
  [[ "$output" == *"When"* ]]
  # Old schema leaks must be gone
  [[ "$output" != *"CLI / Branch"* ]]
  [[ "$output" != *"When / Commit"* ]]
}

@test "list: remote rows expose cli+short_id derived from branch, no raw branch column" {
  run node "$BIN" push aaaa1111
  [ "$status" -eq 0 ]
  run node "$BIN" list --remote </dev/null
  [ "$status" -eq 0 ]
  # CLI column should contain 'claude' for remote too
  [[ "$output" == *"remote"* ]]
  [[ "$output" == *"claude"* ]]
  [[ "$output" == *"aaaa1111"* ]]
}

# -- Gap 3: filter flags ---------------------------------------------------

@test "list --from claude narrows to the claude root only" {
  run node "$BIN" list --from claude </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" != *"bbbb2222"* ]]
}

@test "list --from codex narrows to the codex root only" {
  run node "$BIN" list --from codex </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" != *"aaaa1111"* ]]
}

@test "list --from bogus exits 64 with usage error" {
  run node "$BIN" list --from bogus </dev/null
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from"* ]] || [[ "$stderr" == *"--from"* ]]
}

@test "list --since filters older rows by mtime" {
  run node "$BIN" list --since 2026-01-01T00:00:00Z </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  # codex file was backdated to 2025 — must be filtered out
  [[ "$output" != *"bbbb2222"* ]]
}

@test "list --since rejects non-ISO input" {
  run node "$BIN" list --since not-a-date </dev/null
  [ "$status" -eq 64 ]
}

@test "list --limit 1 caps rows" {
  run node "$BIN" list --limit 1 </dev/null
  [ "$status" -eq 0 ]
  # Only the newest row should appear
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" != *"bbbb2222"* ]]
}

@test "list --all disables default cap" {
  run node "$BIN" list --all </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" == *"bbbb2222"* ]]
}

# -- Gap 5: stderr warning on missing transport env -----------------------

@test "list --remote with missing DOTBABEL_HANDOFF_REPO warns on stderr" {
  unset DOTBABEL_HANDOFF_REPO
  run --separate-stderr node "$BIN" list --remote </dev/null
  # exit 2 when only --remote requested and nothing to show
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"DOTBABEL_HANDOFF_REPO"* ]]
}

@test "list (default) with missing DOTBABEL_HANDOFF_REPO still succeeds via local rows" {
  unset DOTBABEL_HANDOFF_REPO
  run --separate-stderr node "$BIN" list </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  # Warning still emitted so users know remote was skipped
  [[ "$stderr" == *"DOTBABEL_HANDOFF_REPO"* ]]
}

# -- --json preserves new fields ------------------------------------------

@test "list --json emits location/cli/short_id/when per local row" {
  run node "$BIN" list --json </dev/null
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[0] | has("location") and has("cli") and has("short_id") and has("when")' >/dev/null
}

@test "list --json with remote rows exposes cli extracted from branch name" {
  run node "$BIN" push aaaa1111
  [ "$status" -eq 0 ]
  run node "$BIN" list --remote --json </dev/null
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.[] | select(.location == "remote") | .cli == "claude"' >/dev/null
}
