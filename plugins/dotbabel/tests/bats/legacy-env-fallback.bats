#!/usr/bin/env bats
# Bats: shell-side legacy env var fallback for handoff-doctor.sh.
#
# Asserts:
#   1. Setting only DOTCLAUDE_HANDOFF_REPO emits the deprecation warning
#      (proves the legacy fallback path is taken, with one-shot warning)
#   2. The error message references the canonical name DOTBABEL_HANDOFF_REPO
#      (so the user knows which to migrate to)
#   3. Setting DOTBABEL_HANDOFF_REPO suppresses the deprecation warning
#      even when DOTCLAUDE_HANDOFF_REPO is also set (canonical wins)
#
# Pairs with the JS-side legacy-compat tests in
# plugins/dotbabel/tests/legacy-compat.test.mjs.

setup() {
  TMP=$(mktemp -d)
  export HOME="$TMP"
  unset XDG_CONFIG_HOME XDG_CACHE_HOME
  unset DOTBABEL_HANDOFF_REPO DOTCLAUDE_HANDOFF_REPO
  DOCTOR=plugins/dotbabel/scripts/handoff-doctor.sh
}

teardown() {
  rm -rf "$TMP"
  unset DOTBABEL_HANDOFF_REPO DOTCLAUDE_HANDOFF_REPO
}

@test "handoff-doctor.sh: legacy DOTCLAUDE_HANDOFF_REPO emits deprecation warning" {
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/legacy-only-$$"
  run bash "$DOCTOR"
  # Doctor exits 1 because the path is unreachable, but the warning must fire.
  [[ "$output" == *"DOTCLAUDE_HANDOFF_REPO is deprecated"* ]]
  [[ "$output" == *"DOTBABEL_HANDOFF_REPO"* ]]
  [[ "$output" == *"removal in 3.0.0"* ]]
}

@test "handoff-doctor.sh: error message references canonical DOTBABEL_HANDOFF_REPO" {
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/legacy-only-$$"
  run bash "$DOCTOR"
  # The "What's wrong" diagnosis line names the canonical var.
  [[ "$output" == *"\$DOTBABEL_HANDOFF_REPO"* ]]
}

@test "handoff-doctor.sh: canonical DOTBABEL_HANDOFF_REPO wins (no deprecation)" {
  export DOTBABEL_HANDOFF_REPO="/nonexistent/canonical-$$"
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/legacy-$$"
  run bash "$DOCTOR"
  # No deprecation warning when canonical is set.
  [[ "$output" != *"DOTCLAUDE_HANDOFF_REPO is deprecated"* ]]
}

@test "handoff-doctor.sh: unset (no info, ok exit) does not warn" {
  unset DOTBABEL_HANDOFF_REPO DOTCLAUDE_HANDOFF_REPO
  run bash "$DOCTOR"
  [ "$status" -eq 0 ]
  [[ "$output" != *"deprecated"* ]]
  [[ "$output" == *"is not set"* ]]
}
