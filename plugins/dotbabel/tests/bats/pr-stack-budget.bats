#!/usr/bin/env bats
# pr-stack-budget.bats — `pr-stack gate --gate budget`, the conductor's
# attempt cap.
#
# The arithmetic is unit-tested in conductor-budget.test.mjs. This file covers
# the wiring: the count comes from the run receipt, the cap from .dotbabel.json
# at the pull request's BASE ref (never the working tree, so the conductor
# cannot raise its own cap), and an unreadable cap is an error, never a silent
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

# Commit .dotbabel.json with $1 to main and publish it as origin/main, the
# base the gate falls back to when gh cannot name one.
set_base_config() {
  printf '%s' "$1" > .dotbabel.json
  git add .dotbabel.json
  git commit -q -m "config"
  git push -q origin main
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

@test "pr-stack gate budget: the base ref's .dotbabel.json sets the cap, per phase first" {
  set_base_config '{"conductor":{"max_attempts":5,"phase_max_attempts":{"review-pr":1}}}'
  fail_review
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 1 ]
  run node "$BIN" gate --gate budget --pr 42 --phase pre-pr --json
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.result.maxAttempts')" = "5" ]
}

@test "pr-stack gate budget: an invalid cap is an env error, not the default" {
  set_base_config '{"conductor":{"max_attempts":0}}'
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

@test "pr-stack gate budget: a receipt for another pull request is an env error" {
  fail_review
  RECEIPT="$REPO/.git/dotbabel/receipts/pr-42.json"
  jq '.pr = 7' "$RECEIPT" > "$RECEIPT.x" && mv "$RECEIPT.x" "$RECEIPT"
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 2 ]
  [[ "$output" == *"#42"* ]]
}

@test "pr-stack gate budget: a cap raised in the working tree or on the branch has no effect" {
  set_base_config '{"conductor":{"max_attempts":1}}'
  git checkout -q -b feature
  printf '{"conductor":{"max_attempts":10}}' > .dotbabel.json
  git commit -q -am "raise the cap"
  printf '{"conductor":{"max_attempts":9}}' > .dotbabel.json
  fail_review
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 1 ]
  [[ "$output" == *"0 of 1"* || "$output" == *"1 of 1"* ]]
}

@test "pr-stack gate budget: the base comes from gh when it answers" {
  git checkout -q -b release
  printf '{"conductor":{"max_attempts":1}}' > .dotbabel.json
  git add .dotbabel.json && git commit -q -m release && git push -q origin release
  git checkout -q main
  with_fake_tool_bin gh "
    case \"\$*\" in
      *'--json headRefOid,baseRefName'*|*'--json baseRefName'*) printf '{\"headRefOid\":\"%s\",\"baseRefName\":\"release\"}' '$HEAD_SHA'; exit 0 ;;
    esac
    exit 1
  " >/dev/null
  fail_review
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 1 ]
}

@test "pr-stack gate budget: a base ref missing from this clone is an env error" {
  git update-ref -d refs/remotes/origin/main
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 2 ]
  [[ "$output" == *"fetch"* ]]
}

@test "pr-stack gate budget: a user-allowed retry resets the count" {
  fail_review
  fail_review
  fail_review
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 1 ]
  node "$BIN" record --pr 42 --phase review-pr --outcome skipped --reason USER_ALLOWED_RETRY --sha "$HEAD_SHA" >/dev/null
  run node "$BIN" gate --gate budget --pr 42 --phase review-pr
  [ "$status" -eq 0 ]
}
