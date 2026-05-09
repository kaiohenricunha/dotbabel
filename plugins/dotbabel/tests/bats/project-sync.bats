#!/usr/bin/env bats
# Behavior tests for `dotbabel project-sync` — operates on a hermetic
# scratch repo (mktemp -d), never on the real working copy. The dotbabel
# bin is invoked via `node plugins/dotbabel/bin/dotbabel-project-sync.mjs`
# from REPO_ROOT.

load helpers

PSYNC="node $REPO_ROOT/plugins/dotbabel/bin/dotbabel-project-sync.mjs"
PCHECK="node $REPO_ROOT/plugins/dotbabel/bin/dotbabel-check-project-sync.mjs"
PINIT="node $REPO_ROOT/plugins/dotbabel/bin/dotbabel-project-init.mjs"

# Build a minimal consumer repo with markers, one command, one skill.
build_repo() {
  local dir="$1"
  cat > "$dir/CLAUDE.md" <<'MD'
# Project rules

<!-- dotbabel:rule-floor:begin -->
- be terse
- be helpful
<!-- dotbabel:rule-floor:end -->
MD
  mkdir -p "$dir/.claude/commands" "$dir/.claude/skills/deploy"
  echo "# /commit" > "$dir/.claude/commands/commit.md"
  cat > "$dir/.claude/skills/deploy/SKILL.md" <<'MD'
---
name: deploy
---
# deploy
MD
}

setup() {
  REPO=$(mktemp -d)
  build_repo "$REPO"
}

teardown() {
  [ -n "${REPO:-}" ] && [ -d "$REPO" ] && rm -rf "$REPO"
}

@test "project-sync --help exits 0 and lists --dry-run" {
  run $PSYNC --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--dry-run"* ]]
  [[ "$output" == *"--repo"* ]]
}

@test "project-sync writes AGENTS.md, GEMINI.md, copilot-instructions.md" {
  run $PSYNC --repo "$REPO" --all
  [ "$status" -eq 0 ]
  [ -f "$REPO/AGENTS.md" ]
  [ -f "$REPO/GEMINI.md" ]
  [ -f "$REPO/.github/copilot-instructions.md" ]
  grep -q "be terse" "$REPO/AGENTS.md"
}

@test "project-sync creates Codex symlinks at .codex/skills" {
  run $PSYNC --repo "$REPO" --all
  [ "$status" -eq 0 ]
  [ -L "$REPO/.codex/skills/deploy" ]
  [ -L "$REPO/.codex/skills/commit/SKILL.md" ]
  resolved=$(readlink -f "$REPO/.codex/skills/commit/SKILL.md")
  [ "$resolved" = "$REPO/.claude/commands/commit.md" ]
}

@test "project-sync creates Gemini symlinks at .gemini/skills" {
  run $PSYNC --repo "$REPO" --all
  [ "$status" -eq 0 ]
  [ -L "$REPO/.gemini/skills/deploy" ]
  [ -L "$REPO/.gemini/skills/commit/SKILL.md" ]
}

@test "project-sync creates Copilot prompts and instructions" {
  run $PSYNC --repo "$REPO" --all
  [ "$status" -eq 0 ]
  [ -L "$REPO/.github/prompts/commit.prompt.md" ]
  [ -L "$REPO/.github/instructions/deploy.instructions.md" ]
  resolved=$(readlink -f "$REPO/.github/prompts/commit.prompt.md")
  [ "$resolved" = "$REPO/.claude/commands/commit.md" ]
}

@test "project-sync --dry-run does not mutate the filesystem" {
  run $PSYNC --repo "$REPO" --all --dry-run
  [ "$status" -eq 0 ]
  [ ! -e "$REPO/AGENTS.md" ]
  [ ! -e "$REPO/.codex" ]
  [ ! -e "$REPO/.github/prompts" ]
}

@test "project-sync is idempotent" {
  $PSYNC --repo "$REPO" --all >/dev/null
  run $PSYNC --repo "$REPO" --all
  [ "$status" -eq 0 ]
  # No new backup files should appear on the second run.
  run bash -c "ls '$REPO/.codex/skills/'*.bak-* 2>/dev/null || true"
  [ -z "$output" ]
}

