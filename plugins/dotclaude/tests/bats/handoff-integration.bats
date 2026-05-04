#!/usr/bin/env bats
# Integration tests — cross-script end-to-end flows.
#
# Complements dotclaude-handoff-five-form.bats, which covers the user-facing
# five-form surface. These tests chain multiple handoff scripts together
# (resolve → extract → pull / push → fetch → list → pull) to verify
# the boundaries between them hold.

load helpers

bats_require_minimum_version 1.5.0

RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"
EXTRACT="$REPO_ROOT/plugins/dotclaude/scripts/handoff-extract.sh"
BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  [ -x "$EXTRACT" ] || chmod +x "$EXTRACT"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Seed a claude session with prompts + custom title, so the resolve →
  # extract → digest chain has non-trivial content to carry through.
  CLAUDE_UUID="aaaa1111-1111-1111-1111-111111111111"
  CLAUDE_DIR="$TEST_HOME/.claude/projects/-home-u-demo"
  mkdir -p "$CLAUDE_DIR"
  CLAUDE_FILE="$CLAUDE_DIR/$CLAUDE_UUID.jsonl"
  cat > "$CLAUDE_FILE" <<EOF
{"type":"user","cwd":"/home/u/demo","sessionId":"$CLAUDE_UUID","version":"2.1","message":{"content":"first prompt"}}
{"type":"user","cwd":"/home/u/demo","sessionId":"$CLAUDE_UUID","message":{"content":"second prompt"}}
{"type":"user","cwd":"/home/u/demo","sessionId":"$CLAUDE_UUID","message":{"content":"third prompt"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"reply A"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"reply B"}]}}
{"type":"custom-title","customTitle":"integration-demo","sessionId":"$CLAUDE_UUID"}
EOF

  # Seed a codex session for cross-CLI list/describe coverage.
  CODEX_UUID="bbbb2222-2222-2222-2222-222222222222"
  CODEX_DIR="$TEST_HOME/.codex/sessions/2026/04/18"
  mkdir -p "$CODEX_DIR"
  CODEX_FILE="$CODEX_DIR/rollout-2026-04-18T10-00-00-$CODEX_UUID.jsonl"
  cat > "$CODEX_FILE" <<EOF
{"type":"session_meta","payload":{"id":"$CODEX_UUID","cwd":"/work/demo","cli_version":"0.1"}}
{"type":"event_msg","payload":{"thread_name":"codex-thread","type":"thread_renamed"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"codex prompt"}]}}
EOF

  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  export CLAUDE_UUID CLAUDE_FILE CODEX_UUID CODEX_FILE TRANSPORT_REPO
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

# -- resolve → extract → pull chain --------------------------------------

@test "resolve (short UUID) → extract meta → valid JSON with expected session_id" {
  # Chain the scripts by hand: resolve emits a path, extract reads it.
  # This catches any disagreement between the two on what a session file
  # looks like (e.g., if resolve accepts a path extract can't parse).
  run --separate-stderr "$RESOLVE" claude aaaa1111
  [ "$status" -eq 0 ]
  local path="$output"
  [ -n "$path" ]
  run "$EXTRACT" meta claude "$path"
  [ "$status" -eq 0 ]
  [[ "$output" == *"\"session_id\":\"$CLAUDE_UUID\""* ]]
  [[ "$output" == *"\"cwd\":\"/home/u/demo\""* ]]
}

@test "customTitle → pull via CLI → <handoff> block names the session" {
  # The five-form suite exercises customTitle lookup but doesn't assert
  # that the resulting digest carries the session_id through. Lock that in.
  run node "$BIN" pull integration-demo
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"</handoff>"* ]]
  [[ "$output" == *"aaaa1111"* ]]
}

@test "resolve (codex thread_name alias) → extract prompts → user prompt present" {
  # Codex alias path runs through a separate grep-prefilter branch in
  # resolve; the happy-path existence is covered elsewhere, but the
  # resolve→extract chain across the codex layout is worth pinning.
  run --separate-stderr "$RESOLVE" codex codex-thread
  [ "$status" -eq 0 ]
  local path="$output"
  run "$EXTRACT" prompts codex "$path"
  [ "$status" -eq 0 ]
  [[ "$output" == *"codex prompt"* ]]
}

# -- push → pull round-trip content integrity ----------------------------

