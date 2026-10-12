#!/usr/bin/env bats
# pr-stack-budget.bats — `pr-stack gate --gate budget`, the conductor's
# attempt cap.
#
# The arithmetic is unit-tested in conductor-budget.test.mjs. This file covers
# the wiring: the count comes from the run receipt, the cap from the working
# tree's .dotbabel.json, and an unreadable cap is an error, never a silent
# default.

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-pr-stack.mjs"

setup() {
  REPO="$(make_tmp_git_repo)"
  TMP_HOME="$(make_tmp_home)"
  export HOME="$TMP_HOME"
  cd "$REPO"
  HEAD_SHA="$(git rev-parse HEAD)"
  with_fake_tool_bin gh 'exit 1' >/dev/null
}

teardown() {
  [ -n "${REPO:-}" ] && rm -rf "$REPO" "$REPO-bare.git" 2>/dev/null || true
  rm_tmp_home "${TMP_HOME:-}"
}

fail_review() {
  node "$BIN" record --pr 42 --phase review-pr --outcome fail --reason CRITERIA_FAILED --sha "$HEAD_SHA" >/dev/null
}

@test "pr-stack gate budget: a phase with no receipt has its whole budget" {
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.result.remaining')" = "3" ]
}

@test "pr-stack gate budget: the default cap of 3 stops the fourth attempt" {
  fail_review
  fail_review
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 0 ]
  fail_review
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 1 ]
  [[ "$output" == *"gate budget: FAIL"* ]]
  [[ "$output" == *"review-pr failed 3 time(s) in a row; the cap is 3"* ]]
}

@test "pr-stack gate budget: a pass resets the count" {
  fail_review
  fail_review
  fail_review
  node "$BIN" record --pr 42 --phase review-pr --outcome pass --sha "$HEAD_SHA" >/dev/null
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 0 ]
}

@test "pr-stack gate budget: .dotbabel.json sets the cap, per phase first" {
  printf '{"conductor":{"max_attempts":5,"phase_max_attempts":{"review-pr":1}}}' > .dotbabel.json
  fail_review
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 1 ]
  run node "$BIN" gate --gate budget --pr 42 --phase pre-pr --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.result.maxAttempts')" = "5" ]
}

@test "pr-stack gate budget: an invalid cap is an env error, not the default" {
  printf '{"conductor":{"max_attempts":0}}' > .dotbabel.json
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 2 ]
  [[ "$output" == *"max_attempts"* ]]
}

@test "pr-stack gate budget: --phase is required and must be a phase" {
  run node "$BIN" gate --gate budget --pr 42
  [ "$status" -eq 64 ]
  run node "$BIN" gate --gate budget --pr 42 --phase deploy
  [ "$status" -eq 64 ]
}

@test "pr-stack record: reports the attempts left before the cap" {
  run node "$BIN" record --pr 42 --phase review-pr --outcome fail --sha "$HEAD_SHA"
  [ "$status" -eq 0 ]
  [[ "$output" == *"consecutive failures: 1 of 3"* ]]
}
