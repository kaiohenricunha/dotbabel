#!/usr/bin/env bats
# Behavior tests for sync.sh — hermetic clone in a tmpdir.
# The tests copy sync.sh + bootstrap.sh into a throwaway clone so we never
# touch the real checkout.

load helpers

setup() {
  REPO=$(make_tmp_git_repo)
  export REPO
  # Drop in the scripts we're testing so `$0` resolution lands in $REPO.
  cp "$REPO_ROOT/sync.sh" "$REPO/sync.sh"
  cp "$REPO_ROOT/bootstrap.sh" "$REPO/bootstrap.sh"
  chmod +x "$REPO/sync.sh" "$REPO/bootstrap.sh"
  # Commit the copies so they're tracked — otherwise every `push` test sees
  # them as staged changes.
  (cd "$REPO" && git add sync.sh bootstrap.sh && git commit -q -m "seed scripts" && git push -q origin main 2>/dev/null || true)
  # A throwaway $HOME so bootstrap.sh invocations from `pull` don't clobber
  # the real ~/.claude/.
  HOME=$(make_tmp_home)
  export HOME
}

teardown() {
  [ -n "${REPO:-}" ] && [ -d "$REPO" ] && rm -rf "$REPO" "$REPO-bare.git"
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] && rm -rf "$HOME"
}

@test "status: reports working-tree changes" {
  (cd "$REPO" && echo new > new.md)
  run bash -c "cd '$REPO' && ./sync.sh status"
  [ "$status" -eq 0 ]
  [[ "$output" == *"new.md"* ]]
}

@test "push: no changes exits 0" {
  run bash -c "cd '$REPO' && ./sync.sh push"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no changes"* ]]
}

@test "push: secret-scan blocks a literal API key" {
  (cd "$REPO" && printf 'export API_KEY="AKIAIOSFODNN7EXAMPLE"\n' > secrets.env)
  run bash -c "cd '$REPO' && ./sync.sh push 2>&1"
  [ "$status" -ne 0 ]
  [[ "$output" == *"secret-scan"* ]] || [[ "$output" == *"POSSIBLE SECRET"* ]]
  # Working tree should be un-staged after abort.
  run bash -c "cd '$REPO' && git diff --cached --name-only"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "push: HARNESS_SYNC_SKIP_SECRET_SCAN=1 bypasses scan" {
  (cd "$REPO" && printf 'export API_KEY="AKIAIOSFODNN7EXAMPLE"\n' > secrets.env)
  run env HARNESS_SYNC_SKIP_SECRET_SCAN=1 bash -c "cd '$REPO' && ./sync.sh push 2>&1"
  # Even if push fails (no credential for origin), the commit + scan-skip path
  # should have proceeded. Accept any exit but verify the scan message is gone.
  [[ "$output" != *"POSSIBLE SECRET"* ]]
}

@test "unknown subcommand exits 64" {
  run bash -c "cd '$REPO' && ./sync.sh wat"
  [ "$status" -eq 64 ]
}
