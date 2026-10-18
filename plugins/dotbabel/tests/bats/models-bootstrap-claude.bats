#!/usr/bin/env bats
load helpers

setup() {
  BASELINE_SOURCE="${BATS_TEST_TMPDIR:?}/source"
  BASELINE_HOME="${BATS_TEST_TMPDIR:?}/home"
  BASELINE_DRIVER="${REPO_ROOT:?}/plugins/dotbabel/tests/fixtures/model-intelligence/claude-baseline-scenario.mjs"
  BASELINE_BOOT="${REPO_ROOT:?}/bootstrap.sh"
  mkdir -p "$BASELINE_HOME"
  node "$BASELINE_DRIVER" "$BASELINE_SOURCE" first
}

@test "bootstrap: replaces an agent copy that the manifest proves Dotbabel-owned and does not overwrite one that it cannot prove" {
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE" --projections --quiet
  [ "$status" -eq 0 ]
  grep -q 'first release' "$BASELINE_HOME/.claude/agents/example.md"
  node "$BASELINE_DRIVER" "$BASELINE_SOURCE" second
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE" --projections --quiet
  [ "$status" -eq 0 ]
  grep -q 'second release' "$BASELINE_HOME/.claude/agents/example.md"
  PERSONAL_HOME="${BATS_TEST_TMPDIR:?}/personal-home"
  mkdir -p "$PERSONAL_HOME/.claude/agents"
  printf 'my personal agent\n' > "$PERSONAL_HOME/.claude/agents/example.md"
  run env HOME="$PERSONAL_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE" --projections --quiet
  [ "$status" -eq 2 ]
  [ "$(cat "$PERSONAL_HOME/.claude/agents/example.md")" = 'my personal agent' ]
}

@test "bootstrap: a migrated skill is installed as a generated copy, not a symlink" {
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE" --projections --quiet
  [ "$status" -eq 0 ]
  [ -f "$BASELINE_HOME/.claude/skills/example-skill/SKILL.md" ]
  [ ! -L "$BASELINE_HOME/.claude/skills/example-skill" ]
  [ ! -L "$BASELINE_HOME/.claude/skills/example-skill/SKILL.md" ]
  run grep -Eq '^(dotbabel|model|effort):' "$BASELINE_HOME/.claude/skills/example-skill/SKILL.md"
  [ "$status" -eq 1 ]
  grep -q 'first release' "$BASELINE_HOME/.claude/skills/example-skill/SKILL.md"
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE" --quiet
  [ "$status" -eq 0 ]
  [ ! -L "$BASELINE_HOME/.claude/skills/example-skill" ]
  [ ! -L "$BASELINE_HOME/.claude/commands/example-command.md" ]
}

@test "bootstrap: rejects a missing source and an unavailable projection baseline" {
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source
  [ "$status" -eq 64 ]
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE/missing" --quiet
  [ "$status" -eq 2 ]
  mkdir -p "$BASELINE_SOURCE/empty"
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE/empty" --projections --quiet
  [ "$status" -eq 2 ]
  [ ! -e "$BASELINE_HOME/.claude/.dotbabel-projection.json" ]
}

@test "bootstrap: projection delegation preserves the other CLI home directories" {
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE" --projections --all --quiet
  [ "$status" -eq 0 ]
  [ -f "$BASELINE_HOME/.codex/skills/example-skill/SKILL.md" ]
  [ ! -e "$BASELINE_HOME/.claude/.codex" ]
}

@test "bootstrap: an occupied projection lock blocks ordinary shell installation" {
  mkdir -p "$BASELINE_HOME/.claude/.dotbabel-projection.lock"
  run env HOME="$BASELINE_HOME" bash "$BASELINE_BOOT" --source "$BASELINE_SOURCE" --quiet
  [ "$status" -eq 2 ]
  [ -d "$BASELINE_HOME/.claude/.dotbabel-projection.lock" ]
  [ ! -e "$BASELINE_HOME/.claude/commands/example-command.md" ]
}