@test "check-project-sync exit 0 after sync" {
  $PSYNC --repo "$REPO" --all >/dev/null
  run $PCHECK --repo "$REPO"
  [ "$status" -eq 0 ]
}

@test "check-project-sync exit 1 when a symlink is unlinked" {
  $PSYNC --repo "$REPO" --all >/dev/null
  unlink "$REPO/.codex/skills/commit/SKILL.md"
  # Source must remain untouched.
  [ -f "$REPO/.claude/commands/commit.md" ]
  run $PCHECK --repo "$REPO"
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing"* ]]
}

@test "project-init scaffolds .dotbabel.json and starter CLAUDE.md" {
  EMPTY=$(mktemp -d)
  run $PINIT --repo "$EMPTY"
  [ "$status" -eq 0 ]
  [ -f "$EMPTY/.dotbabel.json" ]
  [ -f "$EMPTY/CLAUDE.md" ]
  [ -f "$EMPTY/.claude/commands/.gitkeep" ]
  [ -f "$EMPTY/.claude/skills/.gitkeep" ]
  grep -q "dotbabel:rule-floor:begin" "$EMPTY/CLAUDE.md"
  rm -rf "$EMPTY"
}

@test "project-init refuses to overwrite .dotbabel.json without --force (exit 1)" {
  echo '{"already":"here"}' > "$REPO/.dotbabel.json"
  run $PINIT --repo "$REPO"
  [ "$status" -eq 1 ]
}

@test "project-init --force overwrites .dotbabel.json" {
  echo '{"already":"here"}' > "$REPO/.dotbabel.json"
  run $PINIT --repo "$REPO" --force
  [ "$status" -eq 0 ]
  grep -q '"rule_floor_source"' "$REPO/.dotbabel.json"
}

@test "convention path: marker-less CLAUDE.md still produces AGENTS.md" {
  PLAIN=$(mktemp -d)
  echo "# minimal" > "$PLAIN/CLAUDE.md"
  echo "be kind" >> "$PLAIN/CLAUDE.md"
  mkdir -p "$PLAIN/.claude/commands"
  echo "# /bar" > "$PLAIN/.claude/commands/bar.md"

  run $PSYNC --repo "$PLAIN" --all
  [ "$status" -eq 0 ]
  grep -q "be kind" "$PLAIN/AGENTS.md"
  [ -L "$PLAIN/.codex/skills/bar/SKILL.md" ]
  rm -rf "$PLAIN"
}

@test "symlink targets stored as relative paths, not absolute (issue #218)" {
  $PSYNC --repo "$REPO" --all >/dev/null
  target=$(readlink "$REPO/.codex/skills/commit/SKILL.md")
  case "$target" in
    /*) echo "BUG: target is absolute: $target" >&2; return 1 ;;
    *)  : ;;
  esac
  prompt_target=$(readlink "$REPO/.github/prompts/commit.prompt.md")
  case "$prompt_target" in
    /*) echo "BUG: copilot prompt target is absolute: $prompt_target" >&2; return 1 ;;
    *)  : ;;
  esac
}

@test "symlinks survive a repo rename (regression #218)" {
  $PSYNC --repo "$REPO" --all >/dev/null
  RENAMED="${REPO}-renamed"
  mv "$REPO" "$RENAMED"
  REPO="$RENAMED"  # so teardown removes the renamed dir

  [ -L "$RENAMED/.codex/skills/commit/SKILL.md" ]
  resolved=$(readlink -f "$RENAMED/.codex/skills/commit/SKILL.md")
  [ "$resolved" = "$RENAMED/.claude/commands/commit.md" ]

  [ -L "$RENAMED/.github/prompts/commit.prompt.md" ]
  resolved=$(readlink -f "$RENAMED/.github/prompts/commit.prompt.md")
  [ "$resolved" = "$RENAMED/.claude/commands/commit.md" ]

  run $PCHECK --repo "$RENAMED"
  [ "$status" -eq 0 ]
}
