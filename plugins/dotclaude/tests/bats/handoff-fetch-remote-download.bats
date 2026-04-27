#!/usr/bin/env bats
# Phase 2 PR 2 — lock the `fetch` verb's §4.3 remote-download contract.
#
# The current binary already implements §4.3; this file pins that behavior so
# later phase-2 PRs (PR 4 `--to` removal, PR 5 alias removal) cannot regress
# the remote-download data flow. See docs/specs/handoff-skill/spec/4-data-flow-components.md §4.3
# and docs/specs/handoff-skill/spec/5-interfaces-apis.md §5.2.3.
#
# Pinned contract:
#   1. `fetch <query>` returns the matched branch's handoff.md content
#      to stdout (§4.3 step 7).
#   2. `fetch` requires DOTCLAUDE_HANDOFF_REPO; unset → non-zero exit
#      (§4.3 step 2 requireTransportRepoStrict, no auto-bootstrap).
#   3. `fetch <query>` with no remote match exits non-zero (§5.3.4
#      "no remote handoffs match").
#   4. `fetch --from <wrong-cli>` filters out branches not in <cli>'s
#      segment of the branch path (§4.3 step 4f).
#
# Deliberately NOT pinned (extra-spec but tolerated; future PR may tighten):
#   --verify (currently accepted; not in §5.2.3).

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export XDG_CONFIG_HOME="$TEST_HOME"
  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"
  export DOTCLAUDE_QUIET=1

  CLAUDE_UUID="bbbb2222-7777-7777-7777-777777777777"
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  CLAUDE_SHORT="${CLAUDE_UUID:0:8}"
  export CLAUDE_UUID CLAUDE_SHORT TRANSPORT_REPO
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

@test "fetch <query>: returns the matched branch's handoff.md content (§4.3 step 7)" {
  # Push first so the bare repo has a branch to fetch.
  run node "$BIN" push "$CLAUDE_SHORT"
  [ "$status" -eq 0 ]

  run node "$BIN" fetch "$CLAUDE_SHORT"
  [ "$status" -eq 0 ]
  # The fetched content is the rendered <handoff> block from the push.
  [[ "$output" == *"<handoff "* ]]
  [[ "$output" == *"</handoff>"* ]]
  [[ "$output" == *"origin=\"claude\""* ]]
}

@test "fetch with DOTCLAUDE_HANDOFF_REPO unset: exits non-zero (§4.3 step 2)" {
  unset DOTCLAUDE_HANDOFF_REPO
  run node "$BIN" fetch "$CLAUDE_SHORT"
  [ "$status" -ne 0 ]
}

@test "fetch <query>: no remote match exits non-zero (§5.3.4)" {
  # Bare repo is initialized but empty (no push). Fetching anything must
  # fail with a "no match" code path, not silently return empty content.
  run node "$BIN" fetch "deadbeef"
  [ "$status" -ne 0 ]
}

@test "fetch --from codex: filters out claude-segment branches (§4.3 step 4f)" {
  # Push from the claude root. The branch lands under the claude <cli>
  # segment. Fetching with --from codex must filter it out and fail rather
  # than fall back to other CLIs.
  run node "$BIN" push "$CLAUDE_SHORT"
  [ "$status" -eq 0 ]

  run node "$BIN" fetch "$CLAUDE_SHORT" --from codex
  [ "$status" -ne 0 ]
}
