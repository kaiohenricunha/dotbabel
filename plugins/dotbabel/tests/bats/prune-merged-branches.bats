#!/usr/bin/env bats
# Tests for scripts/prune-merged-branches.sh — local-only branch pruner that
# deletes empty-diff or merged-PR branches matching feat/handoff-*, fix/handoff-*,
# test/handoff-*. Default is --dry-run; --confirm performs deletes.

load helpers

bats_require_minimum_version 1.5.0

SCRIPT="$REPO_ROOT/scripts/prune-merged-branches.sh"

setup() {
  TEST_DIR=$(mktemp -d)
  cd "$TEST_DIR"
  git init -q -b main
  git config user.email "bats@example.test"
  git config user.name "bats"
  echo "init" > README.md
  git add README.md
  git commit -q -m "init"

  # Empty-diff branch: forks main, no new commits → diff stat is empty.
  git branch feat/handoff-empty
  # Has-changes branch: one new commit → not empty diff.
  git checkout -q -b feat/handoff-real
  echo "real change" > real.txt
  git add real.txt
  git commit -q -m "real work"
  git checkout -q main
  # Unrelated branch: should not match the default pattern.
  git branch feat/other-unrelated
}

teardown() {
  cd /
  [ -n "${TEST_DIR:-}" ] && [ -d "$TEST_DIR" ] && rm -rf "$TEST_DIR"
}

@test "--dry-run lists empty-diff as deletable, has-changes as kept, deletes nothing" {
  
  before_count=$(git branch | wc -l)
  run "$SCRIPT" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"feat/handoff-empty"* ]]
  [[ "$output" == *"feat/handoff-real"* ]]
  # Output must distinguish deletable vs kept.
  [[ "$output" == *"deletable"* ]] || [[ "$output" == *"would delete"* ]]
  after_count=$(git branch | wc -l)
  [ "$before_count" -eq "$after_count" ]
}

@test "default (no flag) is dry-run" {
  
  before_count=$(git branch | wc -l)
  run "$SCRIPT"
  [ "$status" -eq 0 ]
  after_count=$(git branch | wc -l)
  [ "$before_count" -eq "$after_count" ]
}

@test "--confirm deletes the empty-diff branch and keeps has-changes + unrelated" {
  
  run "$SCRIPT" --confirm
  [ "$status" -eq 0 ]

  # feat/handoff-empty is gone.
  run git rev-parse --verify feat/handoff-empty
  [ "$status" -ne 0 ]

  # feat/handoff-real survives (has unique commits).
  run git rev-parse --verify feat/handoff-real
  [ "$status" -eq 0 ]

  # feat/other-unrelated survives (does not match handoff pattern).
  run git rev-parse --verify feat/other-unrelated
  [ "$status" -eq 0 ]
}

@test "refuses --push" {
  
  run "$SCRIPT" --push
  [ "$status" -ne 0 ]
  [[ "$output" == *"local-only"* ]] || [[ "$output" == *"refuse"* ]] || [[ "$output" == *"not supported"* ]]
}

@test "refuses --delete-remote" {
  
  run "$SCRIPT" --delete-remote
  [ "$status" -ne 0 ]
  [[ "$output" == *"local-only"* ]] || [[ "$output" == *"refuse"* ]] || [[ "$output" == *"not supported"* ]]
}