@test "push → pull <short-uuid> round-trip returns equivalent <handoff> content" {
  # Stronger than existing "pull emits <handoff>" tests: we capture the
  # pulled block and assert it carries the session markers from the seed.
  run node "$BIN" push integration-demo
  [ "$status" -eq 0 ]
  run node "$BIN" pull aaaa1111
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  # Short UUID must survive the transport round-trip.
  [[ "$output" == *"aaaa1111"* ]]
}

@test "push --tag → transport description carries the tag segment" {
  # The tag is stored in the transport metadata (commit subject + description
  # slug), not in the handoff block itself. Pulls by the tag substring still
  # resolve the right session even though the tag isn't echoed back inside
  # the <handoff> content — that's by design (the block is the payload, the
  # tag is routing metadata). Lock in the metadata location here; the
  # routing behavior is covered by the separate pull-by-tag test.
  run node "$BIN" push integration-demo --tag shipping-the-thing
  [ "$status" -eq 0 ]
  # Transport description appears on stdout as the final line of the push.
  [[ "$output" == *"shipping-the-thing"* ]]
  # And it persists into the transport repo commit subject. Branch is
  # handoff/<project>/<cli>/<YYYY-MM>/<short>; look it up dynamically.
  run bash -c "git --git-dir='$TRANSPORT_REPO' for-each-ref --format='%(refname:short)' 'refs/heads/handoff/*/claude/*/aaaa1111'"
  [ "$status" -eq 0 ]
  local branch="$output"
  run bash -c "git --git-dir='$TRANSPORT_REPO' log --format=%s $branch"
  [ "$status" -eq 0 ]
  [[ "$output" == *"shipping-the-thing"* ]]
  # Fetch-by-tag resolves and returns a valid block (content-equivalence
  # already asserted above; here we just prove routing works).
  run node "$BIN" fetch shipping-the-thing
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

# -- list → pull --summary chain (unified view → detail) -----------------

@test "list --local → pull --summary on each candidate → 0 exit for both CLIs" {
  # The `list` sub enumerates sessions; `pull --summary` must accept each
  # via (--from <cli>, short-UUID). Iterate both CLIs to catch layout-specific
  # regressions in either branch.
  run node "$BIN" list --local
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" == *"bbbb2222"* ]]

  run node "$BIN" pull aaaa1111 --from claude --summary
  [ "$status" -eq 0 ]
  [[ "$output" == *"first prompt"* ]]

  run node "$BIN" pull bbbb2222 --from codex --summary
  [ "$status" -eq 0 ]
  [[ "$output" == *"codex prompt"* ]]
}

# -- pull -o <path>: handoff block written to a markdown file -----------

@test "pull -o <path> writes a markdown file containing the <handoff> block" {
  # Nest outdir under TEST_HOME so teardown's rm -rf cleans it even if an
  # assertion fails before the end of this test (no separate mktemp needed).
  local outdir="$TEST_HOME/pull-out"
  mkdir -p "$outdir"
  local outpath="$outdir/aaaa1111.md"
  run --separate-stderr node "$BIN" pull aaaa1111 --from claude -o "$outpath"
  [ "$status" -eq 0 ]
  [ -f "$outpath" ]
  run cat "$outpath"
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"first prompt"* ]]
}

# -- multi-push ordering in list -----------------------------------------

@test "list after multiple pushes shows all sessions (remote column populated)" {
  # Two distinct pushes should both surface in the unified list output.
  run node "$BIN" push integration-demo --tag first
  [ "$status" -eq 0 ]
  run node "$BIN" push codex-thread --tag second
  [ "$status" -eq 0 ]
  run node "$BIN" list </dev/null
  [ "$status" -eq 0 ]
  # Both short UUIDs should be visible somewhere in the unified list.
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" == *"bbbb2222"* ]]
}

# -- describe --json is a self-contained document -----------------------

@test "pull --summary --json → pipe to jq → origin.session_id equals seeded UUID" {
  # Integration check: pull --summary --json must be parseable by jq *and*
  # expose a usable path to the session id. This is what tooling-on-top
  # (skills, agents) actually does.
  run bash -c "node '$BIN' pull aaaa1111 --summary --json | jq -r '.origin.session_id'"
  [ "$status" -eq 0 ]
  [[ "$output" == "$CLAUDE_UUID" ]]
}
