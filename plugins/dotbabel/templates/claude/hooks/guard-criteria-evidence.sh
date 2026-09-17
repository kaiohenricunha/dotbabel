#!/usr/bin/env bash
# PreToolUse hook: block an agent from hand-writing a criteria evidence marker.
# Reads JSON from stdin (Claude Code hook protocol).
# Exit 2 = block the tool call (Claude Code hook protocol — NOT the harness
# validator exit convention). Exit 0 = allow.
#
# Why this exists: the merge gate believes a comment whose first line carries
# `<!-- dotbabel-criteria verified-sha=<sha> -->` and whose author association
# is trusted. An agent driving `gh` IS a trusted author, and the gate cannot
# tell a marker the tool wrote from one an agent typed — the bytes are
# identical. The distinction only exists at the moment the command is issued,
# so that is where it has to be enforced. Without this hook, "post the evidence
# comment" is a thing an agent can do directly, and the whole evidence chain
# reduces to the agent's own say-so.
#
# The sanctioned writer is `dotbabel criteria verify --pr <N> --post`, which
# runs the criteria and derives the marker from what actually happened. That
# path is allowed below.
#
# Bypass, only after the user confirms:
#   - Per call: BYPASS_CRITERIA_EVIDENCE_GUARD=1 directly before the command.
#   - Session: the same variable exported before Claude Code starts.
# A tool call cannot set this hook's own environment, so the prefix is the only
# bypass an agent can act on.

# Fail open if jq is not installed (don't break all Bash tool calls).
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

if [ "${BYPASS_CRITERIA_EVIDENCE_GUARD:-0}" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
# Join backslash-newline continuations first: the patterns below work one line
# at a time, so a call split across lines would otherwise show each half alone.
CMD=${CMD//$'\\\n'/ }
NORM=$(printf '%s' "$CMD" | tr '\t' ' ' | tr -s ' ')

# The sanctioned writer runs the criteria and derives the marker from the run.
# Allow it before looking for the marker at all, since its own `--post` output
# legitimately contains one.
#
# Match an INVOCATION, not the bare token: the marker text itself begins
# `dotbabel-criteria verified-sha=`, so a loose `dotbabel[- ]criteria` pattern
# lets the marker whitelist itself and the guard never fires. The bin always
# carries `.mjs`, and the subcommand form is space-separated followed by a
# real subcommand.
if printf '%s' "$NORM" | grep -qE '(^|[[:space:];&|(`])(node[[:space:]]+)?[^[:space:]]*dotbabel-criteria\.mjs([[:space:]]|$)'; then
  exit 0
fi
if printf '%s' "$NORM" | grep -qE '(^|[[:space:];&|(`])dotbabel[[:space:]]+criteria[[:space:]]+(verify|list)([[:space:]]|$)'; then
  exit 0
fi

# Anything else that carries the marker text is an agent writing evidence by
# hand. Matching the marker itself rather than a command shape keeps this
# robust across `gh pr comment`, `gh api`, `--body-file`, and a heredoc.
if printf '%s' "$NORM" | grep -qF 'dotbabel-criteria verified-sha='; then
  cat >&2 <<'MSG'
BLOCKED: this command writes a dotbabel-criteria evidence marker by hand.

The merge gate trusts that marker because the tool derived it from a real
criteria run. A hand-written one is indistinguishable to the gate, so writing
it directly turns machine-checked evidence into an assertion.

Post evidence with the sanctioned writer instead:

  dotbabel criteria verify --pr <N> --post

If you genuinely need to bypass this (the user must confirm first), prefix the
call: BYPASS_CRITERIA_EVIDENCE_GUARD=1 <command>
MSG
  exit 2
fi

exit 0
