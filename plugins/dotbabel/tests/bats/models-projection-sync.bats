#!/usr/bin/env bats
# Exercise the public sync/check APIs through independent shell-launched Node processes.
load helpers

setup() {
  PROJECTION_REPO="$BATS_TEST_TMPDIR/project"
  PROJECTION_DRIVER="$REPO_ROOT/plugins/dotbabel/tests/fixtures/model-intelligence/projection-sync-scenario.mjs"
  node "$PROJECTION_DRIVER" "$PROJECTION_REPO" setup
}

@test "project-sync: writes generated copies where a symlink fails ARCH-51 and check-project-sync reports drift after a manual edit" {
  run node "$PROJECTION_DRIVER" "$PROJECTION_REPO" sync
  [ "$status" -eq 0 ]
  [ -f "$PROJECTION_REPO/.codex/skills/example/SKILL.md" ]
  [ ! -L "$PROJECTION_REPO/.codex/skills/example/SKILL.md" ]
  run node "$PROJECTION_DRIVER" "$PROJECTION_REPO" check
  [ "$status" -eq 0 ]
  echo 'user edit' >> "$PROJECTION_REPO/.codex/skills/example/SKILL.md"
  run node "$PROJECTION_DRIVER" "$PROJECTION_REPO" check
  [ "$status" -eq 1 ]
  [[ "$output" == *'"actual":"user-drift"'* ]]
  run node "$PROJECTION_DRIVER" "$PROJECTION_REPO" sync
  [ "$status" -eq 1 ]
  [[ "$(tail -n 1 "$PROJECTION_REPO/.codex/skills/example/SKILL.md")" == 'user edit' ]]
}
