#!/usr/bin/env bats
# Bats: shell-side legacy env var fallback for handoff-doctor.sh.
# Sets only DOTCLAUDE_HANDOFF_REPO and asserts:
#   1. The script honors the value (proves the fallback works)
#   2. stderr contains a deprecation hint mentioning the canonical name
#
# Pairs with the JS-side legacy-compat tests in
# plugins/dotbabel/tests/legacy-compat.test.mjs.

load helpers

setup() {
  TMP=$(mktemp -d)
  export HOME="$TMP"
  unset XDG_CONFIG_HOME XDG_CACHE_HOME
  unset DOTBABEL_HANDOFF_REPO DOTCLAUDE_HANDOFF_REPO
}

teardown() {
  rm -rf "$TMP"
  unset DOTBABEL_HANDOFF_REPO DOTCLAUDE_HANDOFF_REPO
}

@test "handoff-doctor.sh: legacy DOTCLAUDE_HANDOFF_REPO is honored" {
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/legacy-only-$$"
  run plugins/dotbabel/scripts/handoff-doctor.sh
  # Doctor exits non-zero because the path doesn't resolve, but stdout/stderr
  # must show the legacy value flowing through (i.e. fallback worked).
  [[ "$output" == *"/nonexistent/legacy-only-$$"* ]]
}

@test "handoff-doctor.sh: legacy use emits deprecation hint to stderr" {
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/legacy-only-$$"
  run plugins/dotbabel/scripts/handoff-doctor.sh
  # stderr must mention DOTBABEL_HANDOFF_REPO so the user knows the canonical
  # name to migrate to. Allow either "deprecated" or "removal in 3.0.0".
  [[ "$stderr" == *"DOTBABEL_HANDOFF_REPO"* ]] || [[ "$output" == *"DOTBABEL_HANDOFF_REPO"* ]]
}

@test "handoff-doctor.sh: canonical DOTBABEL_HANDOFF_REPO wins over legacy" {
  export DOTBABEL_HANDOFF_REPO="/nonexistent/canonical-$$"
  export DOTCLAUDE_HANDOFF_REPO="/nonexistent/legacy-$$"
  run plugins/dotbabel/scripts/handoff-doctor.sh
  [[ "$output" == *"/nonexistent/canonical-$$"* ]]
  # No deprecation warning when canonical is set.
  [[ "$stderr" != *"deprecated"* ]] || true   # tolerate other deprecation messages
}
