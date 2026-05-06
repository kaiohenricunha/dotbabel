#!/usr/bin/env bats
# Lock §5.5.1 output-path edge cases for pull (issue #152 sweep).
#
# Covered:
#   12a/12b  --summary: stdout is markdown, no <handoff> block
#   19b      --summary 2>/dev/null: summary still lands on stdout (OPS-2)
#   29       -o nonexistent-dir/file.md: exits 2 on ENOENT
#   30       -o /etc/file.md: exits 2 on EACCES (permission denied)
#   32b      -o existing-file (second write): exits 0, file present (silent overwrite)

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export XDG_CONFIG_HOME="$TEST_HOME"
  export DOTBABEL_HANDOFF_REPO="/nonexistent/pull-edges-$$"
  export DOTBABEL_QUIET=1

  CLAUDE_UUID="dddd1111-2222-2222-2222-222222222222"
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  CLAUDE_SHORT="${CLAUDE_UUID:0:8}"
  export CLAUDE_UUID CLAUDE_SHORT
}

teardown() {
  rm -rf "$TEST_HOME"
}

# --- cells 12a/12b: --summary mode -------------------------------------------

@test "pull --summary: stdout has no <handoff> tag (§5.5.1, cell 12a)" {
  run node "$BIN" pull "$CLAUDE_SHORT" --summary
  [ "$status" -eq 0 ]
  [[ "$output" != *"<handoff "* ]]
}

@test "pull --summary: stdout contains markdown summary header (§5.5.1, cell 12a)" {
  run node "$BIN" pull "$CLAUDE_SHORT" --summary
  [ "$status" -eq 0 ]
  [[ "$output" == *"**claude**"* ]]
}

@test "pull UUID --summary: stdout has no <handoff> tag (cell 12b)" {
  run node "$BIN" pull "$CLAUDE_UUID" --summary
  [ "$status" -eq 0 ]
  [[ "$output" != *"<handoff "* ]]
}

# --- cell 19b: --summary with stderr redirected (OPS-2 stream isolation) -----

@test "pull --summary 2>/dev/null: summary content still on stdout (cell 19b)" {
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' --summary 2>/dev/null"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
  [[ "$output" != *"<handoff "* ]]
}

# --- cell 29: -o into nonexistent directory ----------------------------------

@test "pull -o nonexistent-dir/file.md: exits 2 (ENOENT, cell 29)" {
  run node "$BIN" pull "$CLAUDE_SHORT" -o "$TEST_HOME/no-such-dir-$$/file.md"
  [ "$status" -eq 2 ]
}

# --- cell 30: -o into read-only location -------------------------------------

@test "pull -o /etc/file.md: exits 2 (EACCES, cell 30)" {
  run node "$BIN" pull "$CLAUDE_SHORT" -o "/etc/pull-edges-test-$$.md"
  [ "$status" -eq 2 ]
}

# --- cell 32b: silent overwrite ----------------------------------------------

@test "pull -o existing-file (second write): exits 0 and file still present (cell 32b)" {
  local out="$TEST_HOME/overwrite-test.md"
  run node "$BIN" pull "$CLAUDE_SHORT" -o "$out"
  [ "$status" -eq 0 ]
  [ -f "$out" ]
  run node "$BIN" pull "$CLAUDE_SHORT" -o "$out"
  [ "$status" -eq 0 ]
  [ -f "$out" ]
}
