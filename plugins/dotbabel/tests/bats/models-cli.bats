#!/usr/bin/env bats

load helpers

setup() {
  WORK=$(mktemp -d)
  export XDG_CACHE_HOME="$WORK/cache"
  export XDG_CONFIG_HOME="$WORK/config"
  export HOME="$WORK/home"
  mkdir -p "$HOME"
  PROJECT="$WORK/project"
  mkdir -p "$PROJECT"
  git init --quiet "$PROJECT"
  UMBRELLA="$REPO_ROOT/plugins/dotbabel/bin/dotbabel.mjs"
  SEED="$REPO_ROOT/plugins/dotbabel/tests/fixtures/model-intelligence/seed-resolver-cache.mjs"
  isolate_path
}

teardown() {
  rm_stub_path
  rm -rf "$WORK"
}

@test "models-cli: an unknown runtime id exits 64 through the dotbabel models umbrella" {
  run "$REAL_NODE" "$UMBRELLA" models resolve --requirement deep --runtime no-such-runtime --repo-root "$PROJECT"
  [ "$status" -eq 64 ]
}

@test "models-cli: a resolver conflict exits 1 through the dotbabel models umbrella" {
  "$REAL_NODE" "$SEED" "$PROJECT" conflict
  run "$REAL_NODE" "$UMBRELLA" models resolve --requirement deep --runtime codex --repo-root "$PROJECT" --json
  [ "$status" -eq 1 ]
  [[ "$output" == *'"status": "conflict"'* ]]
}
