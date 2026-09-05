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
  # project-init --trust writes to a user-scope allowlist. Point it at a temp
  # file so the suite can never append to the developer's real ~/.config.
  TRUST_DIR=$(mktemp -d)
  TRUST_FILE="$TRUST_DIR/trusted"
  export CHECK_ON_STOP_TRUSTED_FILE="$TRUST_FILE"
}

teardown() {
  [ -n "${REPO:-}" ] && [ -d "$REPO" ] && rm -rf "$REPO"
  [ -n "${TRUST_DIR:-}" ] && [ -d "$TRUST_DIR" ] && rm -rf "$TRUST_DIR"
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

@test "project-sync creates Copilot prompts and instructions as generated files, not symlinks" {
  run $PSYNC --repo "$REPO" --all
  [ "$status" -eq 0 ]
  [ -f "$REPO/.github/prompts/commit.prompt.md" ]
  [ ! -L "$REPO/.github/prompts/commit.prompt.md" ]
  [ -f "$REPO/.github/instructions/deploy.instructions.md" ]
  [ ! -L "$REPO/.github/instructions/deploy.instructions.md" ]
  grep -q "# dotbabel:generated" "$REPO/.github/prompts/commit.prompt.md"
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
  run $PCHECK --repo "$REPO" --all
  [ "$status" -eq 0 ]
}

@test "check-project-sync exit 1 when a symlink is unlinked" {
  $PSYNC --repo "$REPO" --all >/dev/null
  unlink "$REPO/.codex/skills/commit/SKILL.md"
  # Source must remain untouched.
  [ -f "$REPO/.claude/commands/commit.md" ]
  run $PCHECK --repo "$REPO" --all
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing"* ]]
}

# Without --all the checker honors gate_on_cli_presence, so a CLI that is not
# installed is reported as skipped rather than as drift (#219, finding D). A CI
# runner has none of the three CLIs, which is exactly the case that used to make
# this binary always exit 1.
@test "check-project-sync skips a CLI that is absent from PATH" {
  $PSYNC --repo "$REPO" --all >/dev/null
  unlink "$REPO/.codex/skills/commit/SKILL.md"
  # A PATH holding only sh and node: the CLIs are genuinely absent, but the
  # `command -v` probe and the checker itself still run.
  CLILESS_BIN=$(mktemp -d)
  ln -s "$(command -v sh)" "$CLILESS_BIN/sh"
  ln -s "$(command -v node)" "$CLILESS_BIN/node"
  run env PATH="$CLILESS_BIN" node "$REPO_ROOT/plugins/dotbabel/bin/dotbabel-check-project-sync.mjs" --repo "$REPO"
  rm -rf "$CLILESS_BIN"
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipped codex: not on PATH"* ]]
}

@test "check-project-sync rejects an unknown fan_out CLI" {
  printf '{"fan_out":["codex","co-pilot"]}\n' > "$REPO/.dotbabel.json"
  run $PCHECK --repo "$REPO"
  [ "$status" -eq 1 ]
  [[ "$output" == *"unknown fan_out CLI"* ]]
}

# fan_out_layout: shared — one canonical tree, a redirect per CLI (#219, C).
@test "shared layout: codex and gemini redirect to one .cli/skills tree" {
  printf '{"fan_out_layout":"shared"}\n' > "$REPO/.dotbabel.json"
  run $PSYNC --repo "$REPO" --all
  [ "$status" -eq 0 ]

  [ -L "$REPO/.codex/skills" ]
  [ -L "$REPO/.gemini/skills" ]
  [ -f "$REPO/.cli/skills/commit/SKILL.md" ]

  # The redirect resolves, and a command is readable through both hops.
  [ "$(readlink -f "$REPO/.codex/skills")" = "$(readlink -f "$REPO/.cli/skills")" ]
  run cat "$REPO/.codex/skills/commit/SKILL.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"/commit"* ]]

  run $PCHECK --repo "$REPO" --all
  [ "$status" -eq 0 ]
}

@test "shared layout: rejects an unknown fan_out_layout" {
  printf '{"fan_out_layout":"sideways"}\n' > "$REPO/.dotbabel.json"
  run $PSYNC --repo "$REPO" --all
  [ "$status" -eq 1 ]
  [[ "$output" == *"unknown fan_out_layout"* ]]
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

@test "project-init grants no trust without --trust" {
  # The regression that catches an accidental flip to default-on. A skill tells
  # an agent to run project-init, so a default grant would let a model hand a
  # repo turn-end code execution with no human deciding.
  EMPTY=$(mktemp -d)
  run $PINIT --repo "$EMPTY"
  [ "$status" -eq 0 ]
  [ ! -f "$TRUST_FILE" ]
  rm -rf "$EMPTY"
}

@test "project-init --trust records the resolved repo path" {
  EMPTY=$(mktemp -d)
  run $PINIT --repo "$EMPTY" --trust
  [ "$status" -eq 0 ]
  [[ "$output" == *"trust GRANTED"* ]]
  grep -Fxq "$(cd "$EMPTY" && pwd -P)" "$TRUST_FILE"
  rm -rf "$EMPTY"
}

@test "project-init --trust records the physical path for a symlinked repo" {
  # check-on-stop.sh compares `cd && pwd -P` output. Recording the symlink
  # would let the grant follow the link if it were ever repointed.
  REAL=$(mktemp -d)
  LINKDIR=$(mktemp -d)
  ln -s "$REAL" "$LINKDIR/alias"
  run $PINIT --repo "$LINKDIR/alias" --trust
  [ "$status" -eq 0 ]
  grep -Fxq "$(cd "$REAL" && pwd -P)" "$TRUST_FILE"
  rm -rf "$REAL" "$LINKDIR"
}

@test "project-init --trust is idempotent" {
  EMPTY=$(mktemp -d)
  run $PINIT --repo "$EMPTY" --trust
  run $PINIT --repo "$EMPTY" --trust --force
  [ "$status" -eq 0 ]
  [ "$(grep -Fxc "$(cd "$EMPTY" && pwd -P)" "$TRUST_FILE")" -eq 1 ]
  rm -rf "$EMPTY"
}

@test "project-init --trust --dry-run writes no trust entry" {
  EMPTY=$(mktemp -d)
  run $PINIT --repo "$EMPTY" --trust --dry-run
  [ "$status" -eq 0 ]
  [ ! -f "$TRUST_FILE" ]
  rm -rf "$EMPTY"
}

@test "project-init warns but still exits 0 when the trust file is unwritable" {
  # A failed secondary user-scope write must not fail a scaffold that already
  # wrote files into the repo.
  EMPTY=$(mktemp -d)
  BLOCKER=$(mktemp -d)/afile
  printf 'not a directory\n' > "$BLOCKER"
  run env CHECK_ON_STOP_TRUSTED_FILE="$BLOCKER/trusted" $PINIT --repo "$EMPTY" --trust
  [ "$status" -eq 0 ]
  [[ "$output" == *"trust NOT granted"* ]]
  [ -f "$EMPTY/.dotbabel.json" ]
  rm -rf "$EMPTY"
}

@test "project-init --help lists --trust" {
  run $PINIT --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"--trust"* ]]
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
  # Copilot targets are generated files, not symlinks (#324) — #218's
  # "relative target" premise does not apply to them.
  [ ! -L "$REPO/.github/prompts/commit.prompt.md" ]
}

@test "symlinks survive a repo rename (regression #218)" {
  $PSYNC --repo "$REPO" --all >/dev/null
  RENAMED="${REPO}-renamed"
  mv "$REPO" "$RENAMED"
  REPO="$RENAMED"  # so teardown removes the renamed dir

  [ -L "$RENAMED/.codex/skills/commit/SKILL.md" ]
  resolved=$(readlink -f "$RENAMED/.codex/skills/commit/SKILL.md")
  [ "$resolved" = "$RENAMED/.claude/commands/commit.md" ]

  # Copilot targets are generated files, not symlinks (#324): nothing to
  # resolve, but the content survives the rename untouched.
  [ -f "$RENAMED/.github/prompts/commit.prompt.md" ]
  grep -q "# dotbabel:generated" "$RENAMED/.github/prompts/commit.prompt.md"

  run $PCHECK --repo "$RENAMED"
  [ "$status" -eq 0 ]
}
