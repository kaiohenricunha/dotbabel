#!/usr/bin/env bats
# vocabulary-denylist.bats — ensure no project-specific vocabulary from
# the dotclaude maintainer's private projects leaks into the generic
# bootstrap surface or scaffolding templates.
#
# Denylist — strings with zero legitimate generic use here:
#
#   squadranks           maintainer's private project name
#   wc-squad-rankings    private sub-project slug
#   squad ratings        domain phrase from that project
#   calibration/rankings compound path from the squadranks data gate
#
# Surfaces scanned:
#   1. CLAUDE.md              symlinked into every consumer's ~/.claude/
#   2. .claude/commands/      symlinked into every consumer's ~/.claude/
#   3. skills/                symlinked into every consumer's ~/.claude/
#   4. plugins/.../templates/ written verbatim into consumer repos
#   5. plugins/.../src/       npm package source (mjs files)

load helpers

# grep exits 0 when matches are found (bad), 1 when none found (good),
# 2 on error (also bad). Use `run grep` + `[ "$status" -eq 1 ]` so that
# both a positive match (exit 0) and a scan error (exit 2, e.g. missing
# path) cause the test to fail rather than silently pass.

DENYLIST_OPTS=(
  -e "squadranks"
  -e "wc-squad-rankings"
  -e "squad ratings"
  -e "calibration/rankings"
)

@test "CLAUDE.md contains no project-specific vocabulary" {
  run grep -ni "${DENYLIST_OPTS[@]}" \
    "$REPO_ROOT/CLAUDE.md"
  [ "$status" -eq 1 ]
}

@test "bootstrap commands contain no project-specific vocabulary" {
  run grep -rni "${DENYLIST_OPTS[@]}" \
    --include="*.md" \
    "$REPO_ROOT/.claude/commands/"
  [ "$status" -eq 1 ]
}

@test "bootstrap skills contain no project-specific vocabulary" {
  run grep -rni "${DENYLIST_OPTS[@]}" \
    --include="*.md" --include="*.yaml" --include="*.yml" \
    "$REPO_ROOT/skills/"
  [ "$status" -eq 1 ]
}

@test "scaffolding templates contain no project-specific vocabulary" {
  run grep -rni "${DENYLIST_OPTS[@]}" \
    --include="*.md" --include="*.json" --include="*.sh" \
    "$REPO_ROOT/plugins/dotclaude/templates/"
  [ "$status" -eq 1 ]
}

@test "plugin source mjs files contain no project-specific vocabulary" {
  run grep -rni "${DENYLIST_OPTS[@]}" \
    --include="*.mjs" \
    "$REPO_ROOT/plugins/dotclaude/src/"
  [ "$status" -eq 1 ]
}

@test "plugin bin files contain no project-specific vocabulary" {
  run grep -rni "${DENYLIST_OPTS[@]}" \
    --include="*.mjs" --include="*.sh" \
    "$REPO_ROOT/plugins/dotclaude/bin/"
  [ "$status" -eq 1 ]
}

@test "plugin scripts contain no project-specific vocabulary" {
  run grep -rni "${DENYLIST_OPTS[@]}" \
    --include="*.sh" --include="*.mjs" \
    "$REPO_ROOT/plugins/dotclaude/scripts/"
  [ "$status" -eq 1 ]
}
