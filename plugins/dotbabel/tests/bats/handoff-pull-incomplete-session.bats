#!/usr/bin/env bats
# Lock §4.1.1 session-validity rules: per-CLI marker-file requirement.
# Issue #149.
#
# A copilot directory without events.jsonl is invisible to the resolver:
#   case 1: cross-root resolver behavior (no --from)
#     pull <incomplete-prefix>: exit 2 (UUID lookup fails)
#   cases 2/3: narrowed --from copilot behavior
#     pull latest --from copilot: skips incomplete dir, picks valid one
#       even when the incomplete dir has the newer mtime
#     pull latest --from copilot: exit 2 + "no copilot session matches:
#       latest" when every dir is incomplete (§5.3.2 template)

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

# Lay down a copilot dir with the structural files copilot writes around
# the event log (workspace config, checkpoints/, files/, research/) but
# missing the only marker the resolver looks for: events.jsonl.
seed_incomplete_copilot() {
  local home="$1" uuid="$2"
  local dir="$home/.copilot/session-state/$uuid"
  mkdir -p "$dir/checkpoints" "$dir/files" "$dir/research"
  printf 'workspace: incomplete\n' > "$dir/workspace.yaml"
}

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export XDG_CONFIG_HOME="$TEST_HOME"
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/incomplete-session-$$"
  export DOTCLAUDE_QUIET=1

  INCOMPLETE_UUID="aaaaaaaa-1111-1111-1111-111111111111"
  VALID_UUID="bbbbbbbb-2222-2222-2222-222222222222"
  INCOMPLETE_SHORT="${INCOMPLETE_UUID:0:8}"
  VALID_SHORT="${VALID_UUID:0:8}"
  export INCOMPLETE_UUID VALID_UUID INCOMPLETE_SHORT VALID_SHORT
}

teardown() {
  rm -rf "$TEST_HOME"
}

# --- case 1: UUID lookup misses an incomplete dir (cross-root, no --from) ---

@test "pull <incomplete-prefix>: exits 2 — copilot dir without events.jsonl is invisible (§4.1.1)" {
  seed_incomplete_copilot "$TEST_HOME" "$INCOMPLETE_UUID"
  run node "$BIN" pull "$INCOMPLETE_SHORT"
  [ "$status" -eq 2 ]
  [[ "$output" == *"no session matches: $INCOMPLETE_SHORT"* ]]
}

# --- case 2: pull latest skips incomplete, picks valid (--from copilot) -----

@test "pull latest --from copilot: incomplete dir invisible to resolver regardless of dir/file mtimes (§4.1.1)" {
  # Seed both. Make the incomplete dir's marker mtime NEWER than the valid
  # dir's events.jsonl. If the resolver were tolerant of incomplete dirs
  # (e.g., taking newest dir mtime regardless of marker), it would pick
  # the incomplete one. The assertion proves marker presence is required;
  # mtime ordering is irrelevant when the marker is absent.
  seed_incomplete_copilot "$TEST_HOME" "$INCOMPLETE_UUID"
  make_copilot_session_tree "$TEST_HOME" "$VALID_UUID"
  touch -d '2026-01-01 00:00' "$TEST_HOME/.copilot/session-state/$VALID_UUID/events.jsonl"
  touch -d '2026-12-31 23:59' "$TEST_HOME/.copilot/session-state/$INCOMPLETE_UUID/workspace.yaml"

  run node "$BIN" pull latest --from copilot
  [ "$status" -eq 0 ]
  [[ "$output" == *"session=\"$VALID_SHORT\""* ]]
  [[ "$output" != *"session=\"$INCOMPLETE_SHORT\""* ]]
}

# --- case 3: all sessions incomplete → clean exit 2 + §5.3.2 template -------

@test "pull latest --from copilot: exits 2 with §5.3.2 template when all dirs incomplete" {
  # Pre-(d).9 helper-fix, this test passed because pick_newest exited 1 on
  # empty input which (via pipefail) silenced the resolver's structured
  # die_runtime — wrapper fallback "no copilot session matches: latest" then
  # fired. Post-fix, the resolver correctly emits "no copilot sessions found
  # under <root>" and the wrapper passes that through; the fallback path no
  # longer runs. The test now asserts on the canonical resolver message.
  seed_incomplete_copilot "$TEST_HOME" "$INCOMPLETE_UUID"
  seed_incomplete_copilot "$TEST_HOME" "$VALID_UUID"

  run node "$BIN" pull latest --from copilot
  [ "$status" -eq 2 ]
  [[ "$output" == *"no copilot sessions found under"* ]]
}
