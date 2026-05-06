#!/usr/bin/env bats
# Phase 2 PR 1 — lock the `pull` verb's §4.1 local-emit contract.
#
# The current binary already implements §4.1; this file pins that behavior so
# later phase-2 PRs (PR 4 `--to` removal, PR 5 alias removal) cannot regress
# the local-emit data flow. See docs/specs/handoff-skill/spec/4-data-flow-components.md §4.1
# and docs/specs/handoff-skill/spec/5-interfaces-apis.md §5.2.1.
#
# Pinned contract:
#   1. `pull <query>` renders the <handoff> block to stdout (§4.1 step 5/6).
#   2. `pull` is local-only — DOTCLAUDE_HANDOFF_REPO pointing at a non-existent
#      path must not break it; nothing reaches the remote (§4.1 "No transport").
#   3. `pull --from <cli>` narrows resolution to that CLI's root (§4.1 step 2a,
#      ARCH-3 priority order).
#   4. `pull --from <cli>` against a query that doesn't exist in <cli>'s root
#      exits non-zero (§5.3.2 "no session matches").
#
# Deliberately NOT pinned (out-of-spec per §5.2.1; removed in later PRs):
#   --to (PR 4), --summary / -o / `--out-dir` (PR 5).

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  export XDG_CONFIG_HOME="$TEST_HOME"
  # Repo path that does not exist. If any pull codepath touches git, the
  # path-not-found error surfaces immediately. Pull must succeed regardless.
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/dotclaude-pull-contract-$$"
  # `pull` itself does not deprecate-warn; this guards against an incidental
  # collapse-to-bare-positional regression from leaking stderr noise.
  export DOTCLAUDE_QUIET=1

  CLAUDE_UUID="aaaa1111-2222-2222-2222-222222222222"
  CODEX_UUID="eeee5555-6666-6666-6666-666666666666"
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  make_codex_session_tree "$TEST_HOME" "$CODEX_UUID"
  CLAUDE_SHORT="${CLAUDE_UUID:0:8}"
  CODEX_SHORT="${CODEX_UUID:0:8}"
  export CLAUDE_UUID CODEX_UUID CLAUDE_SHORT CODEX_SHORT
}

teardown() {
  rm -rf "$TEST_HOME"
}

@test "pull <query>: renders <handoff> block with origin/session/cwd attrs (§4.1 step 5)" {
  run node "$BIN" pull "$CLAUDE_SHORT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff "* ]]
  [[ "$output" == *"</handoff>"* ]]
  [[ "$output" == *"origin=\"claude\""* ]]
  [[ "$output" == *"session=\"$CLAUDE_SHORT\""* ]]
  [[ "$output" == *"cwd="* ]]
}

@test "pull <query>: never touches \$DOTCLAUDE_HANDOFF_REPO (§4.1 'no transport')" {
  # The repo path is bogus. If any pull codepath reaches git, we'd see a
  # path-not-found error in stderr or a non-zero exit. Neither must happen.
  run node "$BIN" pull "$CLAUDE_SHORT"
  [ "$status" -eq 0 ]
  # Defensive: fail loudly if any git invocation trace appears. This catches
  # accidental coupling to remote codepaths under future refactors.
  [[ "$output" != *"git: "* ]]
  [[ "$output" != *"could not"* ]]
  [[ "$output" != *"/nonexistent/"* ]]
}

@test "pull --from claude <query>: narrows to claude root and renders" {
  # Both claude (CLAUDE_UUID) and codex (CODEX_UUID) sessions are seeded.
  # `--from claude` must filter to the claude root; the claude short-id
  # resolves there.
  run node "$BIN" pull "$CLAUDE_SHORT" --from claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"origin=\"claude\""* ]]
}

@test "pull --from codex <claude-short>: rejects with non-zero exit (§5.3.2 no session matches)" {
  # The claude short-id is not present in the codex root. With --from codex,
  # the resolver MUST fail rather than falling back to other roots — that's
  # the ARCH-3 single-pathed contract (--from pins the source, no implicit
  # widening).
  run node "$BIN" pull "$CLAUDE_SHORT" --from codex
  [ "$status" -ne 0 ]
}
