#!/usr/bin/env bats
load helpers
setup() {
  WORK="$BATS_TEST_TMPDIR/recommend"
  mkdir -p "$WORK"
  export XDG_CACHE_HOME="$WORK/cache"
  export XDG_CONFIG_HOME="$WORK/config"
  node "$REPO_ROOT/plugins/dotbabel/tests/fixtures/model-intelligence/seed-resolver-cache.mjs" "$WORK" valid
}
@test "models recommend: prints the invocation recipe and never writes a file" {
  before=$(find "$WORK" -type f -exec sha256sum {} \; | sort)
  run node "$REPO_ROOT/plugins/dotbabel/bin/dotbabel-models.mjs" recommend --requirement deep --runtime codex --repo-root "$WORK" --no-color
  [ "$status" -eq 0 ]
  [[ "$output" == *"Invocation: codex"* ]]
  [[ "$output" == *"opaque-cli-model"* ]]
  after=$(find "$WORK" -type f -exec sha256sum {} \; | sort)
  [ "$before" = "$after" ]
}
