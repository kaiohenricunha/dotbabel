#!/usr/bin/env bats
# The handoff scripts use no file locking: sessions are read-only, and
# the transport branch is force-pushed. These tests pin the invariants
# that must hold under parallel invocation. Every test is wrapped in
# `timeout 15s` — CI must fail fast on deadlock.

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

@test "two concurrent pushes to same branch leave the transport repo valid" {
  # Git's ref-lock means at most one push wins the race; the loser exits
  # non-zero. Contention is not corruption — we only require that at
  # least one succeeds, the ref tip is a real commit, and fsck is clean.
  run timeout 15s bash -c "
    node '$BIN' push integration-demo --via git-fallback >/dev/null 2>&1 &
    pid1=\$!
    node '$BIN' push integration-demo --via git-fallback >/dev/null 2>&1 &
    pid2=\$!
    wait \$pid1
    rc1=\$?
    wait \$pid2
    rc2=\$?
    { [ \$rc1 -eq 0 ] || [ \$rc2 -eq 0 ]; } && [ \$rc1 -ne 124 ] && [ \$rc2 -ne 124 ]
  "
  [ "$status" -eq 0 ]

  run git --git-dir="$TRANSPORT_REPO" rev-parse handoff/claude/aaaa1111
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9a-f]{40}$ ]]
  run git --git-dir="$TRANSPORT_REPO" fsck --no-dangling
  [ "$status" -eq 0 ]
}

@test "two concurrent pulls of same branch both emit valid <handoff> blocks" {
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

@test "resolve latest while a session file is being appended does not error" {
  # resolve uses stat/find, not content reads — ongoing appends cannot
  # produce a torn-record bug in the resolver.
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

@test "three parallel list --local invocations produce identical stdout" {
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

@test "pull during concurrent push returns a consistent <handoff> block" {
  run node "$BIN" push integration-demo --via git-fallback
  [ "$status" -eq 0 ]

  # `git clone --depth 1 --branch <b>` is atomic at the ref level on the
  # remote; pull sees either the pre- or post-push snapshot, never a mix.
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

  run bash -c "grep -c '<handoff' '$pull_out'"
  [ "$output" = "1" ]
  run bash -c "grep -c '</handoff>' '$pull_out'"
  [ "$output" = "1" ]
  rm -f "$pull_out"
}
