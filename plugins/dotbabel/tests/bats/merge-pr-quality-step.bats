#!/usr/bin/env bats
# merge-pr-quality-step.bats — commands/merge-pr.md step 5 runs the PR
# quality profile (P-C5, KD-9's replacement for the removed regression_paths
# gate), and names both stop-worthy exit codes explicitly, so an agent
# following the command halts on a policy failure or unavailable tooling
# instead of reading past the numbers. Checked in all three shipped copies —
# commands/merge-pr.md is the source; the other two must not drift from it.

load helpers

check_quality_step() {
  local file="$1"

  run grep -F "dotbabel quality check --profile pr" "$file"
  [ "$status" -eq 0 ]

  run grep -i "exit code \`1\` means a checked rule failed" "$file"
  [ "$status" -eq 0 ]

  run grep -i "exit code \`2\` means required evidence" "$file"
  [ "$status" -eq 0 ]

  # "STOP" is markdown-bolded (**STOP**) in the prose, so match past the
  # markers rather than the literal word plus a space.
  run grep -i "STOP.*for either exit code" "$file"
  [ "$status" -eq 0 ]

  # The removed gate must not still be described anywhere in the step.
  run grep -i "regression" "$file"
  [ "$status" -eq 1 ]
}

@test "merge-pr: step 5 runs the PR quality profile and stops on exit 1 or 2" {
  check_quality_step "$REPO_ROOT/commands/merge-pr.md"
}

@test "merge-pr template copy: step 5 runs the PR quality profile and stops on exit 1 or 2" {
  check_quality_step "$REPO_ROOT/plugins/dotbabel/templates/claude/commands/merge-pr.md"
}

@test "merge-pr prompt copy: step 5 runs the PR quality profile and stops on exit 1 or 2" {
  check_quality_step "$REPO_ROOT/.github/prompts/merge-pr.prompt.md"
}
