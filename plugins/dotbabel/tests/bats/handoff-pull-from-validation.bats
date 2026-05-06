#!/usr/bin/env bats
# Lock §5.3.2 rejection of empty/whitespace --from values (issue #147).
#
# Before this fix, `--from ""` was silently accepted because the truthiness
# guard (`argv.flags.from ? ...`) coerced "" to null, bypassing the CLIS
# membership check entirely. The fix uses `!== undefined` + `.trim()` so
# all three forms — empty string, whitespace-only, equals-empty — hit the
# same `fail(EXIT_CODES.USAGE, "--from must be one of: ...")` path as
# an already-rejected unknown value like `--from foo`.
#
# Cases:
#   1. --from ""       → exit 64 (was: silently accepted as no-from)
#   2. --from "   "    → exit 64 (whitespace-only, trimmed to "")
#   3. --from=         → exit 64 (equals-empty form; parseArgs yields "")
#   4. --from foo      → exit 64 (existing baseline, must not regress)
#   5. --from claude   → exit 0  (positive control)

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export XDG_CONFIG_HOME="$TEST_HOME"
  export DOTBABEL_HANDOFF_REPO="/nonexistent/from-validation-$$"
  export DOTBABEL_QUIET=1

  CLAUDE_UUID="cccc4444-5555-5555-5555-555555555555"
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  CLAUDE_SHORT="${CLAUDE_UUID:0:8}"
  export CLAUDE_UUID CLAUDE_SHORT
}

teardown() {
  rm -rf "$TEST_HOME"
}

@test "--from \"\": exit 64 (empty string must be rejected)" {
  run node "$BIN" pull latest --from ""
  [ "$status" -eq 64 ]
}

@test "--from \"\": error message names valid CLIs" {
  run node "$BIN" pull latest --from ""
  [[ "$output" == *"--from must be one of:"* ]]
}

@test "--from \"   \" (whitespace-only): exit 64" {
  run node "$BIN" pull latest --from "   "
  [ "$status" -eq 64 ]
}

@test "--from= (equals-empty): exit 64" {
  run node "$BIN" pull latest --from=
  [ "$status" -eq 64 ]
}

@test "--from foo (unknown CLI): exit 64 (existing baseline must not regress)" {
  run node "$BIN" pull latest --from foo
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from must be one of:"* ]]
}

@test "--from claude (valid CLI): exits 0 (positive control)" {
  run node "$BIN" pull "$CLAUDE_SHORT" --from claude
  [ "$status" -eq 0 ]
}
