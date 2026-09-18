#!/usr/bin/env bats
# pre-pr-conductor-scope.bats — `--conductor` narrows /pre-pr to a pre-review
# preflight, and a direct /pre-pr keeps its full pre-PR semantics (P-G2).
#
# Both halves need pinning, and for different reasons. The narrowing is
# invisible at run time: a conductor that quietly ran the `pr` profile would
# look identical, just slower, while grading a tree the review fleet is about
# to change. The standalone contract is the one a human relies on when they
# invoke /pre-pr themselves, and nothing else in the pipeline would notice if
# it silently weakened to `fast`.

load helpers

PREPR="$REPO_ROOT/commands/pre-pr.md"
CONDUCTOR="$REPO_ROOT/skills/pr-conductor/SKILL.md"

line_of() {
  grep -nE "$1" "$2" | head -1 | cut -d: -f1
}

@test "pre-pr: standalone still runs the PR quality profile" {
  [ -f "$PREPR" ]
  run grep -qF 'dotbabel quality check --profile pr --base "$BASE"' "$PREPR"
  [ "$status" -eq 0 ]
}

@test "pre-pr: conductor mode runs the fast quality profile" {
  run grep -qF 'dotbabel quality check --profile fast --base "$BASE"' "$PREPR"
  [ "$status" -eq 0 ]
}

@test "pre-pr: the two profiles are selected by the mode, not left ambiguous" {
  # A document naming both profiles without branching on CONDUCTOR would leave
  # an agent to guess which one applies.
  run grep -qE 'if \[ "\$CONDUCTOR" = "1" \]' "$PREPR"
  [ "$status" -eq 0 ]
}

@test "pre-pr: conductor mode skips the PR body checklist" {
  run grep -qi 'Conductor mode: skip this step' "$PREPR"
  [ "$status" -eq 0 ]
  # And says who does it instead, so the check is not simply dropped.
  run grep -qF 'gate --gate merge' "$PREPR"
  [ "$status" -eq 0 ]
}

@test "pre-pr: conductor mode still stops on a secrets hit" {
  # The narrowing must not weaken the one thing phase 3 cannot catch: phase 3
  # runs after the push, so a secret has already left the machine by then.
  run grep -qi 'CRITICAL' "$PREPR"
  [ "$status" -eq 0 ]
  run grep -qF 'handoff-scrub.sh' "$PREPR"
  [ "$status" -eq 0 ]
}

@test "pre-pr: the rules name every narrowed step, not just the security one" {
  run grep -qi 'narrows steps 3, 4 and 5' "$PREPR"
  [ "$status" -eq 0 ]
}

@test "pre-pr: simplify and scope detection are unchanged in both modes" {
  # Steps 1 and 2 are not narrowed; a rule claiming otherwise would be drift.
  run grep -qF '/code-simplifier $BASE' "$PREPR"
  [ "$status" -eq 0 ]
  run grep -qF 'style: pre-pr simplification pass' "$PREPR"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: phase 1 no longer claims to own the test suite" {
  # The claim was false once the authoritative profile moved to local-attest,
  # and a stale claim is how an operator concludes the suite already ran.
  run grep -n 'test suite' "$CONDUCTOR"
  [ "$status" -eq 1 ]
}

@test "pr-conductor: step 0 derives the entry phase" {
  run grep -qF 'dotbabel pr-stack entry' "$CONDUCTOR"
  [ "$status" -eq 0 ]
  for reason in NO_PR PR_OPEN; do
    run grep -qF "$reason" "$CONDUCTOR"
    [ "$status" -eq 0 ]
  done
}

@test "pr-conductor: --from is documented as an override of the derived entry" {
  run grep -qi 'Overrides the derived entry' "$CONDUCTOR"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: refuses to derive a terminal phase from an attestation" {
  # The omission is the contract, so it is stated rather than merely absent —
  # otherwise a later edit "helpfully" adds the shortcut back.
  run grep -qi 'no "already attested, so stop" outcome' "$CONDUCTOR"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: the entry derivation precedes phase 1" {
  entry=$(line_of 'dotbabel pr-stack entry' "$CONDUCTOR")
  phase1=$(line_of '^### 1\. `pre-pr`' "$CONDUCTOR")
  [ -n "$entry" ]
  [ -n "$phase1" ]
  [ "$entry" -lt "$phase1" ]
}

@test "pr-conductor: still never merges" {
  run grep -qF 'gh pr merge' "$CONDUCTOR"
  [ "$status" -eq 1 ]
  run grep -qi 'Never merge' "$CONDUCTOR"
  [ "$status" -eq 0 ]
}
