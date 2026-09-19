#!/usr/bin/env bats
# merge-pr-attestation.bats — /merge-pr reuses SHA-pinned attestation evidence
# instead of re-running the work that produced it (P-G1).
#
# These skills are prose an agent executes, so nothing but a test like this
# stops an instruction from being quietly dropped in a later edit. The
# properties pinned here are the ones whose absence is invisible at run time:
# a command that silently re-runs the suite still looks correct, and so does
# one that silently trusts stale evidence — the first only wastes minutes, the
# second merges unverified code.
#
# Ordering matters as much as presence. The expensive commands must live BELOW
# the disposition step that decides whether they run at all; an agent reading
# top to bottom would otherwise execute them before reaching the decision.

load helpers

MERGE="$REPO_ROOT/commands/merge-pr.md"
TEMPLATE="$REPO_ROOT/plugins/dotbabel/templates/claude/commands/merge-pr.md"
PROMPT="$REPO_ROOT/.github/prompts/merge-pr.prompt.md"
# A fourth shipped copy, hand-maintained and gated by nothing — it sat a full
# major version behind until a review caught it.
EXAMPLE="$REPO_ROOT/examples/minimal-consumer/.claude/commands/merge-pr.md"

# First line number matching a pattern, or empty when absent.
line_of() {
  grep -nE "$1" "$2" | head -1 | cut -d: -f1
}

@test "merge-pr: reads the gate's attestation field, not the raw comment" {
  # The gate already parsed the evidence and extracted the SHA and leg names.
  # Re-deriving them by grepping the comment would be a second parser of a
  # security-relevant artifact, free to disagree with the one that gated.
  [ -f "$MERGE" ]
  run grep -qF 'result.attestation' "$MERGE"
  [ "$status" -eq 0 ]
  run grep -qiE 'attested (at|legs|SHA)' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: branches on attestation state, never on the absence of reasons" {
  # The dangerous misreading: a repository that never enabled attestation
  # produces an empty reason list too, so "no ATTESTATION_ reason" would skip
  # the suite and the quality profile with no evidence at all.
  for state in verified off explicit failed; do
    run grep -qF "\`$state\`" "$MERGE"
    [ "$status" -eq 0 ]
  done
}

@test "merge-pr: the disposition step precedes every expensive command" {
  # The load-bearing ordering claim. If the suite or the quality profile were
  # described before the step that decides whether to run them, an agent
  # following the prose would pay for both on every merge — which is the
  # duplication this change exists to remove.
  decide=$(line_of 'Decide how this pull request gets verified' "$MERGE")
  suite=$(line_of 'Run the full project test suite' "$MERGE")
  quality=$(line_of 'dotbabel quality check --profile pr' "$MERGE")

  [ -n "$decide" ]
  [ -n "$suite" ]
  [ -n "$quality" ]
  [ "$suite" -gt "$decide" ]
  [ "$quality" -gt "$decide" ]
}

@test "merge-pr: the suite and the quality profile are on the explicit path only" {
  # Both must sit after the "Explicit path" heading, so neither reads as an
  # unconditional instruction.
  explicit=$(line_of '\*\*Explicit path\*\*' "$MERGE")
  suite=$(line_of 'Run the full project test suite' "$MERGE")
  quality=$(line_of 'dotbabel quality check --profile pr' "$MERGE")

  [ -n "$explicit" ]
  [ "$suite" -gt "$explicit" ]
  [ "$quality" -gt "$explicit" ]
}

@test "merge-pr: the attested path installs nothing and creates no worktree" {
  # The attested path's saving is not only the suite: it also skips the
  # worktree and the dependency install. Both must be described below the
  # explicit-path heading.
  explicit=$(line_of '\*\*Explicit path\*\*' "$MERGE")
  install=$(line_of 'Install dependencies first' "$MERGE")
  [ -n "$install" ]
  [ "$install" -gt "$explicit" ]
}

@test "merge-pr: every ATTESTATION_ reason code is named with its disposition" {
  for code in ATTESTATION_MISSING ATTESTATION_STALE ATTESTATION_UNTRUSTED \
    ATTESTATION_INVALID ATTESTATION_CONFIG_CHANGED ATTESTATION_BASE_MOVED \
    ATTESTATION_INCOMPLETE ATTESTATION_FAILED; do
    run grep -qF "$code" "$MERGE"
    [ "$status" -eq 0 ]
  done
}

