#!/usr/bin/env bats

load helpers

QUALITY="node $REPO_ROOT/plugins/dotbabel/bin/dotbabel-quality.mjs"
UMBRELLA="node $REPO_ROOT/plugins/dotbabel/bin/dotbabel.mjs"

setup() {
  REPO=$(mktemp -d)
  printf '%s\n' '{"quality":{"enabled":false}}' > "$REPO/.dotbabel.json"
}

teardown() {
  rm -rf "$REPO"
}

@test "quality help lists the read-only and executing commands" {
  run $QUALITY --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"detect"* ]]
  [[ "$output" == *"check"* ]]
  [[ "$output" == *"baseline"* ]]
}

@test "disabled quality policy is visible and successful" {
  run $QUALITY check --repo "$REPO" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state": "disabled"'* ]]
}

@test "umbrella quality delegates to the standalone binary" {
  run $UMBRELLA quality explain --repo "$REPO" --rule size.file_loc --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"command": "explain"'* ]]
}
