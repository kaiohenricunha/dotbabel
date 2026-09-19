#!/usr/bin/env bats
# review-complete-contract.bats — the prose an agent executes must drive the
# review-complete workflow, and the command's wiring must hold end to end (P-G6).
#
# Three skills cooperate and none of them can enforce the others' half:
#
#   post-pr-review  ends every run with a receipt, findings or none
#   review-pr       ends with `pr-stack review-complete`, which checks and posts
#   pr-conductor    reads the result on re-entry and skips what already ran
#
# Drop any one instruction in a later edit and nothing fails at run time: the
# conductor simply stops being able to skip, or worse, skips on a stale premise.
# The properties below are the ones whose absence is invisible.

load helpers

POST="$REPO_ROOT/skills/post-pr-review/SKILL.md"
REVIEW="$REPO_ROOT/skills/review-pr/SKILL.md"
CONDUCTOR="$REPO_ROOT/skills/pr-conductor/SKILL.md"

line_of() {
  grep -nE "$1" "$2" | head -1 | cut -d: -f1
}

# --- post-pr-review: the receipt --------------------------------------------

@test "post-pr-review: every run ends by leaving a receipt, before the final report" {
  run grep -qF 'post-pr-review-post-receipt.sh' "$POST"
  [ "$status" -eq 0 ]
  receipt=$(line_of '^### 8b\.' "$POST")
  report=$(line_of '^### 9\. Final report' "$POST")
  post=$(line_of '^### 8\. Post' "$POST")
  [ -n "$receipt" ]
  [ "$post" -lt "$receipt" ]
  [ "$receipt" -lt "$report" ]
}

@test "post-pr-review: the receipt covers a run that found nothing, and is pinned to the head bound in step 1" {
  run grep -qi 'including a run that found nothing' "$POST"
  [ "$status" -eq 0 ]
  run grep -qF -- '--sha "$HEAD_SHA"' "$POST"
  [ "$status" -eq 0 ]
}

@test "post-pr-review: the receipt is skipped only for a dry run or a failed post" {
  run grep -qiE 'Skip it only under `--dry-run`' "$POST"
  [ "$status" -eq 0 ]
}

@test "post-pr-review: the receipt script is named beside its siblings and is executable" {
  [ -x "$REPO_ROOT/plugins/dotbabel/scripts/post-pr-review-post-receipt.sh" ]
}

# --- review-pr: recording completion ----------------------------------------

@test "review-pr: records completion after criteria verification and before the summary" {
  run grep -qE 'dotbabel pr-stack review-complete --pr' "$REVIEW"
  [ "$status" -eq 0 ]
  criteria=$(line_of '^### 14\. ' "$REVIEW")
  record=$(line_of '^### 14b\. ' "$REVIEW")
  summary=$(line_of '^### 15\. ' "$REVIEW")
  [ -n "$record" ]
  [ "$criteria" -lt "$record" ]
  [ "$record" -lt "$summary" ]
}

@test "review-pr: runs the recording from the PR worktree so both commits are local" {
  run grep -qE 'cd "\.claude/worktrees/pr-\$NUMBER" && dotbabel pr-stack review-complete' "$REVIEW"
  [ "$status" -eq 0 ]
}

@test "review-pr: records for reviewed and deferred rows, never for a blocked one" {
  run grep -qiE 'only when the row is about to be `reviewed` or, in conductor mode, `deferred`' "$REVIEW"
  [ "$status" -eq 0 ]
  run grep -qiE 'never for `blocked`' "$REVIEW"
  [ "$status" -eq 0 ]
}

@test "review-pr: a refusal is reported, never worked around, and the marker is never hand-written" {
  run grep -qi 'Never work around it' "$REVIEW"
  [ "$status" -eq 0 ]
  run grep -qi 'Never hand-write the marker' "$REVIEW"
  [ "$status" -eq 0 ]
}

@test "review-pr: conductor mode does not narrow the recording" {
  run grep -qE '^- \*\*Step 14b\*\* — NOT narrowed' "$REVIEW"
  [ "$status" -eq 0 ]
}

@test "review-pr: a false-positive finding thread is resolved, since an open one blocks the recording" {
  run grep -qi 'answered as a false positive in step 4 counts as addressed' "$REVIEW"
  [ "$status" -eq 0 ]
}

# --- pr-conductor: reading it back ------------------------------------------

@test "pr-conductor: every reason deriveEntryPhase can return is documented in step 0" {
  reasons="$(node --input-type=module -e "
    import { deriveEntryPhase } from '$REPO_ROOT/plugins/dotbabel/src/pr-gates.mjs';
    const states = [
      { prNumber: null },
      { prNumber: 1 },
      { prNumber: 1, reviewedAtHead: true },
      { prNumber: 1, reviewedAtHead: true, attestedAtHead: true },
    ];
    console.log([...new Set(states.map((s) => deriveEntryPhase(s).reason))].join(' '));
  ")"
  [ -n "$reasons" ]
  for reason in $reasons; do
    run grep -qE "^\| \`$reason\`" "$CONDUCTOR"
    [ "$status" -eq 0 ]
  done
}

@test "pr-conductor: says neither fact stands in for the other" {
  run grep -qi 'Neither fact stands in for the other' "$CONDUCTOR"
  [ "$status" -eq 0 ]
  run grep -qi 'Only a review-complete marker can skip phases 1 to 4' "$CONDUCTOR"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: names the command that posts the marker and the check it makes first" {
  run grep -qF 'dotbabel pr-stack review-complete' "$CONDUCTOR"
  [ "$status" -eq 0 ]
  run grep -qiE 'receipt.*no finding it posted is still open' "$CONDUCTOR"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: an unreadable comment falls back to the safe entry rather than guessing" {
  run grep -qiE 'cannot be read.*falls back to `PR_OPEN`' "$CONDUCTOR"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: still never merges" {
  run grep -qi 'never merge' "$CONDUCTOR"
  [ "$status" -eq 0 ]
}
