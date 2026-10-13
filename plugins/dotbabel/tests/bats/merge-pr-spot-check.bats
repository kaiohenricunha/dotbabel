#!/usr/bin/env bats
# merge-pr-spot-check.bats — /merge-pr verifies a share of attested pull
# requests anyway, and raises the alarm when that run contradicts the
# attestation (spec merge-verification).
#
# An agent with the user's gh token can post an attestation comment itself.
# The spot check is how a forged one gets caught before the merge, and
# main-status is how unverified merges get seen after it. Both are prose an
# agent follows, so an instruction that is quietly dropped or moved below the
# step it guards is invisible at run time. These cases pin presence and order.

load helpers

MERGE="$REPO_ROOT/commands/merge-pr.md"
TEMPLATE="$REPO_ROOT/plugins/dotbabel/templates/claude/commands/merge-pr.md"
PROMPT="$REPO_ROOT/.github/prompts/merge-pr.prompt.md"
EXAMPLE="$REPO_ROOT/examples/minimal-consumer/.claude/commands/merge-pr.md"

# First line number matching a pattern, or empty when absent.
line_of() {
  grep -nE "$1" "$2" | head -1 | cut -d: -f1
}

@test "merge-pr: a verified state runs the spot check before the explicit path is described" {
  decide=$(line_of 'Decide how this pull request gets verified' "$MERGE")
  spot=$(line_of 'dotbabel pr-stack spot-check --pr <N>$' "$MERGE")
  explicit=$(line_of '\*\*Explicit path\*\*' "$MERGE")
  [ -n "$decide" ]
  [ -n "$spot" ]
  [ -n "$explicit" ]
  [ "$spot" -gt "$decide" ]
  [ "$spot" -lt "$explicit" ]
}

@test "merge-pr: a selected pull request takes the explicit path and says why" {
  flat=$(tr '\n' ' ' < "$MERGE" | tr -s ' ')
  [[ "$flat" == *'`SELECTED` — take the explicit path in step 6 anyway, and tell the user why'* ]]
  # The explicit path names the spot check as one of the ways in.
  [[ "$flat" == *"a \`verified\` state that the spot check selected"* ]]
}

@test "merge-pr: the roll is not re-rolled, and an unreadable policy stops" {
  flat=$(tr '\n' ' ' < "$MERGE" | tr -s ' ')
  [[ "$flat" == *"Do not run it again to get a different one"* ]]
  [[ "$flat" == *"Never treat a non-zero exit as \`not selected\`"* ]]
  # An older CLI exits 64 for an unknown subcommand; that is not "not selected".
  [[ "$flat" == *"Exit \`64\` usually means that the installed \`dotbabel\` has no \`spot-check\` yet"* ]]
}

@test "merge-pr: the explicit run's result is recorded where the explicit run happens" {
  run grep -qF 'dotbabel pr-stack spot-check --pr <N> --record-explicit' "$MERGE"
  [ "$status" -eq 0 ]
  explicit=$(line_of '\*\*Explicit path\*\*' "$MERGE")
  record=$(line_of 'Record the explicit run if the spot check sent you here' "$MERGE")
  interpret=$(line_of 'Interpret failures honestly' "$MERGE")
  [ -n "$record" ]
  [ "$record" -gt "$explicit" ]
  [ "$record" -lt "$interpret" ]
}

@test "merge-pr: only a real failure raises the alarm; a gate that did not run raises none" {
  flat=$(tr '\n' ' ' < "$MERGE" | tr -s ' ')
  [[ "$flat" == *'Only a real failure counts: the suite exits non-zero after a clean dependency install, or the quality profile exits `1`'* ]]
  [[ "$flat" == *'A quality exit `2`, `64` or `127`, or a failed dependency install, means the gate did not run'* ]]
  [[ "$flat" == *"Record no result and raise no alarm"* ]]
}

@test "merge-pr: says what to do on a non-zero main-status exit" {
  status_line=$(line_of 'dotbabel pr-stack main-status$' "$MERGE")
  exits=$(line_of 'Read the exit code. Exit `0` means the report is complete' "$MERGE")
  [ -n "$exits" ]
  [ "$exits" -gt "$status_line" ]
}

@test "merge-pr: a failed spot check stops and raises the contradiction alarm" {
  stop=$(line_of 'A spot-checked pull request failed' "$MERGE")
  alarm=$(line_of 'dotbabel pr-stack contradiction --pr <N> --local-failure --post' "$MERGE")
  explicit=$(line_of '\*\*Explicit path\*\*' "$MERGE")
  [ -n "$stop" ]
  [ -n "$alarm" ]
  [ "$stop" -gt "$explicit" ]
  [ "$alarm" -gt "$stop" ]
  flat=$(tr '\n' ' ' < "$MERGE" | tr -s ' ')
  [[ "$flat" == *"this is contradicted evidence, not an ordinary failure"* ]]
}

@test "merge-pr: reports main-status debt after the merge, never unknown as verified" {
  merge=$(line_of 'gh pr merge <N> --squash' "$MERGE")
  status_line=$(line_of 'dotbabel pr-stack main-status$' "$MERGE")
  [ -n "$merge" ]
  [ -n "$status_line" ]
  [ "$status_line" -gt "$merge" ]
  flat=$(tr '\n' ' ' < "$MERGE" | tr -s ' ')
  [[ "$flat" == *"report it as unknown, never as verified"* ]]
}

@test "merge-pr: the spot-check rules are stated as rules" {
  run grep -qE '^- Never take the attested path for a pull request the spot check selected' "$MERGE"
  [ "$status" -eq 0 ]
}

@test "merge-pr: the generated copies carry the spot check and the alarm" {
  for file in "$TEMPLATE" "$PROMPT" "$EXAMPLE"; do
    [ -f "$file" ]
    run grep -qF 'dotbabel pr-stack spot-check --pr <N>' "$file"
    [ "$status" -eq 0 ]
    run grep -qF 'dotbabel pr-stack contradiction --pr <N> --local-failure --post' "$file"
    [ "$status" -eq 0 ]
    run grep -qF 'dotbabel pr-stack main-status' "$file"
    [ "$status" -eq 0 ]
    run grep -qF 'Never treat a non-zero exit as `not selected`' "$file"
    [ "$status" -eq 0 ]
  done
}

@test "pr-stack: the three merge-verification subcommands are implemented" {
  run node "$REPO_ROOT/plugins/dotbabel/bin/dotbabel-pr-stack.mjs" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"spot-check"* ]]
  [[ "$output" == *"main-status"* ]]
  [[ "$output" == *"contradiction"* ]]
}
