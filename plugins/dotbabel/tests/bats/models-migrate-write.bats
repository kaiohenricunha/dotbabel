#!/usr/bin/env bats
load helpers
@test "models migrate --write: a batch passes index --check, validate-skills, build-plugin --check, and check-project-sync" {
  run node "$REPO_ROOT/plugins/dotbabel/tests/fixtures/model-intelligence/migration-repository.mjs" "$REPO_ROOT" "$BATS_TEST_TMPDIR/migration-repository"
  if [ "$status" -ne 0 ]; then printf '%s\n' "$output" >&2; fi
  [ "$status" -eq 0 ]
  [[ "$output" == *"Migration batch passes all four actual repository checks."* ]]
}
