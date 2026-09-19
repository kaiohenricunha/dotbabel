#!/usr/bin/env bats
# pr-stack-entry.bats — the `entry` subcommand's gh resolution (P-G2).
#
# `deriveEntryPhase` is pure and unit-tested; this file covers the half that
# was not, and that is not an academic gap: the first revision of this command
# asked gh for `number` alone, and `gh pr view` falls back to the most recent
# CLOSED or MERGED pull request for the head ref. A merged branch therefore
# reported PR_OPEN and told the conductor that phase 2 — the phase that pushes
# and opens the PR — could be skipped.

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-pr-stack.mjs"

setup() {
  REPO="$(make_tmp_git_repo)"
  cd "$REPO"
}

teardown() {
  [ -n "${REPO:-}" ] && rm -rf "$REPO" "$REPO-bare.git" 2>/dev/null || true
}

# Stub gh so `pr view --json number,state` answers with $1 (raw JSON), and
# everything else succeeds silently.
stub_gh_state() {
  with_fake_tool_bin gh "
    case \"\$*\" in
      *'pr view --json number,state'*) printf '%s' '$1'; exit 0 ;;
    esac
    exit 0
  " >/dev/null
}

@test "pr-stack entry: an open PR yields PR_OPEN and skips open-pr" {
  stub_gh_state '{"number":42,"state":"OPEN"}'
  run node "$BIN" entry --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reason": "PR_OPEN"'* ]]
  [[ "$output" == *'"prNumber": 42'* ]]
  [[ "$output" == *'open-pr'* ]]
}

@test "pr-stack entry: a MERGED PR is not PR_OPEN" {
  # The regression. A merged branch still needs phase 2 to open a new PR.
  stub_gh_state '{"number":42,"state":"MERGED"}'
  run node "$BIN" entry --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reason": "NO_PR"'* ]]
  [[ "$output" != *'"reason": "PR_OPEN"'* ]]
}

@test "pr-stack entry: a CLOSED PR is not PR_OPEN" {
  stub_gh_state '{"number":42,"state":"CLOSED"}'
  run node "$BIN" entry --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reason": "NO_PR"'* ]]
}

@test "pr-stack entry: a branch with no PR yields NO_PR" {
  with_fake_tool_bin gh '
    case "$*" in
      *"pr view --json number,state"*) echo "no pull requests found for branch" >&2; exit 1 ;;
    esac
    exit 0
  ' >/dev/null
  run node "$BIN" entry --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reason": "NO_PR"'* ]]
  [[ "$output" == *'"prNumber": null'* ]]
}

@test "pr-stack entry: a gh failure is an env error, never a confident NO_PR" {
  # Laundering an outage into NO_PR would tell phase 2 to open a pull request
  # that may already exist.
  with_fake_tool_bin gh '
    case "$*" in
      *"pr view --json number,state"*) echo "gh: not authenticated" >&2; exit 1 ;;
    esac
    exit 0
  ' >/dev/null
  run node "$BIN" entry --json
  [ "$status" -eq 2 ]
  [[ "$output" == *"could not resolve the pull request"* ]]
}

@test "pr-stack entry: unparseable gh output does not crash" {
  stub_gh_state 'not json at all'
  run node "$BIN" entry --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reason": "NO_PR"'* ]]
}

@test "pr-stack entry: an explicit --pr is honoured without consulting gh" {
  stub_gh_state '{"number":7,"state":"MERGED"}'
  run node "$BIN" entry --pr 99 --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"prNumber": 99'* ]]
  [[ "$output" == *'"reason": "PR_OPEN"'* ]]
}

@test "pr-stack entry: a malformed --pr is a usage error" {
  stub_gh_state '{"number":42,"state":"OPEN"}'
  run node "$BIN" entry --pr nonsense
  [ "$status" -eq 64 ]
}

@test "pr-stack entry: the human output names the phase and the skip" {
  stub_gh_state '{"number":42,"state":"OPEN"}'
  run node "$BIN" entry
  [ "$status" -eq 0 ]
  [[ "$output" == *"entry: pre-pr (PR_OPEN)"* ]]
  [[ "$output" == *"skips: open-pr"* ]]
}

@test "pr-stack entry: NO_PR prints no skips line" {
  stub_gh_state '{"number":42,"state":"CLOSED"}'
  run node "$BIN" entry
  [ "$status" -eq 0 ]
  [[ "$output" == *"(NO_PR)"* ]]
  [[ "$output" != *"skips:"* ]]
}

# --- subcommand dispatch ----------------------------------------------------
#
# Added after adding `entry` silently deleted the `skip-ci` and `local-attest`
# gate branches: both suites stayed green, because nothing exercised the bin's
# dispatch at all. `gate --gate skip-ci` then fell through to "--gate must be
# one of", which is the error for an unknown gate — so the conductor's
# every-commit skip-ci check would have reported a usage error as a gate
# failure. Cheap to pin, and it is the same class of gap the review found.

@test "pr-stack: every documented gate still dispatches" {
  # skip-ci needs no PR and no network, so it is the one gate a test can run
  # end to end. The others are asserted to reach their own logic rather than
  # the unknown-gate error.
  git commit -q --allow-empty -m "chore: nothing [skip ci]"
  run node "$BIN" gate --gate skip-ci
  [ "$status" -eq 0 ]
  [[ "$output" == *"gate skip-ci: PASS"* ]]
}

@test "pr-stack: skip-ci detects a commit with no marker" {
  git commit -q --allow-empty -m "chore: nothing"
  run node "$BIN" gate --gate skip-ci
  [ "$status" -eq 1 ]
  [[ "$output" == *"gate skip-ci: FAIL"* ]]
}

@test "pr-stack: an unknown gate is still a usage error" {
  run node "$BIN" gate --gate nonsense --pr 1
  [ "$status" -eq 64 ]
  [[ "$output" == *"--gate must be one of"* ]]
}

@test "pr-stack: phases and entry dispatch without touching the gate flag" {
  run node "$BIN" phases
  [ "$status" -eq 0 ]
  [[ "$output" == *"pre-pr"* ]]
}
