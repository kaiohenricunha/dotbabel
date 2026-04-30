#!/usr/bin/env bats
# Lock input-validation and injection-safety contracts for pull (issue #152 sweep).
#
# Covered:
#   22    pull "": exit 2 (resolver "no session matches")
#   23    pull "   ": whitespace-only, exit 2
#   24a   pull "abc": 3-char prefix, exit 2
#   24b   pull "a": single char, exit 2
#   25a   pull "abc;touch /tmp/...": semicolon injection — exit 2, sentinel absent
#   25a+  pull "$(touch /tmp/...)": command-substitution injection — exit 2, sentinel absent
#   25b   pull "abc def": embedded space, exit 2
#   26    pull (no positional): exit 64 per §5.3.2, error names the missing arg
#   27    pull latest uuid2 (two positionals): first-arg wins — exit 0 + session attr

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export XDG_CONFIG_HOME="$TEST_HOME"
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/pull-input-val-$$"
  export DOTCLAUDE_QUIET=1

  CLAUDE_UUID="eeee1111-2222-2222-2222-222222222222"
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  CLAUDE_SHORT="${CLAUDE_UUID:0:8}"
  export CLAUDE_UUID CLAUDE_SHORT
}

teardown() {
  rm -rf "$TEST_HOME"
}

# --- cells 22-24: degenerate positionals (all exit 2) ------------------------

@test 'pull "": exits 2 — resolver no-match (cell 22)' {
  run node "$BIN" pull ""
  [ "$status" -eq 2 ]
}

@test 'pull "   ": exits 2 — whitespace-only query (cell 23)' {
  run node "$BIN" pull "   "
  [ "$status" -eq 2 ]
}

@test 'pull "abc": exits 2 — 3-char prefix does not match 8-hex (cell 24a)' {
  run node "$BIN" pull "abc"
  [ "$status" -eq 2 ]
}

@test 'pull "a": exits 2 — single char (cell 24b)' {
  run node "$BIN" pull "a"
  [ "$status" -eq 2 ]
}

# --- cell 25a: shell injection — semicolon form ------------------------------

@test 'pull "abc;touch /tmp/...": exits 2, semicolon injection not executed (cell 25a)' {
  local sentinel="/tmp/sentinel-pull-semi-$$"
  rm -f "$sentinel"
  run node "$BIN" pull "abc;touch $sentinel"
  [ "$status" -eq 2 ]
  [ ! -e "$sentinel" ]
}

# --- cell 25a+: shell injection — command-substitution form ------------------

@test 'pull "$(touch /tmp/...)": exits 2, subshell injection not executed (cell 25a+)' {
  local sentinel="/tmp/sentinel-pull-csub-$$"
  rm -f "$sentinel"
  local payload="\$(touch $sentinel)"
  run node "$BIN" pull "$payload"
  [ "$status" -eq 2 ]
  [ ! -e "$sentinel" ]
}

# --- cell 25b: embedded space ------------------------------------------------

@test 'pull "abc def": exits 2 — space in query (cell 25b)' {
  run node "$BIN" pull "abc def"
  [ "$status" -eq 2 ]
}

# --- cell 26: missing positional (§5.3.2) ------------------------------------

@test "pull (no positional): exits 64 per §5.3.2 (cell 26)" {
  run node "$BIN" pull
  [ "$status" -eq 64 ]
}

@test "pull (no positional): error names the missing argument (cell 26)" {
  run node "$BIN" pull
  [ "$status" -eq 64 ]
  [[ "$output" == *"pull requires a <query>"* ]]
}

# --- cell 27: two positionals — first-arg wins -------------------------------

@test "pull latest uuid2 (two positionals): exits 0, first arg resolves (cell 27)" {
  run node "$BIN" pull latest "$CLAUDE_SHORT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"session=\"$CLAUDE_SHORT\""* ]]
}
