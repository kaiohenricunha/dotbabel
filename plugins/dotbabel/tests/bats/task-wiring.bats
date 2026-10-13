#!/usr/bin/env bats
# task-wiring.bats — the skills that move a pull request forward keep the
# worktree's task (`dotbabel task`) current.
#
# Assertions:
#   1. pr-conductor tells the agent to record the pull request, each next
#      phase, and the go/no-go on an open task, and to skip it with no task
#   2. /git pr records the pull request it opened on an open task
#   3. the commands the prose names run against a real task: the decision and
#      phase updates land where `dotbabel task show` reads them

load helpers

CONDUCTOR="$REPO_ROOT/skills/pr-conductor/SKILL.md"
GIT_SKILL="$REPO_ROOT/skills/git/SKILL.md"
TASK_BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-task.mjs"
STACK_BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-pr-stack.mjs"

@test "task-wiring: pr-conductor records the PR, each next phase and the go/no-go on an open task" {
  grep -q '^## Task state$' "$CONDUCTOR"
  grep -qF 'dotbabel task update <slug> --decision "PR #<N>"' "$CONDUCTOR"
  grep -qF 'dotbabel task update <slug> --phase <id>' "$CONDUCTOR"
  # /git pr records the PR in phase 2; the conductor only fills in a self-skip.
  grep -qF 'self-skipped because the pull request already existed' "$CONDUCTOR"
  grep -qF 'A phase that failed or blocked stays the current phase' "$CONDUCTOR"
  grep -qF -- '--decision "READY"' "$CONDUCTOR"
  grep -qF -- '--decision "BLOCKED: <CODE>"' "$CONDUCTOR"
  # Optional by design: no task, or no dotbabel, never blocks a phase.
  grep -qiE 'no task exists, or `dotbabel` is not installed, skip' "$CONDUCTOR"
}

@test "task-wiring: /git pr records the pull request on an open task" {
  grep -qF 'dotbabel task update <slug> --phase pr --decision "PR #<N>"' "$GIT_SKILL"
  grep -qiE 'no task, or `dotbabel` is not installed, skip' "$GIT_SKILL"
}

@test "task-wiring: the task commands the prose names run against a real task" {
  repo="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$repo"
  cd "$repo"
  git init -q .
  run node "$TASK_BIN" new demo --goal "land the change" --done-when "CI green"
  [ "$status" -eq 0 ]
  # The commands as /git pr, the conductor's phase step and its stop step write them.
  run node "$TASK_BIN" update demo --phase pr --decision "PR #12"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  next=$(node "$STACK_BIN" phases --json | jq -r '.result.phases[2].id')
  run node "$TASK_BIN" update demo --phase "$next"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  run node "$TASK_BIN" update demo --decision "READY"
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  run node "$TASK_BIN" show demo --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e --arg p "$next" '.task.phase == $p' >/dev/null
  echo "$output" | jq -e '[.task.decisions[].text] == ["PR #12", "READY"]' >/dev/null
}