@test "merge-pr: blocks on stale evidence and names the producer command" {
  run grep -qi 'BLOCKED' "$MERGE"
  [ "$status" -eq 0 ]
  run grep -qE '/pr-conductor <N> --from local-attest' "$MERGE"
  [ "$status" -eq 0 ]
  run grep -qE 'dotbabel local-attest --pr' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: never runs the matrix itself" {
  # The lifecycle boundary. If merge-pr could produce evidence, a stale
  # attestation would silently become a ten-minute merge instead of a stop,
  # and the explicit hand-off between conducting and merging would be gone.
  run grep -qi 'never re-run the matrix from inside this command' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: says a governed-file PR cannot attest itself, and that re-running is not the recovery" {
  # An agent that treats this like the other reason codes loops forever:
  # re-running local-attest cannot change the state, because the change is in
  # the pull request itself rather than in the evidence.
  # Whitespace-normalised: prettier re-wraps this prose, and a phrase that
  # happens to straddle a line break must not decide whether the contract holds.
  flat=$(tr '\n' ' ' < "$MERGE" | tr -s ' ')
  [[ "$flat" == *"its own attestation cannot authorize it"* ]]
  [[ "$flat" == *"cannot change this state and is not the recovery"* ]]
}

@test "merge-pr: never reports an attested leg as something it ran" {
  run grep -qi 'never report an unrun check as a pass' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: still requires explicit human confirmation" {
  run grep -qi 'Never merge without explicit user confirmation' "$MERGE"
  [ "$status" -eq 0 ]
  run grep -qi 'neither is a clean gate' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: strips every skip-ci form the gate detects, not just three" {
  # pr-gates.mjs SKIP_CI_RE matches [no ci], [skip actions] and [actions skip]
  # too. A form the gate knows about but the strip misses reaches main and
  # suppresses release-please for the merge commit.
  for marker in 'skip ci' 'ci skip' 'no ci' 'skip actions' 'actions skip'; do
    run grep -qF "$marker" "$MERGE"
    [ "$status" -eq 0 ]
  done
  run grep -qF 'skip-checks' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: verifies the merge commit is marker-free afterwards" {
  strip=$(line_of 'gh pr merge <N> --squash' "$MERGE")
  verify=$(line_of 'git log --format=%B -1 <merge-sha>' "$MERGE")
  [ -n "$strip" ]
  [ -n "$verify" ]
  [ "$verify" -gt "$strip" ]
}

@test "merge-pr: the generated copies carry the attestation contract too" {
  # The template copy is held byte-identical by build-plugin --check; the
  # prompt copy is not gated in CI, so it is the load-bearing one.
  for file in "$TEMPLATE" "$PROMPT" "$EXAMPLE"; do
    [ -f "$file" ]
    run grep -qF 'ATTESTATION_CONFIG_CHANGED' "$file"
    [ "$status" -eq 0 ]
    run grep -qF 'result.attestation' "$file"
    [ "$status" -eq 0 ]
  done
}


# --- Governed-file pull requests must have a route, not a dead end -----------
#
# The first version told the reader "land the change through explicit
# verification" in one place and STOP in another, with nothing connecting them.
# A pull request that edits package.json could not be merged by following the
# document, and re-running local-attest could not fix it. These pin the route.

@test "merge-pr: the explicit state is routed to the explicit path, not to STOP" {
  run grep -qE '\| `explicit` \|' "$MERGE"
  [ "$status" -eq 0 ]
  row=$(grep -E '\| `explicit` \|' "$MERGE")
  [[ "$row" == *"explicit path"* ]]
  [[ "$row" != *"STOP"* ]]
}

@test "merge-pr: the governed-file diff is shown before anything is run" {
  # Ordering is the property. The explicit path executes the pull request's own
  # scripts; if the suite were described before the diff review, an agent
  # reading top to bottom would run a rewritten test script first.
  review=$(line_of 'read the governed-file diff and show it to the' "$MERGE")
  suite=$(line_of 'Run the full project test suite' "$MERGE")
  [ -n "$review" ]
  [ -n "$suite" ]
  [ "$review" -lt "$suite" ]
}

@test "merge-pr: a green suite is explicitly not the acknowledgement" {
  run grep -qi 'a green suite is not' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: says why the automated run cannot guard this path" {
  # Without the reason the step reads as ceremony and gets skipped.
  run grep -qi 'would pass its own' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: stops when the governed-file diff weakens a check" {
  run grep -qi 'weakens a check' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: CONFIG_CHANGED now means the base moved, and says rebase" {
  # It used to mean "this PR edits a governed file", which is now its own state.
  row=$(grep -A6 'ATTESTATION_CONFIG_CHANGED. — the attestation' "$MERGE" | tr '\n' ' ')
  [[ "$row" == *"base moved"* ]]
  [[ "$row" == *"Rebase"* ]]
}

@test "merge-pr: names the warning code the gate emits for a governed change" {
  run grep -qF 'ATTESTATION_GOVERNED_CHANGE' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: the rule against skipping the diff review is stated as a rule" {
  run grep -qE '^- Never take the explicit path for an `explicit` state' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: does not report READY as if evidence sufficed for an explicit PR" {
  run grep -qF 'attestation.state: explicit' "$REPO_ROOT/skills/pr-conductor/SKILL.md"
  [ "$status" -eq 0 ]
}
