#!/usr/bin/env bats
# Observability tests: stderr prefixes, exit-code matrix, JSON/help/version
# contracts. Each test asserts a *shape* callers can rely on to distinguish
# user errors (64) from runtime errors (2) from success (0).

load helpers

RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"
EXTRACT="$REPO_ROOT/plugins/dotclaude/scripts/handoff-extract.sh"
DESCRIPTION="$REPO_ROOT/plugins/dotclaude/scripts/handoff-description.sh"
HANDOFF_BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  [ -x "$EXTRACT" ] || chmod +x "$EXTRACT"
  [ -x "$DESCRIPTION" ] || chmod +x "$DESCRIPTION"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
}

teardown() {
  rm -rf "$TEST_HOME"
}

# -- stderr prefix contract: each tool tags its own messages -------------

@test "handoff-resolve.sh usage errors carry 'usage:' prefix on stderr" {
  # `run` captures stderr into $output because there's no stdout-only split.
  # What matters is that consumers grepping stderr see the sentinel.
  run "$RESOLVE"
  [ "$status" -eq 64 ]
  [[ "$output" == *"usage:"* ]]
}

@test "handoff-resolve.sh runtime errors carry 'handoff-resolve:' prefix" {
  run "$RESOLVE" claude 00000000-0000-0000-0000-000000000000
  [ "$status" -eq 2 ]
  [[ "$output" == *"handoff-resolve:"* ]]
}

@test "handoff-extract.sh runtime errors carry 'handoff-extract:' prefix" {
  run "$EXTRACT" meta claude /nonexistent/path.jsonl
  [ "$status" -eq 2 ]
  [[ "$output" == *"handoff-extract:"* ]]
}

@test "handoff-description.sh runtime errors carry 'handoff-description:' prefix" {
  run "$DESCRIPTION" encode
  [ "$status" -eq 2 ]
  [[ "$output" == *"handoff-description:"* ]]
}

@test "dotclaude-handoff Node runtime errors carry 'dotclaude-handoff:' prefix" {
  run node "$HANDOFF_BIN" nonexistent-query-xyz
  [ "$status" -eq 2 ]
  [[ "$output" == *"dotclaude-handoff:"* ]]
}

# -- exit-code matrix ----------------------------------------------------

@test "exit-code matrix: resolve (0 success / 2 miss / 64 usage)" {
  make_claude_session_tree "$TEST_HOME" "aaaa1111-1111-1111-1111-111111111111"

  # 0 — a successful resolve
  run "$RESOLVE" claude aaaa1111-1111-1111-1111-111111111111
  [ "$status" -eq 0 ]

  # 2 — runtime miss
  run "$RESOLVE" claude 00000000-0000-0000-0000-000000000000
  [ "$status" -eq 2 ]

  # 64 — usage error (missing identifier)
  run "$RESOLVE" claude
  [ "$status" -eq 64 ]

  # 64 — unknown cli
  run "$RESOLVE" foocli someid
  [ "$status" -eq 64 ]
}

# -- JSON output contract ------------------------------------------------

@test "describe --json emits valid JSON parsable by jq" {
  make_claude_session_tree "$TEST_HOME" "aaaa1111-1111-1111-1111-111111111111"
  run node "$HANDOFF_BIN" describe claude latest --json
  [ "$status" -eq 0 ]
  # jq must be able to parse the entire output as a single JSON document.
  # If it is malformed, jq exits non-zero and the chained assertion fails.
  echo "$output" | jq -e . >/dev/null
}

# -- --help / --version contracts ---------------------------------------

@test "dotclaude-handoff --version exits 0 and prints to stdout" {
  run node "$HANDOFF_BIN" --version
  [ "$status" -eq 0 ]
  # Semantic version line should be first; no "usage:" or error prefix.
  [[ "${lines[0]}" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]
}

@test "dotclaude-handoff --help exits 0 and names itself in output" {
  run node "$HANDOFF_BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"dotclaude handoff"* ]]
}
