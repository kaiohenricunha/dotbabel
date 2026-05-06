#!/usr/bin/env bats
# Lock the §5.5.1 OPS-2 output-flag contract for `pull -o <path>`.
#
# §5.5.1 OPS-2 states: when -o is set, stdout MUST be empty; the destination
# path is written to stderr only. The file at the path contains the <handoff>
# block (or summary markdown) verbatim with mode 0644.
#
# Previously the binary wrote the path to stdout (process.stdout.write).
# This file pins the corrected behavior so no future refactor regresses it.
#
# Covered cases:
#   1. pull -o <path>         — stdout empty, stderr has path, file is <handoff>
#   2. pull --summary -o <p> — stdout empty, stderr has path, file is markdown
#   3. pull -o /dev/null      — stdout empty, exit 0 (null sink)
#   4. pull -o auto           — stdout empty, stderr has auto-placed path

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export XDG_CONFIG_HOME="$TEST_HOME"
  export DOTBABEL_HANDOFF_REPO="/nonexistent/pull-output-flag-$$"
  export DOTBABEL_QUIET=1

  CLAUDE_UUID="bbbb2222-3333-3333-3333-333333333333"
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  CLAUDE_SHORT="${CLAUDE_UUID:0:8}"
  export CLAUDE_UUID CLAUDE_SHORT

  STDERR_FILE="$TEST_HOME/stderr.txt"
  export STDERR_FILE
}

teardown() {
  rm -rf "$TEST_HOME"
}

# --- case 1: explicit path ---------------------------------------------------

@test "pull -o <path>: stdout is empty (§5.5.1 OPS-2)" {
  local out="$TEST_HOME/handoff-out.md"
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' -o '$out' 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "pull -o <path>: stderr contains the destination path" {
  local out="$TEST_HOME/handoff-out.md"
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' -o '$out' 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  grep -qF "$out" "$STDERR_FILE"
}

@test "pull -o <path>: file contains <handoff> block" {
  local out="$TEST_HOME/handoff-out.md"
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' -o '$out' 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  [ -f "$out" ]
  head -1 "$out" | grep -q "^<handoff "
}

@test "pull -o <path>: file mode is 0644" {
  local out="$TEST_HOME/handoff-out.md"
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' -o '$out' 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  [ "$(stat -c '%a' "$out")" = "644" ]
}

# --- case 2: --summary -o <path> ---------------------------------------------

@test "pull --summary -o <path>: stdout is empty" {
  local out="$TEST_HOME/summary-out.md"
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' --summary -o '$out' 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "pull --summary -o <path>: stderr contains the destination path" {
  local out="$TEST_HOME/summary-out.md"
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' --summary -o '$out' 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  grep -qF "$out" "$STDERR_FILE"
}

@test "pull --summary -o <path>: file contains markdown (not bare <handoff> block)" {
  local out="$TEST_HOME/summary-out.md"
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' --summary -o '$out' 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  [ -f "$out" ]
  grep -q "^\*\*claude\*\*" "$out"
}

# --- case 3: /dev/null sink ---------------------------------------------------

@test "pull -o /dev/null: stdout is empty and exits 0" {
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' -o /dev/null 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "pull -o /dev/null: stderr still emits the path" {
  run bash -c "node '$BIN' pull '$CLAUDE_SHORT' -o /dev/null 2>'$STDERR_FILE'"
  [ "$status" -eq 0 ]
  grep -q "/dev/null" "$STDERR_FILE"
}

# --- case 4: auto path -------------------------------------------------------

@test "pull -o auto: stdout is empty" {
  # Use a hermetic temp git repo so the auto-path writes to its docs/handoffs/
  # rather than polluting the real repo checkout.
  local tmp_repo; tmp_repo=$(make_tmp_git_repo)
  run bash -c "cd '$tmp_repo' && HOME='$TEST_HOME' DOTBABEL_QUIET=1 \
    DOTBABEL_HANDOFF_REPO='/nonexistent' \
    node '$BIN' pull '$CLAUDE_SHORT' -o auto 2>'$STDERR_FILE'"
  rm -rf "$tmp_repo" "${tmp_repo}-bare.git"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "pull -o auto: stderr contains the auto-placed path" {
  local tmp_repo; tmp_repo=$(make_tmp_git_repo)
  run bash -c "cd '$tmp_repo' && HOME='$TEST_HOME' DOTBABEL_QUIET=1 \
    DOTBABEL_HANDOFF_REPO='/nonexistent' \
    node '$BIN' pull '$CLAUDE_SHORT' -o auto 2>'$STDERR_FILE'"
  rm -rf "$tmp_repo" "${tmp_repo}-bare.git"
  [ "$status" -eq 0 ]
  grep -q "\.md$" "$STDERR_FILE"
}
