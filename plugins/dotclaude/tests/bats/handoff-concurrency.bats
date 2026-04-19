#!/usr/bin/env bats
# Concurrency tests. No file locking exists in the handoff scripts by
# design (they are read-only over session transcripts; the transport
# branch is the only mutable shared state, and force-push makes that
# last-writer-wins). These tests lock in the invariants that must hold
# under parallel invocation:
#   - push collisions leave a valid ref (fsck passes, tip is a real SHA)
#   - read paths (pull, resolve, list) never exit non-zero under contention
#   - resolve does not read session file contents, so torn appends can't
#     propagate into its output
# Every test is wrapped in `timeout 15s` — CI must fail fast on deadlock.

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"
RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  CLAUDE_UUID="aaaa1111-1111-1111-1111-111111111111"
  CLAUDE_DIR="$TEST_HOME/.claude/projects/-home-u-demo"
  mkdir -p "$CLAUDE_DIR"
  CLAUDE_FILE="$CLAUDE_DIR/$CLAUDE_UUID.jsonl"
  cat > "$CLAUDE_FILE" <<EOF
{"type":"user","cwd":"/home/u/demo","sessionId":"$CLAUDE_UUID","version":"2.1","message":{"content":"first prompt"}}
{"type":"user","cwd":"/home/u/demo","sessionId":"$CLAUDE_UUID","message":{"content":"second prompt"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"reply A"}]}}
{"type":"custom-title","customTitle":"integration-demo","sessionId":"$CLAUDE_UUID"}
EOF

  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"
  export CLAUDE_UUID CLAUDE_FILE TRANSPORT_REPO
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

# -- push collisions ------------------------------------------------------

@test "two concurrent pushes to same branch leave the transport repo valid" {
  # Both writers target handoff/claude/aaaa1111 via force-push. Git's
  # on-disk ref-lock means at most one push wins in a race; the loser
  # exits non-zero. That's not corruption, it's contention — the
  # invariants we care about are:
  #   (1) at least one push succeeds
  #   (2) the ref ends up pointing at a real commit (no half-written state)
  #   (3) `git fsck` exits 0 (no object corruption)
  run timeout 15s bash -c "
    node '$BIN' push integration-demo --via git-fallback >/dev/null 2>&1 &
    pid1=\$!
    node '$BIN' push integration-demo --via git-fallback >/dev/null 2>&1 &
    pid2=\$!
    wait \$pid1
    rc1=\$?
    wait \$pid2
    rc2=\$?
    # At least one must succeed; neither may be killed by timeout.
    { [ \$rc1 -eq 0 ] || [ \$rc2 -eq 0 ]; } && [ \$rc1 -ne 124 ] && [ \$rc2 -ne 124 ]
  "
  [ "$status" -eq 0 ]

  # The ref must resolve to a real commit and fsck must be clean.
  run git --git-dir="$TRANSPORT_REPO" rev-parse handoff/claude/aaaa1111
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9a-f]{40}$ ]]
  run git --git-dir="$TRANSPORT_REPO" fsck --no-dangling
  [ "$status" -eq 0 ]
}

@test "two concurrent pulls of same branch both emit valid <handoff> blocks" {
  # Seed the branch first so pulls have something to fetch.
  run node "$BIN" push integration-demo --via git-fallback
  [ "$status" -eq 0 ]

  local out1_file out2_file
  out1_file=$(mktemp)
  out2_file=$(mktemp)
  run timeout 15s bash -c "
    node '$BIN' pull aaaa1111 --via git-fallback > '$out1_file' 2>/dev/null &
    pid1=\$!
    node '$BIN' pull aaaa1111 --via git-fallback > '$out2_file' 2>/dev/null &
    pid2=\$!
    wait \$pid1
    rc1=\$?
    wait \$pid2
    rc2=\$?
    [ \$rc1 -eq 0 ] && [ \$rc2 -eq 0 ]
  "
  [ "$status" -eq 0 ]

  grep -q '<handoff' "$out1_file"
  grep -q '</handoff>' "$out1_file"
  grep -q '<handoff' "$out2_file"
  grep -q '</handoff>' "$out2_file"
  rm -f "$out1_file" "$out2_file"
}

# -- resolve during concurrent writes ------------------------------------

@test "resolve latest while a session file is being appended does not error" {
  # resolve uses stat/find — it does not read contents — so ongoing
  # appends cannot produce a torn-record bug in the resolver. Loop 10
  # resolutions while a background writer tacks on records every 50ms;
  # every loop iteration must exit 0 and print our seeded file path.
  run timeout 15s bash -c "
    (
      for i in 1 2 3 4 5 6 7 8 9 10; do
        printf '{\"type\":\"user\",\"message\":{\"content\":\"append %d\"}}\n' \$i >> '$CLAUDE_FILE'
        sleep 0.05
      done
    ) &
    writer_pid=\$!
    rc=0
    for i in 1 2 3 4 5 6 7 8 9 10; do
      hit=\$('$RESOLVE' claude latest 2>/dev/null) || { rc=1; break; }
      [ \"\$hit\" = '$CLAUDE_FILE' ] || { rc=1; break; }
    done
    wait \$writer_pid
    exit \$rc
  "
  [ "$status" -eq 0 ]
}

# -- list idempotence under contention -----------------------------------

@test "three parallel list --local invocations produce identical stdout" {
  # The enumerator is a stat-based walker; no shared state between runs.
  # Three concurrent runs must produce byte-identical output (modulo
  # mtime ordering, which is stable over the fixture). Diffs between any
  # pair signal a non-deterministic bug (e.g., parallel mtime updates).
  local a b c
  a=$(mktemp) b=$(mktemp) c=$(mktemp)
  run timeout 15s bash -c "
    node '$BIN' list --local > '$a' 2>/dev/null &
    node '$BIN' list --local > '$b' 2>/dev/null &
    node '$BIN' list --local > '$c' 2>/dev/null &
    wait
  "
  [ "$status" -eq 0 ]
  run diff "$a" "$b"
  [ "$status" -eq 0 ]
  run diff "$b" "$c"
  [ "$status" -eq 0 ]
  rm -f "$a" "$b" "$c"
}

# -- atomic pull during push ---------------------------------------------

@test "pull during concurrent push returns a consistent <handoff> block" {
  # Seed once so pull has a baseline.
  run node "$BIN" push integration-demo --via git-fallback
  [ "$status" -eq 0 ]

  # Now race push vs pull. The pull's `git clone --depth 1 --branch <b>`
  # is atomic at the ref level on the remote side; we get either the
  # pre- or post-push snapshot, never a torn mix. Lock that in: the
  # pulled output must parse as a well-formed <handoff>…</handoff> block.
  local pull_out
  pull_out=$(mktemp)
  run timeout 15s bash -c "
    node '$BIN' push integration-demo --via git-fallback >/dev/null 2>&1 &
    push_pid=\$!
    node '$BIN' pull aaaa1111 --via git-fallback > '$pull_out' 2>/dev/null
    rc_pull=\$?
    wait \$push_pid
    rc_push=\$?
    [ \$rc_pull -eq 0 ] && [ \$rc_push -eq 0 ]
  "
  [ "$status" -eq 0 ]

  # Well-formed block: exactly one opener, exactly one closer.
  run bash -c "grep -c '<handoff' '$pull_out'"
  [ "$output" = "1" ]
  run bash -c "grep -c '</handoff>' '$pull_out'"
  [ "$output" = "1" ]
  rm -f "$pull_out"
}
