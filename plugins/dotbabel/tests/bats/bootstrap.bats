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
