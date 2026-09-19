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

@test "pre-pr: the narrowing is conditional on the pr profile being attested later" {
  # security.high_confidence is a pr-profile rule and a forbidden-exception
  # floor. Narrowing unconditionally would drop it, and in a consumer repo
  # (matrix [], required_legs []) it would then run nowhere in the pipeline.
  run grep -qF 'required_legs' "$PREPR"
  [ "$status" -eq 0 ]
  run grep -qF 'QUALITY_ATTESTED' "$PREPR"
  [ "$status" -eq 0 ]
  run grep -qF 'security.high_confidence' "$PREPR"
  [ "$status" -eq 0 ]
}

@test "pre-pr: the go/no-go summary reports which profile actually ran" {
  # Step 6 is the persisted record of the run. Reporting "PR profile passed"
  # after a fast run names a gate that never executed.
  run grep -qF 'fast profile passed (conductor' "$PREPR"
  [ "$status" -eq 0 ]
  run grep -qi 'skipped (conductor' "$PREPR"
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
  #
  # Anchored to the conductor secrets sentence specifically. A bare CRITICAL
  # grep is satisfied by the standalone step-3 severity list, which says
  # nothing about conductor mode — so softening `N > 0` to a warning while
  # leaving the scrubber call in place would keep that version green.
  run grep -qF 'handoff-scrub.sh' "$PREPR"
  [ "$status" -eq 0 ]
  run grep -E 'N > 0.*CRITICAL' "$PREPR"
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
  #
  # Scoped to phase 1's table row and its section body rather than banning the
  # phrase document-wide: phase 5 may legitimately say local-attest runs the
  # full test suite, and a whole-file ban would fail on that sentence under a
  # test name that claims to be about phase 1.
  run grep -E '^\| 1 +\| `pre-pr`' "$CONDUCTOR"
  [ "$status" -eq 0 ]
  [[ "$output" != *"test suite"* ]]

  start=$(grep -n '^### 1\. `pre-pr`' "$CONDUCTOR" | head -1 | cut -d: -f1)
  end=$(grep -n '^### 2\.' "$CONDUCTOR" | head -1 | cut -d: -f1)
  [ -n "$start" ]
  [ -n "$end" ]
  run sed -n "${start},${end}p" "$CONDUCTOR"
  [[ "$output" != *"test suite"* ]]
}

@test "pr-conductor: phase 1 is narrowed in both entry cases" {
  # The entry table once contrasted "phase 1 in full" against "the narrowed
  # preflight", but phase 1 invokes /pre-pr --conductor unconditionally. An
  # agent acting on that contrast would run the pr profile it exists to avoid.
  run grep -E '^\| `NO_PR`' "$CONDUCTOR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"narrowed preflight"* ]]
  [[ "$output" != *"in full"* ]]
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

# The never-merges contract is pinned by pr-conductor.bats, not duplicated here.
