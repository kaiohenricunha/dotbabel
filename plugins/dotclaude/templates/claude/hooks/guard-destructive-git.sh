#!/usr/bin/env bash
# PreToolUse hook: block destructive git operations.
# Reads JSON from stdin (Claude Code hook protocol).
# Exit 2 = block the tool call (Claude Code hook protocol — NOT the harness
# validator exit convention). Exit 0 = allow.
#
# Bypass: set BYPASS_DESTRUCTIVE_GIT=1 in the command's environment when you
# genuinely need to run a destructive git invocation. Use sparingly — the
# block exists because these operations are silently destructive.

# Fail open if jq is not installed (don't break all Bash tool calls).
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

if [ "${BYPASS_DESTRUCTIVE_GIT:-0}" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
NORM=$(printf '%s' "$CMD" | tr '\t' ' ' | tr -s ' ')

BOUNDARY='(^|[[:space:];&|])'
G='git[[:space:]]+'

PATTERNS=(
  "${BOUNDARY}${G}reset[[:space:]]+--hard(\b|[[:space:]]|$)"
  "${BOUNDARY}${G}push[[:space:]][^&;|]*(-f|--force|--force-with-lease)(\b|=|[[:space:]]|$)"
  "${BOUNDARY}${G}clean[[:space:]][^&;|]*(-[a-zA-Z]*f[a-zA-Z]*|--force)(\b|=|[[:space:]]|$)"
  "${BOUNDARY}${G}checkout[[:space:]]+\.(\b|$)"
  "${BOUNDARY}${G}restore[[:space:]]+\.(\b|$)"
  "${BOUNDARY}${G}branch[[:space:]]+-D\b"
  "${BOUNDARY}${G}worktree[[:space:]]+remove[[:space:]]+--force\b"
)

for rx in "${PATTERNS[@]}"; do
  if printf '%s' "$NORM" | grep -qE "$rx"; then
    {
      echo "BLOCKED: Destructive git operation detected. Get explicit user confirmation first."
      echo "         Bypass (only with user confirmation): BYPASS_DESTRUCTIVE_GIT=1 <your command>"
    } >&2
    exit 2
  fi
done

exit 0
