#!/usr/bin/env bats
# Phase 2 PR 3 — lock the `push` verb's §5.5.2 mandatory-`--from` contract.
#
# Pinned contract (§5.5.2):
#   1. `push` without <query> and without --from: exits 64 (usage error).
#   2. `push --from <cli>` without <query>: exits 0 (resolves latest in CLI root).
#   3. `push <query>` without --from: exits 0 (explicit query exempts the rule).
#   4. `push <query> --from <cli>`: exits 0 (narrowed push unchanged).
#
# Deliberately NOT pinned:
#   env-detection fallback (removed; not in §5.5.2 new surface).

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export XDG_CONFIG_HOME="$TEST_HOME"
  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"
  export DOTCLAUDE_QUIET=1

  CLAUDE_UUID="dddd4444-9999-9999-9999-999999999999"
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  CLAUDE_SHORT="${CLAUDE_UUID:0:8}"
  export CLAUDE_UUID CLAUDE_SHORT TRANSPORT_REPO
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

@test "push without <query> and without --from: exits 64 (§5.5.2)" {
  run node "$BIN" push
  [ "$status" -eq 64 ]
}

@test "push --from claude without <query>: exits 0 (§5.5.2 happy path)" {
  run node "$BIN" push --from claude
  [ "$status" -eq 0 ]
}

@test "push <query> without --from: exits 0 (explicit query exempts the rule)" {
  run node "$BIN" push "$CLAUDE_SHORT"
  [ "$status" -eq 0 ]
}

@test "push <query> --from claude: exits 0 (narrowed explicit push)" {
  run node "$BIN" push "$CLAUDE_SHORT" --from claude
  [ "$status" -eq 0 ]
}
