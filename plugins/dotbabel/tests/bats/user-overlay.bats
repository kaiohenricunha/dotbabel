#!/usr/bin/env bats
# Hermetic-HOME tests for the user-scope rule-floor overlay (#228).
#
# These tests target `node plugins/dotbabel/bin/dotbabel-bootstrap.mjs`
# (the npm CLI), NOT bootstrap.sh. bootstrap.sh is the lightweight
# "TL;DR" entrypoint and intentionally stays symlink-based; the npm CLI
# adds overlay support.

load helpers

DOTBABEL_BOOTSTRAP="node $REPO_ROOT/plugins/dotbabel/bin/dotbabel-bootstrap.mjs"

setup() {
  export HOME
  HOME=$(make_tmp_home)
  export OVERLAY_TMP
  OVERLAY_TMP=$(mktemp -d)
  # Force bootstrap to look at OUR test overlay path, not the user's real one.
  export DOTBABEL_LOCAL_RULES="$OVERLAY_TMP/local-rules.md"
}

teardown() {
  unset DOTBABEL_LOCAL_RULES
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] && rm -rf "$HOME"
  [ -n "${OVERLAY_TMP:-}" ] && [ -d "$OVERLAY_TMP" ] && rm -rf "$OVERLAY_TMP"
}

@test "bootstrap creates ~/.claude/CLAUDE.md as a regular file with overlay markers when DOTBABEL_LOCAL_RULES points at a populated tmp file" {
  cat > "$DOTBABEL_LOCAL_RULES" <<'MD'
## My personal rules

- be terse
- be helpful
MD

  run $DOTBABEL_BOOTSTRAP --quiet
  [ "$status" -eq 0 ]
  [ -f "$HOME/.claude/CLAUDE.md" ]
  [ ! -L "$HOME/.claude/CLAUDE.md" ]
  grep -q "<!-- dotbabel:user-overlay:begin -->" "$HOME/.claude/CLAUDE.md"
  grep -q "<!-- dotbabel:user-overlay:end -->" "$HOME/.claude/CLAUDE.md"
  grep -q "be terse" "$HOME/.claude/CLAUDE.md"
  grep -q "be helpful" "$HOME/.claude/CLAUDE.md"
  ! grep -q "(no user overlay)" "$HOME/.claude/CLAUDE.md"
}

@test "bootstrap migrates a pre-2.7.0 symlink at ~/.claude/CLAUDE.md to a generated file (no data loss)" {
  # Pre-create a symlink in the hermetic HOME, mirroring the legacy install state.
  mkdir -p "$HOME/.claude"
  ln -s "/some/legacy/symlink/target" "$HOME/.claude/CLAUDE.md"
  [ -L "$HOME/.claude/CLAUDE.md" ]

  run $DOTBABEL_BOOTSTRAP --quiet
  [ "$status" -eq 0 ]
  [ -f "$HOME/.claude/CLAUDE.md" ]
  [ ! -L "$HOME/.claude/CLAUDE.md" ]
  grep -q "<!-- dotbabel:user-overlay:begin -->" "$HOME/.claude/CLAUDE.md"

  # Backup of the original symlink should exist.
  run bash -c "ls '$HOME/.claude/'CLAUDE.md.bak-*"
  [ "$status" -eq 0 ]
}

@test "bootstrap treats an empty local-rules.md as absent (placeholder in overlay block, no user content leaked)" {
  : > "$DOTBABEL_LOCAL_RULES"   # zero-byte file

  run $DOTBABEL_BOOTSTRAP --quiet
  [ "$status" -eq 0 ]
  grep -q "<!-- dotbabel:user-overlay:begin -->" "$HOME/.claude/CLAUDE.md"
  grep -q "(no user overlay)" "$HOME/.claude/CLAUDE.md"
}
