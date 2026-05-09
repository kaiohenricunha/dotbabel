#!/usr/bin/env bats
# Integration tests for Gap 4 (#91): `push --dry-run` previews what would be
# pushed without touching the transport.
#
# Each test confirms (a) exit 0, (b) expected preview on stdout, (c) zero
# branches written to the bare transport repo.
#
# Transport: local bare repo (DOTBABEL_HANDOFF_REPO).
# Doctor: overridden via DOTBABEL_DOCTOR_SH — but dry-run skips preflight,
# so the stub exists only to catch regressions if that changes.

bats_require_minimum_version 1.5.0

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-handoff.mjs"

STUB_DOCTOR=""

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  make_claude_session_tree "$TEST_HOME"

  TRANSPORT_REPO=$(mktemp -d)
  rm -rf "$TRANSPORT_REPO"
  git init -q --bare "$TRANSPORT_REPO"
  export DOTBABEL_HANDOFF_REPO="$TRANSPORT_REPO"

  # Dry-run should never invoke this. Kept as a trip-wire: if the stub
  # is ever called we'll know preflight leaked into the dry-run path.
  STUB_DOCTOR=$(mktemp)
  printf '#!/usr/bin/env bash\necho ok\nexit 0\n' > "$STUB_DOCTOR"
  chmod +x "$STUB_DOCTOR"
  export DOTBABEL_DOCTOR_SH="$STUB_DOCTOR"

  export TRANSPORT_REPO STUB_DOCTOR
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
  [ -f "${STUB_DOCTOR:-}" ] && rm -f "$STUB_DOCTOR"
}

# ---- test 1: happy path prints DRY-RUN banner, exits 0, no branches -------

@test "push --dry-run: exits 0, prints DRY-RUN banner, writes no branches" {
  run --separate-stderr node "$BIN" push --from claude --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"DRY-RUN (no network calls)"* ]]
  [[ "$output" == *"branch:"* ]]
  [[ "$output" == *"transport:"* ]]
  [[ "$output" == *"digest size:"* ]]
  [[ "$output" == *"scrub count:"* ]]
  [[ "$output" == *"metadata:"* ]]

  # No branch written to the bare transport repo.
  local refs
  refs=$(git --git-dir="$TRANSPORT_REPO" for-each-ref refs/heads/handoff/ || true)
  [ -z "$refs" ]
}

# ---- test 2: --json emits parseable JSON with dryRun=true -----------------

@test "push --dry-run --json: parseable JSON with dryRun=true" {
  run --separate-stderr node "$BIN" push --from claude --dry-run --json
  [ "$status" -eq 0 ]
  # Sanity: jq can parse it and the marker is set.
  echo "$output" | jq -e '.dryRun == true' >/dev/null
  echo "$output" | jq -e '.branch | startswith("handoff/")' >/dev/null
  echo "$output" | jq -e '.digestBytes | type == "number" and . > 0' >/dev/null
  echo "$output" | jq -e '.scrubbedCount | type == "number"' >/dev/null
}

# ---- test 3: unset DOTBABEL_HANDOFF_REPO → structured preflight error ----

@test "push --dry-run: unset DOTBABEL_HANDOFF_REPO → stage preflight" {
  unset DOTBABEL_HANDOFF_REPO
  # Also clear the persisted config file path in case a prior test wrote one.
  rm -f "$TEST_HOME/.config/dotbabel/handoff.env" 2>/dev/null || true
  run --separate-stderr node "$BIN" push --from claude --dry-run
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"stage:  preflight"* ]]
  [[ "$stderr" == *"push failed"* ]]
}

# ---- test 4: dry-run does NOT invoke the doctor script --------------------

@test "push --state-file accepted; dry-run JSON reflects digestBytes delta" {
  # CLI-contract test for --state-file. The dry-run JSON only exposes metadata
  # (dryRun, branch, digestBytes, ...), not the rendered <handoff-state> text
  # — content visibility is asserted at the lib layer (handoff-remote-lib.test.mjs
  # `places opts.stateBlock above the mechanical Summary line`). Here we lock
  # the bin contract: --state-file is accepted, value flows through pushRemote,
  # and a 16 KB state file inflates digestBytes by at least ~15 KB vs an empty
  # state file. This catches a regression where the flag is parsed but dropped
  # before reaching pushRemote (e.g. lost in argv refactor).
  local empty_state="$TEST_HOME/state-empty.txt"
  local big_state="$TEST_HOME/state-big.txt"
  : > "$empty_state"
  # Realistic-shape state block: ~16 KB of content within a wrapper element
  # so the renderHandoffBlock trim() guard treats it as non-empty content.
  printf '<handoff-state version="1">\n' > "$big_state"
  yes "active-goal-line padding for digest size delta assertion" \
    | head -c 16000 >> "$big_state"
  printf '\n</handoff-state>\n' >> "$big_state"

  run --separate-stderr node "$BIN" push --from claude --state-file "$empty_state" \
    --dry-run --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.dryRun == true' >/dev/null
  local empty_bytes
  empty_bytes=$(echo "$output" | jq -r '.digestBytes')

  run --separate-stderr node "$BIN" push --from claude --state-file "$big_state" \
    --dry-run --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.dryRun == true' >/dev/null
  local big_bytes
  big_bytes=$(echo "$output" | jq -r '.digestBytes')

  # Sanity: both are integers and big_bytes is at least empty + 15 000.
  [[ "$empty_bytes" =~ ^[0-9]+$ ]]
  [[ "$big_bytes" =~ ^[0-9]+$ ]]
  [ "$big_bytes" -ge "$((empty_bytes + 15000))" ]
}

@test "push --dry-run: autoPreflight is skipped (doctor stub never runs)" {
  # Replace the passing stub with one that writes a sentinel file and
  # exits non-zero. If dry-run invokes preflight, the sentinel appears
  # and the command fails. Using a fresh dir + fixed name avoids the
  # mktemp -u race (path not reserved).
  local sentinel_dir; sentinel_dir=$(mktemp -d)
  local sentinel="$sentinel_dir/preflight-ran"
  cat > "$STUB_DOCTOR" <<SH
#!/usr/bin/env bash
echo "preflight-ran" > "$sentinel"
exit 1
SH
  chmod +x "$STUB_DOCTOR"

  run --separate-stderr node "$BIN" push --from claude --dry-run
  [ "$status" -eq 0 ]
  [ ! -f "$sentinel" ]
  rm -rf "$sentinel_dir"
}
