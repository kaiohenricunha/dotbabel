#!/usr/bin/env bats
# post-pr-review-post-receipt.sh — the receipt that makes "the review ran"
# observable on a pull request.
#
# A post-pr-review run that finds nothing posts no comment at all, so a pull
# request whose review ran clean is indistinguishable from one that was never
# reviewed. The conductor's review-complete marker needs to tell them apart, so
# every run ends by posting one body-only review that carries the receipt marker
# and is pinned, by GitHub itself, to the commit it was posted against.
#
# The receipt is guarded like the other evidence families, so this script is the
# only sanctioned way to write it, and it never carries the marker in its own
# command text.

load helpers

SCRIPT="$REPO_ROOT/plugins/dotbabel/scripts/post-pr-review-post-receipt.sh"
SHA="0123456789abcdef0123456789abcdef01234567"

# Fake gh: `repo view` answers with o/r; the reviews POST copies its --input file
# so a test can read exactly what would have been sent.
stub_gh() {
  local status="${1:-0}"
  with_fake_tool_bin gh "
    if [ \"\$1\" = repo ]; then echo o/r; exit 0; fi
    printf '%s\n' \"\$@\" > '$BATS_TEST_TMPDIR/argv'
    input=''
    while [ \$# -gt 0 ]; do
      if [ \"\$1\" = --input ]; then input=\"\$2\"; fi
      shift
    done
    [ -n \"\$input\" ] && cp \"\$input\" '$BATS_TEST_TMPDIR/payload.json'
    exit $status
  " >/dev/null
}

payload() { cat "$BATS_TEST_TMPDIR/payload.json"; }

@test "receipt: script exists and is executable" {
  [ -f "$SCRIPT" ]
  [ -x "$SCRIPT" ]
}

@test "receipt: posts a body-only review pinned to the reviewed commit" {
  stub_gh
  run "$SCRIPT" 42 --sha "$SHA" --posted 3 --skipped 1
  [ "$status" -eq 0 ]
  grep -q "repos/o/r/pulls/42/reviews" "$BATS_TEST_TMPDIR/argv"
  grep -qx -- "POST" "$BATS_TEST_TMPDIR/argv"
  [ "$(payload | jq -r .commit_id)" = "$SHA" ]
  [ "$(payload | jq -r .event)" = "COMMENT" ]
  [ "$(payload | jq '.comments // [] | length')" -eq 0 ]
}

@test "receipt: line 1 of the body is exactly the marker the reader matches" {
  stub_gh
  run "$SCRIPT" 42 --sha "$SHA" --posted 0
  [ "$status" -eq 0 ]
  first="$(payload | jq -r .body | head -n1)"
  expected="$(node --input-type=module -e "import { POST_PR_REVIEW_RECEIPT_MARKER as m } from '$REPO_ROOT/plugins/dotbabel/src/review-evidence.mjs'; process.stdout.write(m)")"
  [ -n "$expected" ]
  [ "$first" = "$expected" ]
}

@test "receipt: a run that found nothing still posts one" {
  # The whole point: zero findings must leave a trace.
  stub_gh
  run "$SCRIPT" 42 --sha "$SHA" --posted 0 --skipped 0
  [ "$status" -eq 0 ]
  [ -f "$BATS_TEST_TMPDIR/payload.json" ]
  payload | jq -r .body | grep -q "0 posted"
}

@test "receipt: the body records the counts, the agents and the profile" {
  stub_gh
  run "$SCRIPT" 42 --sha "$SHA" --posted 3 --skipped 2 --agents "security-auditor,architect-reviewer" --profile small-code
  [ "$status" -eq 0 ]
  body="$(payload | jq -r .body)"
  [[ "$body" == *"3 posted"* ]]
  [[ "$body" == *"2 skipped"* ]]
  [[ "$body" == *"security-auditor,architect-reviewer"* ]]
  [[ "$body" == *"small-code"* ]]
  [[ "$body" == *"${SHA:0:8}"* ]]
}

@test "receipt: shell metacharacters in free-text flags are data, never executed" {
  stub_gh
  run "$SCRIPT" 42 --sha "$SHA" --posted 1 --agents '$(touch '"$BATS_TEST_TMPDIR"'/pwned);x' --profile '`touch '"$BATS_TEST_TMPDIR"'/pwned2`'
  [ "$status" -eq 0 ]
  [ ! -e "$BATS_TEST_TMPDIR/pwned" ]
  [ ! -e "$BATS_TEST_TMPDIR/pwned2" ]
  payload | jq -r .body | grep -qF 'touch'
}

@test "receipt: --repo skips the repository lookup" {
  with_fake_tool_bin gh "
    if [ \"\$1\" = repo ]; then echo 'repo view must not be called' >&2; exit 9; fi
    printf '%s\n' \"\$@\" > '$BATS_TEST_TMPDIR/argv'
    exit 0
  " >/dev/null
  run "$SCRIPT" 42 --sha "$SHA" --posted 1 --repo other/place
  [ "$status" -eq 0 ]
  grep -q "repos/other/place/pulls/42/reviews" "$BATS_TEST_TMPDIR/argv"
}

@test "receipt: a failed POST is exit 1" {
  stub_gh 1
  run "$SCRIPT" 42 --sha "$SHA" --posted 1
  [ "$status" -eq 1 ]
}

@test "receipt: refuses malformed invocations with exit 3 before touching the network" {
  stub_gh
  run "$SCRIPT"
  [ "$status" -eq 3 ]
  run "$SCRIPT" abc --sha "$SHA" --posted 1
  [ "$status" -eq 3 ]
  run "$SCRIPT" 42 --posted 1
  [ "$status" -eq 3 ]
  run "$SCRIPT" 42 --sha "not-a-sha" --posted 1
  [ "$status" -eq 3 ]
  run "$SCRIPT" 42 --sha "${SHA:0:39}" --posted 1
  [ "$status" -eq 3 ]
  run "$SCRIPT" 42 --sha "$SHA"
  [ "$status" -eq 3 ]
  run "$SCRIPT" 42 --sha "$SHA" --posted many
  [ "$status" -eq 3 ]
  run "$SCRIPT" 42 --sha "$SHA" --posted 1 --skipped -1
  [ "$status" -eq 3 ]
  [ ! -e "$BATS_TEST_TMPDIR/argv" ]
}
