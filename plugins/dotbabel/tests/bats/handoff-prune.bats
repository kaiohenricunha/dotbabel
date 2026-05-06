#!/usr/bin/env bats
# Integration tests for Gap 5 (#91): `prune` verb deletes aged handoff branches
# from the transport, with safety gates (TTY confirm, --yes for non-TTY,
# --dry-run preview, hostname filter).
#
# Fixture pattern: bare transport repo + make_aged_handoff_branch fabricates
# branches with a chosen committer date and metadata.hostname so we can
# exercise filter logic without a real machine clock.

bats_require_minimum_version 1.5.0

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

STUB_DOCTOR=""

# slugify(hostname()) — must match the lib's slugify so default ownership
# filter matches the branches we're seeding.
this_host_slug() {
  hostname | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//' | cut -c1-40
}

# Count handoff/* refs on the bare transport.
count_transport_refs() {
  git --git-dir="$1" for-each-ref refs/heads/handoff/ --format='%(refname:short)' | wc -l | tr -d ' '
}

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  make_claude_session_tree "$TEST_HOME"

  TRANSPORT_REPO=$(mktemp -d)
  rm -rf "$TRANSPORT_REPO"
  git init -q --bare "$TRANSPORT_REPO"
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  STUB_DOCTOR=$(mktemp)
  printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_DOCTOR"
  chmod +x "$STUB_DOCTOR"
  export DOTCLAUDE_DOCTOR_SH="$STUB_DOCTOR"

  THIS_HOST=$(this_host_slug)
  export TRANSPORT_REPO STUB_DOCTOR THIS_HOST
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
  [ -f "${STUB_DOCTOR:-}" ] && rm -f "$STUB_DOCTOR"
}

# ---- test 1: dry-run lists candidates, deletes nothing --------------------

@test "prune --older-than 7d --dry-run: lists old, deletes nothing" {
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-01/aaaaaaaa" "$THIS_HOST" claude 30
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-04/bbbbbbbb" "$THIS_HOST" claude 1

  run --separate-stderr node "$BIN" prune --older-than 7d --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaaaaaa"* ]]
  [[ "$output" != *"bbbbbbbb"* ]]
  [ "$(count_transport_refs "$TRANSPORT_REPO")" = "2" ]
}

# ---- test 2: non-TTY without --yes refuses --------------------------------

@test "prune --older-than 7d (non-TTY, no --yes): refuses with usage error" {
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-01/aaaaaaaa" "$THIS_HOST" claude 30

  run --separate-stderr node "$BIN" prune --older-than 7d
  [ "$status" -eq 64 ]
  [[ "$stderr" == *"--yes"* ]]
  [ "$(count_transport_refs "$TRANSPORT_REPO")" = "1" ]
}

# ---- test 3: --yes on non-TTY actually deletes ----------------------------

@test "prune --older-than 7d --yes (non-TTY): deletes old branches" {
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-01/aaaaaaaa" "$THIS_HOST" claude 30
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-04/bbbbbbbb" "$THIS_HOST" claude 1

  run --separate-stderr node "$BIN" prune --older-than 7d --yes
  [ "$status" -eq 0 ]
  [ "$(count_transport_refs "$TRANSPORT_REPO")" = "1" ]
  # The young one survived.
  git --git-dir="$TRANSPORT_REPO" rev-parse refs/heads/handoff/p/claude/2026-04/bbbbbbbb >/dev/null
}

# ---- test 4: hostname filter skips foreign branches -----------------------

@test "prune --older-than 7d --yes: skips branches pushed from a different host" {
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-01/aaaaaaaa" "$THIS_HOST" claude 30
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-01/cccccccc" "other-host-7" claude 30

  run --separate-stderr node "$BIN" prune --older-than 7d --yes
  [ "$status" -eq 0 ]
  # Foreign branch survives; this-host branch is gone.
  git --git-dir="$TRANSPORT_REPO" rev-parse refs/heads/handoff/p/claude/2026-01/cccccccc >/dev/null
  ! git --git-dir="$TRANSPORT_REPO" rev-parse refs/heads/handoff/p/claude/2026-01/aaaaaaaa >/dev/null 2>&1
}

# ---- test 5: --from filters by cli ---------------------------------------

@test "prune --older-than 7d --from claude --yes: only claude branches" {
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-01/aaaaaaaa" "$THIS_HOST" claude 30
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/codex/2026-01/dddddddd" "$THIS_HOST" codex 30

  run --separate-stderr node "$BIN" prune --older-than 7d --from claude --yes
  [ "$status" -eq 0 ]
  # codex survives; claude is gone.
  git --git-dir="$TRANSPORT_REPO" rev-parse refs/heads/handoff/p/codex/2026-01/dddddddd >/dev/null
  ! git --git-dir="$TRANSPORT_REPO" rev-parse refs/heads/handoff/p/claude/2026-01/aaaaaaaa >/dev/null 2>&1
}

# ---- test 6: --json emits parseable JSON ---------------------------------

@test "prune --older-than 7d --dry-run --json: parseable JSON" {
  make_aged_handoff_branch "$TRANSPORT_REPO" "handoff/p/claude/2026-01/aaaaaaaa" "$THIS_HOST" claude 30

  run --separate-stderr node "$BIN" prune --older-than 7d --dry-run --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.dryRun == true' >/dev/null
  echo "$output" | jq -e '.candidates | length == 1' >/dev/null
  echo "$output" | jq -e '.candidates[0].branch | endswith("aaaaaaaa")' >/dev/null
}

# ---- test 7: missing --older-than → usage error --------------------------

@test "prune (no --older-than): usage error" {
  run --separate-stderr node "$BIN" prune
  [ "$status" -eq 64 ]
  [[ "$stderr" == *"--older-than"* ]]
}

# ---- test 8: garbage --older-than → usage error --------------------------

@test "prune --older-than garbage --dry-run: usage error" {
  run --separate-stderr node "$BIN" prune --older-than garbage --dry-run
  [ "$status" -eq 64 ]
}

# ---- test 9: nothing to prune is a happy zero-exit -----------------------

@test "prune --older-than 99d --dry-run on empty transport: nothing to prune, exit 0" {
  run --separate-stderr node "$BIN" prune --older-than 99d --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"nothing to prune"* ]]
}
