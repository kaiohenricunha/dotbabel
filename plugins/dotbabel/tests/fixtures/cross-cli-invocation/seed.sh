#!/usr/bin/env bash
# Seed deterministic per-CLI session trees for the cross-CLI invocation
# symmetry harness. Mirrors the F-2 fixture pattern from
# plugins/dotclaude/tests/bats/handoff-pull-local-emit.bats but locks every
# input that influences the rendered <handoff> / --summary output:
#
#   - JSONL contents (cwd, sessionId)
#   - File mtime (consumed by --summary as the rendered timestamp)
#
# Usage:
#   seed.sh <target-home>
#
# Seeding only requires <target-home>. For the LATER `dotclaude handoff pull`
# invocation against the seeded tree, the caller should export
# DOTCLAUDE_HANDOFF_REPO=/nonexistent and DOTCLAUDE_QUIET=1 so pull stays
# local-only and quiet — but those vars are not consumed by this script.
set -euo pipefail

target_home="${1:?usage: seed.sh <target-home>}"

# Pin-stable UUIDs. Distinct enough from the bats fixture UUIDs to avoid any
# accidental cross-suite collision. Short-IDs (first 8 chars) are what the
# resolver matches on.
CLAUDE_UUID="aaaa1111-2222-3333-4444-555555555555"
COPILOT_UUID="bbbb1111-2222-3333-4444-555555555555"
CODEX_UUID="cccc1111-2222-3333-4444-555555555555"

CLAUDE_CWD="/seed/claude"
COPILOT_CWD="/seed/copilot"
CODEX_CWD="/seed/codex"

# Fixed mtime keeps `--summary`'s timestamp byte-stable across regens.
# `touch -d <ISO>` is GNU-only; BSD/macOS need `touch -t <stamp>`. Probe both
# so maintainers can run regenerate-baseline.sh from either substrate.
FIXED_MTIME="2026-04-29T12:00:00Z"
FIXED_MTIME_TOUCH_T="202604291200.00"

set_fixed_mtime() {
  local path="${1:?usage: set_fixed_mtime <path>}"
  if touch -d "$FIXED_MTIME" "$path" 2>/dev/null; then
    return 0
  fi
  TZ=UTC touch -t "$FIXED_MTIME_TOUCH_T" "$path"
}

mkdir -p "$target_home/.claude/projects/-seed-claude"
printf '{"cwd":"%s","sessionId":"%s","version":"2.1"}\n' \
  "$CLAUDE_CWD" "$CLAUDE_UUID" \
  > "$target_home/.claude/projects/-seed-claude/$CLAUDE_UUID.jsonl"
set_fixed_mtime "$target_home/.claude/projects/-seed-claude/$CLAUDE_UUID.jsonl"

mkdir -p "$target_home/.copilot/session-state/$COPILOT_UUID"
printf '{"type":"session.start","data":{"cwd":"%s","model":"gpt","sessionId":"%s"}}\n' \
  "$COPILOT_CWD" "$COPILOT_UUID" \
  > "$target_home/.copilot/session-state/$COPILOT_UUID/events.jsonl"
set_fixed_mtime "$target_home/.copilot/session-state/$COPILOT_UUID/events.jsonl"

mkdir -p "$target_home/.codex/sessions/2026/04/29"
codex_path="$target_home/.codex/sessions/2026/04/29/rollout-2026-04-29T12-00-00-$CODEX_UUID.jsonl"
printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\n' \
  "$CODEX_UUID" "$CODEX_CWD" \
  > "$codex_path"
set_fixed_mtime "$codex_path"

# Print the short-ids so callers can compose invocation rows without
# re-hardcoding them. Stable under regeneration.
echo "CLAUDE_SHORT=${CLAUDE_UUID:0:8}"
echo "COPILOT_SHORT=${COPILOT_UUID:0:8}"
echo "CODEX_SHORT=${CODEX_UUID:0:8}"
