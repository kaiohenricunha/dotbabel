#!/bin/bash
# PreToolUse hook: block destructive git operations.
# Reads JSON from stdin (Claude Code hook protocol).
# Exit 2 = block the tool call. Exit 0 = allow.

# Fail open if jq is not installed (don't break all Bash tool calls)
if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')

if [ "$TOOL" = "Bash" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
  if echo "$CMD" | grep -qE 'git[[:space:]]+(reset[[:space:]]+--hard|push[[:space:]][^&;#]*[[:space:]]+(-f|--force|--force-with-lease)\b|clean[[:space:]][^&;#]*[[:space:]]+-f[dx]?\b|checkout[[:space:]]+\.\b|restore[[:space:]]+\.\b)'; then
    echo "BLOCKED: Destructive git operation detected. Get explicit user confirmation first." >&2
    exit 2
  fi

fi

exit 0
