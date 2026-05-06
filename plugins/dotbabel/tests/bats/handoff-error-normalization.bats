#!/usr/bin/env bats
# Integration tests for Gap 3 (#91): structured error output for remote failures.
#
# Each test exercises one error stage and asserts that:
#   (a) the process exits 2
#   (b) stderr contains the four-field structured block
#
# Transport: local bare repo (DOTCLAUDE_HANDOFF_REPO) for most tests.
# Doctor: overridden via DOTCLAUDE_DOCTOR_SH to bypass real preflight.

bats_require_minimum_version 1.5.0

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

# Minimal passing doctor stub — exits 0 so autoPreflight doesn't block tests.
STUB_DOCTOR=""

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Claude session fixture.
  make_claude_session_tree "$TEST_HOME"

  # Transport bare repo.
  TRANSPORT_REPO=$(mktemp -d)
  rm -rf "$TRANSPORT_REPO"
  git init -q --bare "$TRANSPORT_REPO"
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  # Doctor stub: always succeeds so preflight doesn't block the tests
  # we're actually trying to run.
  STUB_DOCTOR=$(mktemp)
  printf '#!/usr/bin/env bash\necho ok\nexit 0\n' > "$STUB_DOCTOR"
  chmod +x "$STUB_DOCTOR"
  export DOTCLAUDE_DOCTOR_SH="$STUB_DOCTOR"

  export TRANSPORT_REPO STUB_DOCTOR
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
  [ -f "${STUB_DOCTOR:-}" ] && rm -f "$STUB_DOCTOR"
}

# ---- test 1: missing transport env var (fetch) ----------------------------

@test "error: fetch with no DOTCLAUDE_HANDOFF_REPO → stage: preflight" {
  unset DOTCLAUDE_HANDOFF_REPO
  run --separate-stderr node "$BIN" fetch
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"stage:  preflight"* ]]
  [[ "$stderr" == *"fetch failed"* ]]
  [[ "$stderr" == *"retry:"* ]]
}

# ---- test 2: auth failure on push -----------------------------------------

@test "error: push with SSH auth failure → stage: upload" {
  # Shim git to fail on 'push' with an SSH auth error; pass everything else
  # to the real git so init/remote/config/checkout/add/commit succeed.
  with_fake_tool_bin git '
if [[ "$1" == "push" ]]; then
  echo "Permission denied (publickey)." >&2
  exit 128
fi
exec /usr/bin/git "$@"
'
  run --separate-stderr node "$BIN" push --from claude
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"stage:  upload"* ]]
  [[ "$stderr" == *"push failed"* ]]
  [[ "$stderr" == *"SSH key"* ]] || [[ "$stderr" == *"publickey"* ]]
  [[ "$stderr" == *"fix:"* ]]
  [[ "$stderr" == *"retry:"* ]]
}

# ---- test 3: no handoffs on empty transport (fetch) -----------------------

@test "error: fetch from empty transport repo → stage: resolve" {
  # TRANSPORT_REPO is a bare repo with no handoff/* branches yet.
  run --separate-stderr node "$BIN" fetch
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"stage:  resolve"* ]]
  [[ "$stderr" == *"fetch failed"* ]]
  [[ "$stderr" == *"no handoffs"* ]]
  [[ "$stderr" == *"retry:"* ]]
}

# ---- test 4: ls-remote failure on fetch (repo unreachable) ----------------

@test "error: fetch when ls-remote fails → stage: preflight" {
  # Shim git to fail on ls-remote with a network-style error.
  # The preflight is already bypassed via DOTCLAUDE_DOCTOR_SH.
  with_fake_tool_bin git '
if [[ "$1" == "ls-remote" ]]; then
  echo "fatal: Could not read from remote repository." >&2
  exit 128
fi
exec /usr/bin/git "$@"
'
  DOTCLAUDE_HANDOFF_REPO="git@example.com:fake/store.git"
  export DOTCLAUDE_HANDOFF_REPO
  run --separate-stderr node "$BIN" fetch
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"stage:  preflight"* ]]
  [[ "$stderr" == *"fetch failed"* ]]
  [[ "$stderr" == *"retry:"* ]]
}
