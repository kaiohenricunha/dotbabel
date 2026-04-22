#!/usr/bin/env bats
# `pull` with no query must return the branch with the newest commit date,
# not the lexically-last short UUID. Issue #90 Gap 2.
#
# Exercises the real `pullRemote` against a local bare repo — no network.

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

# Seed a Claude session at $TEST_HOME/.claude/projects/<slug>/<uuid>.jsonl
# whose first user prompt carries the marker string $2. Per-uuid slug keeps
# each session distinct for the resolver.
seed_session() {
  local uuid="$1" marker="$2"
  local slug="-home-u-pull-latest-${uuid%%-*}"
  local dir="$TEST_HOME/.claude/projects/$slug"
  mkdir -p "$dir"
  cat > "$dir/$uuid.jsonl" <<EOF
{"type":"user","cwd":"/home/u/pull-latest/${uuid%%-*}","sessionId":"$uuid","version":"2.1","message":{"content":"$marker"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
EOF
}

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  # Short UUIDs chosen so that lexical order of branches is the OPPOSITE
  # of push order. With this setup, the pre-fix code's
  # `candidates[candidates.length - 1]` returns the oldest-committed
  # branch (fffffff0), while the fix must return the newest (00000001).
  UUID_OLD="fffffff0-1111-1111-1111-111111111111"
  UUID_MID="77777777-1111-1111-1111-111111111111"
  UUID_NEW="00000001-1111-1111-1111-111111111111"
  seed_session "$UUID_OLD" "marker-oldest"
  seed_session "$UUID_MID" "marker-middle"
  seed_session "$UUID_NEW" "marker-newest"

  export UUID_OLD UUID_MID UUID_NEW
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

@test "pull (bare): returns newest-committed branch, not lex-last" {
  # Push oldest → middle → newest, >1s apart so the committer dates are
  # strictly increasing and reflect push order.
  run node "$BIN" push fffffff0
  [ "$status" -eq 0 ]
  sleep 1.1
  run node "$BIN" push 77777777
  [ "$status" -eq 0 ]
  sleep 1.1
  run node "$BIN" push 00000001
  [ "$status" -eq 0 ]

  run node "$BIN" pull
  [ "$status" -eq 0 ]
  # Pulled branch must be the newest (marker-newest). If the bug is
  # still present, the lex-last branch (fffffff0 / marker-oldest) is
  # returned instead.
  [[ "$output" == *"marker-newest"* ]]
  [[ "$output" != *"marker-oldest"* ]]
  [[ "$output" != *"marker-middle"* ]]
}

@test "pull --from claude (no query): still returns newest by commit date" {
  # Same ordering as above; verify the fromCli-scoped path also sorts
  # correctly — the filter runs before the sort, so all three remain in
  # the candidate set.
  run node "$BIN" push fffffff0
  [ "$status" -eq 0 ]
  sleep 1.1
  run node "$BIN" push 77777777
  [ "$status" -eq 0 ]
  sleep 1.1
  run node "$BIN" push 00000001
  [ "$status" -eq 0 ]

  run node "$BIN" pull --from claude
  [ "$status" -eq 0 ]
  [[ "$output" == *"marker-newest"* ]]
  [[ "$output" != *"marker-oldest"* ]]
}

@test "pull (bare) with a single branch: no sort attempted, fast path" {
  # Single-candidate short-circuit. If this regresses to unconditional
  # fetch-for-sort, the test is still green but would be slower — we
  # pin correctness, not cost.
  run node "$BIN" push fffffff0
  [ "$status" -eq 0 ]
  run node "$BIN" pull
  [ "$status" -eq 0 ]
  [[ "$output" == *"marker-oldest"* ]]
}
