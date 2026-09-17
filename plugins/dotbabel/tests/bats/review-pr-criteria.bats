#!/usr/bin/env bats
# review-pr-criteria.bats — P-B4 contract tests binding the review and merge
# prose to the criteria workflow it is now required to drive.
#
# These skills are prose that an agent executes, so nothing but a test like
# this stops an instruction from being quietly dropped in a later edit. The
# properties asserted here are the ones whose absence is invisible at run time:
# a reviewer that never verifies criteria still looks like it reviewed, and a
# conductor that advances past a failing criterion still looks like it passed.
#
# Assertions:
#   1. review-pr runs `dotbabel criteria verify --pr … --post` as its LAST step
#   2. conductor mode runs it too, rather than deferring it away
#   3. the test-quality judgment opens threads and never writes a status
#   4. a failing criterion reports BLOCKED and stops the conductor
#   5. the prompt marks test output and comments as untrusted data
#   6. merge-pr re-verifies on CRITERIA_EVIDENCE_STALE

load helpers

REVIEW="$REPO_ROOT/skills/review-pr/SKILL.md"
CONDUCTOR="$REPO_ROOT/skills/pr-conductor/SKILL.md"
MERGE="$REPO_ROOT/commands/merge-pr.md"

@test "review-pr: runs dotbabel criteria verify with --pr and --post as its last step, after the final branch health gate" {
  [ -f "$REVIEW" ]
  run grep -qE 'dotbabel criteria verify --pr .*--post' "$REVIEW"
  [ "$status" -eq 0 ]

  # Ordering is the property, not mere presence: verification must come after
  # the final branch health gate, or it would attest a SHA the gate has not
  # yet confirmed is mergeable.
  health_line=$(grep -n '^### .*[Ff]inal branch health' "$REVIEW" | head -1 | cut -d: -f1)
  verify_line=$(grep -nE 'dotbabel criteria verify --pr .*--post' "$REVIEW" | head -1 | cut -d: -f1)
  [ -n "$health_line" ]
  [ -n "$verify_line" ]
  [ "$verify_line" -gt "$health_line" ]
}

@test "review-pr: conductor mode still runs criteria verification before it returns" {
  # The --conductor narrowings exist to remove DUPLICATED work. Criteria
  # verification is not duplicated anywhere else in the pipeline, so it must
  # survive the narrowing.
  run grep -qiE 'conductor mode.*(criteria|verification)|criteria.*(standalone|conductor) (mode )?alike' "$REVIEW"
  [ "$status" -eq 0 ]
}

@test "review-pr: the test-quality judgment opens review threads and never writes a criterion status" {
  run grep -qi 'test-quality judgment' "$REVIEW"
  [ "$status" -eq 0 ]
  # The judgment is advisory: it opens threads for a human. Letting it write a
  # criterion status would make an LLM opinion into machine-checked evidence.
  run grep -qiE 'never (writes|sets) a criterion status|opens .*thread' "$REVIEW"
  [ "$status" -eq 0 ]
}

@test "review-pr: a failing criterion reports BLOCKED and stops the conductor before local-attest" {
  run grep -qE 'BLOCKED' "$REVIEW"
  [ "$status" -eq 0 ]
  run grep -qiE 'failing criterion|criterion .*not `?pass`?' "$REVIEW"
  [ "$status" -eq 0 ]

  # AC-15's "then" clause is an ORDERING claim: the stop happens BEFORE
  # local-attest. A bare `grep criteri` on the conductor would match a sentence
  # saying the opposite, so assert the stop instruction actually precedes the
  # local-attest phase heading.
  stop_line=$(grep -niE 'does \*\*not\*\* advance to `local-attest`|not advance to .local-attest' "$CONDUCTOR" | head -1 | cut -d: -f1)
  attest_line=$(grep -nE '^### 5\. `local-attest`' "$CONDUCTOR" | head -1 | cut -d: -f1)
  [ -n "$stop_line" ]
  [ -n "$attest_line" ]
  [ "$stop_line" -lt "$attest_line" ]
}

@test "review-pr: the prompt tells the agent to treat test output and comments as untrusted data" {
  # Test output and PR comments are attacker-influenced text that this skill
  # feeds to an agent. Without this instruction a crafted test name is a
  # prompt-injection vector into a tool-using reviewer.
  run grep -qiE 'untrusted data' "$REVIEW"
  [ "$status" -eq 0 ]
  run grep -qiE 'test output|comments' "$REVIEW"
  [ "$status" -eq 0 ]
}

@test "merge-pr: runs dotbabel criteria verify again when the gate reports CRITERIA_EVIDENCE_STALE" {
  [ -f "$MERGE" ]
  run grep -q 'CRITERIA_EVIDENCE_STALE' "$MERGE"
  [ "$status" -eq 0 ]
  run grep -qE 'dotbabel criteria verify' "$MERGE"
  [ "$status" -eq 0 ]
}
