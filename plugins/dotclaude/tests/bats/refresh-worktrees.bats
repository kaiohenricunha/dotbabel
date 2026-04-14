#!/usr/bin/env bats
# Behavior tests for plugins/harness/scripts/refresh-worktrees.sh.

load helpers

REFRESH="$REPO_ROOT/plugins/harness/scripts/refresh-worktrees.sh"

setup() {
  [ -x "$REFRESH" ] || chmod +x "$REFRESH"
  REPO=$(make_tmp_git_repo)
  export REPO
}

teardown() {
  [ -n "${REPO:-}" ] && [ -d "$REPO" ] && rm -rf "$REPO" "$REPO-bare.git"
}

# Add one worktree at .claude/worktrees/<name> branched from origin/main.
add_wt() {
  local name="$1"
  (cd "$REPO" && git worktree add -q ".claude/worktrees/$name" -b "feat/$name" origin/main)
}

@test "reports no-op when .claude/worktrees/ does not exist" {
  run bash -c "cd '$REPO' && '$REFRESH' '$REPO'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no worktrees"* ]]
}

@test "reports OK when worktree is already up to date with origin/main" {
  add_wt up-to-date
  run bash -c "cd '$REPO' && '$REFRESH' '$REPO'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK:"*"up-to-date"* ]] || [[ "$output" == *"FF:"*"up-to-date"* ]]
}

@test "fast-forwards a worktree that is behind origin/main" {
  add_wt behind
  # Advance main.
  (
    cd "$REPO"
    echo "ahead" > ahead.md
    git add ahead.md
    git commit -q -m "ahead"
    git push -q origin main
  )
  run bash -c "cd '$REPO' && '$REFRESH' '$REPO'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"FF:"*"behind"* ]] || [[ "$output" == *"OK:"*"behind"* ]]
}

@test "skips a dirty worktree" {
  add_wt dirty
  echo "scratch" > "$REPO/.claude/worktrees/dirty/scratch.md"
  (cd "$REPO/.claude/worktrees/dirty" && git add scratch.md)
  run bash -c "cd '$REPO' && '$REFRESH' '$REPO'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP"*"dirty"* ]]
}
