#!/usr/bin/env bats
# Behavior tests for bootstrap.sh — hermetic $HOME under a tmpdir.

load helpers

BOOT="$REPO_ROOT/bootstrap.sh"

setup() {
  [ -x "$BOOT" ] || chmod +x "$BOOT"
  export HOME
  HOME=$(make_tmp_home)
  # Clear any inherited BASH_ENV sourced files.
  unset CLAUDE_HOME 2>/dev/null || true
}

teardown() {
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] && rm -rf "$HOME"
}

@test "first run: links CLAUDE.md + commands/ + skills/" {
  run "$BOOT"
  [ "$status" -eq 0 ]
  [ -L "$HOME/.claude/CLAUDE.md" ]
  # At least one command file was linked.
  run bash -c "ls -1 '$HOME/.claude/commands/'*.md | head -1"
  [ "$status" -eq 0 ]
}

@test "idempotent: second run reports 'ok:' for existing links" {
  "$BOOT" >/dev/null
  run "$BOOT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok:"* ]]
}

@test "backs up a real file before replacing with symlink" {
  echo "old content" > "$HOME/.claude/CLAUDE.md"
  run "$BOOT"
  [ "$status" -eq 0 ]
  [ -L "$HOME/.claude/CLAUDE.md" ]
  run bash -c "ls '$HOME/.claude/'CLAUDE.md.bak-*"
  [ "$status" -eq 0 ]
}

@test "repairs a broken symlink (pointing nowhere)" {
  ln -s "/does/not/exist" "$HOME/.claude/CLAUDE.md"
  run "$BOOT"
  [ "$status" -eq 0 ]
  [ -L "$HOME/.claude/CLAUDE.md" ]
  target=$(readlink "$HOME/.claude/CLAUDE.md")
  [ "$target" = "$REPO_ROOT/CLAUDE.md" ]
}

@test "updates a stale symlink (pointing to a different path)" {
  ln -s "/tmp/stale-target" "$HOME/.claude/CLAUDE.md"
  run "$BOOT"
  [ "$status" -eq 0 ]
  target=$(readlink "$HOME/.claude/CLAUDE.md")
  [ "$target" = "$REPO_ROOT/CLAUDE.md" ]
}

@test "--quiet suppresses per-file output" {
  run "$BOOT" --quiet
  [ "$status" -eq 0 ]
  [[ "$output" != *"  ok:"* ]]
  [[ "$output" != *"  linked:"* ]]
  [[ "$output" == *"bootstrap complete"* ]]
}

@test "--help prints usage and exits 0" {
  run "$BOOT" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"bootstrap.sh"* ]]
  [[ "$output" == *"--quiet"* ]]
}

@test "rejects unknown argument with exit 64" {
  run "$BOOT" --bogus
  [ "$status" -eq 64 ]
}

@test "codex command fan-out backs up existing wrapper file" {
  mkdir -p "$HOME/.codex/skills"
  echo "old wrapper" > "$HOME/.codex/skills/changelog"

  run "$BOOT" --all --quiet
  [ "$status" -eq 0 ]
  [ -d "$HOME/.codex/skills/changelog" ]
  [ -L "$HOME/.codex/skills/changelog/SKILL.md" ]
  target=$(readlink "$HOME/.codex/skills/changelog/SKILL.md")
  [ "$target" = "$REPO_ROOT/commands/changelog.md" ]

  run bash -c "ls '$HOME/.codex/skills/'changelog.bak-*"
  [ "$status" -eq 0 ]
}

@test "gemini command fan-out backs up existing wrapper file" {
  mkdir -p "$HOME/.gemini/skills"
  echo "old wrapper" > "$HOME/.gemini/skills/changelog"

  run "$BOOT" --all --quiet
  [ "$status" -eq 0 ]
  [ -d "$HOME/.gemini/skills/changelog" ]
  [ -L "$HOME/.gemini/skills/changelog/SKILL.md" ]
  target=$(readlink "$HOME/.gemini/skills/changelog/SKILL.md")
  [ "$target" = "$REPO_ROOT/commands/changelog.md" ]

  run bash -c "ls '$HOME/.gemini/skills/'changelog.bak-*"
  [ "$status" -eq 0 ]
}

@test "gemini fan-out honors GEMINI_HOME" {
  GEMINI_HOME="$HOME/custom-gemini"
  export GEMINI_HOME

  run "$BOOT" --all --quiet
  [ "$status" -eq 0 ]
  [ -L "$GEMINI_HOME/skills/changelog/SKILL.md" ]
  target=$(readlink "$GEMINI_HOME/skills/changelog/SKILL.md")
  [ "$target" = "$REPO_ROOT/commands/changelog.md" ]

  # Default $HOME/.gemini/skills must NOT be populated when override is set.
  [ ! -e "$HOME/.gemini/skills/changelog/SKILL.md" ]

  unset GEMINI_HOME
}

@test "codex fan-out skipped when codex not on PATH and --all not passed" {
  # Strip nvm bin (which carries `codex`) and any other dirs that might
  # leak the binary; keep only the system minimums git/jq/bash need.
  local sanitized_path="/usr/bin:/bin"
  if PATH="$sanitized_path" command -v codex >/dev/null 2>&1; then
    skip "codex unexpectedly on sanitized PATH ($sanitized_path); cannot exercise the absent-binary path"
  fi

  run env -i HOME="$HOME" PATH="$sanitized_path" "$BOOT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping codex"* ]]
  # No fan-out happened: zero SKILL.md symlinks under ~/.codex/skills/.
  run bash -c "find '$HOME/.codex/skills' -name SKILL.md -type l 2>/dev/null | wc -l"
  [ "$output" = "0" ]
}

@test "fan-out is idempotent — second run produces no new .bak-* files" {
  # Pre-seed a real wrapper file so the first run actually creates a backup.
  # Without this, both counts are 0 and the equality is trivially satisfied —
  # a regression that spawned a stray .bak-* on the second run could still
  # slip through.
  mkdir -p "$HOME/.codex/skills"
  echo "old wrapper" > "$HOME/.codex/skills/changelog"

  "$BOOT" --all --quiet
  local count_after_first
  count_after_first=$(find "$HOME/.codex/skills" -name '*.bak-*' 2>/dev/null | wc -l)
  [ "$count_after_first" -gt 0 ]

  "$BOOT" --all --quiet
  local count_after_second
  count_after_second=$(find "$HOME/.codex/skills" -name '*.bak-*' 2>/dev/null | wc -l)
  [ "$count_after_first" -eq "$count_after_second" ]
}

@test "CODEX_HOME override populates custom path" {
  export CODEX_HOME="$HOME/custom-codex"
  run "$BOOT" --all --quiet
  [ "$status" -eq 0 ]
  [ -L "$CODEX_HOME/skills/changelog/SKILL.md" ]
  target=$(readlink "$CODEX_HOME/skills/changelog/SKILL.md")
  [ "$target" = "$REPO_ROOT/commands/changelog.md" ]
  # Default ~/.codex/skills/ must NOT have been populated.
  run bash -c "find '$HOME/.codex/skills' -name SKILL.md -type l 2>/dev/null | wc -l"
  [ "$output" = "0" ]
}
