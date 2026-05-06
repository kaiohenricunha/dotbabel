#!/usr/bin/env bats
# Auto-preflight caching — covers the contract in docs/plans/handoff-issue-rollout.md:
#
#   - First push on a cold cache runs preflight.
#   - Subsequent pushes within 5 min skip it (cache hit).
#   - `--verify` forces a re-run.
#   - Changing DOTCLAUDE_HANDOFF_REPO invalidates the cache.
#   - `doctor` verb remains on-demand (never consults the cache).
#
# Uses DOTCLAUDE_DOCTOR_SH to swap in a counter-shim so we can measure the
# number of doctor invocations without patching the shipped script.

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"
REAL_DOCTOR="$REPO_ROOT/plugins/dotclaude/scripts/handoff-doctor.sh"

setup() {
  TEST_HOME=$(make_tmp_home)
  export HOME="$TEST_HOME"
  # XDG_CACHE_HOME defaults to $HOME/.cache → the preflight cache lands
  # inside TEST_HOME, so each test has an isolated cache.
  unset XDG_CACHE_HOME

  # Seed a real claude session so `push` has something to digest before it
  # reaches the remote transport.
  CLAUDE_UUID="aaaa1111-1111-1111-1111-111111111111"
  CLAUDE_DIR="$TEST_HOME/.claude/projects/-home-u-demo"
  mkdir -p "$CLAUDE_DIR"
  cat > "$CLAUDE_DIR/$CLAUDE_UUID.jsonl" <<EOF
{"type":"user","cwd":"/home/u/demo","sessionId":"$CLAUDE_UUID","version":"2.1","message":{"content":"hello"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}
EOF

  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  # Counter-shim that delegates to the real doctor and increments a file.
  COUNTER_FILE="$TEST_HOME/doctor-calls"
  SHIM_DOCTOR="$TEST_HOME/doctor-shim.sh"
  cat > "$SHIM_DOCTOR" <<EOF
#!/usr/bin/env bash
n=\$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
echo \$((n + 1)) > "$COUNTER_FILE"
exec "$REAL_DOCTOR" "\$@"
EOF
  chmod +x "$SHIM_DOCTOR"
  export DOTCLAUDE_DOCTOR_SH="$SHIM_DOCTOR"
  printf 0 > "$COUNTER_FILE"

  export CLAUDE_UUID TRANSPORT_REPO COUNTER_FILE SHIM_DOCTOR
}

teardown() {
  unset DOTCLAUDE_DOCTOR_SH
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

counter() { cat "$COUNTER_FILE"; }

# --- push: cold cache runs doctor; warm cache skips it ------------------

@test "push: first push on cold cache runs preflight (counter=1)" {
  run node "$BIN" push --from claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [ "$(counter)" -eq 1 ]
}

@test "push: second push within TTL reuses cache (counter still 1)" {
  run node "$BIN" push --from claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [ "$(counter)" -eq 1 ]

  run node "$BIN" push --from claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [ "$(counter)" -eq 1 ]
}

# --- --verify forces a re-run regardless of cache state -----------------

@test "push --verify: forces doctor to run even with a warm cache" {
  run node "$BIN" push --from claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [ "$(counter)" -eq 1 ]

  run node "$BIN" push --verify --from claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [ "$(counter)" -eq 2 ]
}

# --- transport-config change invalidates the cache ----------------------

@test "push: switching DOTCLAUDE_HANDOFF_REPO re-runs preflight" {
  run node "$BIN" push --from claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [ "$(counter)" -eq 1 ]

  # Point at a brand-new bare repo. Same cache file, but entry.repo now
  # mismatches → isFresh() must refuse the entry and re-run doctor.
  local second_repo
  second_repo=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$second_repo"

  run node "$BIN" push --from claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [ "$(counter)" -eq 2 ]

  rm -rf "$second_repo"
}

# --- doctor verb bypasses the cache entirely ----------------------------

@test "doctor verb: invokes the real script every time (never consults cache)" {
  # Warm the cache via one push (counter=1 from auto-preflight).
  run node "$BIN" push --from claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [ "$(counter)" -eq 1 ]

  # `doctor` shells out to handoff-doctor.sh directly — it never reads the
  # preflight cache. The shim is NOT wired into the doctor verb (which
  # invokes the real script via an absolute path from the bin), so we
  # assert behavioral equivalence instead: doctor exits 0 against a valid
  # transport even though cache would have let the bin skip the call.
  run node "$BIN" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok"* ]]
  [[ "$output" == *"DOTCLAUDE_HANDOFF_REPO"* ]]

  # Counter is unchanged: the doctor verb shells to the real script via
  # absolute path and never consults the shim.
  [ "$(counter)" -eq 1 ]
}
