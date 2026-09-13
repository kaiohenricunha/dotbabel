#!/usr/bin/env bash
# PreToolUse hook: block destructive git operations.
# Reads JSON from stdin (Claude Code hook protocol).
# Exit 2 = block the tool call (Claude Code hook protocol — NOT the harness
# validator exit convention). Exit 0 = allow.
#
# Bypass, only after the user confirms the destructive call:
#   - Per call: write BYPASS_DESTRUCTIVE_GIT=1 directly before that git call, as
#     in `BYPASS_DESTRUCTIVE_GIT=1 git branch -D old-branch`. It covers only
#     that call; another destructive git call in the same command still blocks.
#     A tool call cannot set this hook's own environment, so the prefix is the
#     only bypass an agent can act on.
#   - Session: BYPASS_DESTRUCTIVE_GIT=1 in the hook's own environment (exported
#     before Claude Code starts) disables the guard for every call.
# Use sparingly — the block exists because these operations are silently
# destructive.

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
# Normalize whitespace: tabs -> space, collapse runs of whitespace so regex
# anchors only have to reason about single spaces.
NORM=$(printf '%s' "$CMD" | tr '\t' ' ' | tr -s ' ')

# Boundary before the `git` token is one of: start-of-line, whitespace, or a
# command-chaining separator (`;`, `&&`, `||`, `|`). This prevents false
# positives like `echo git` inside a quoted string while still catching
# `foo && git reset --hard`.
BOUNDARY='(^|[[:space:];&|])'

# The git token, optionally called by path (`/usr/bin/git`), followed by any
# global options before the verb. git accepts `-C <dir>`, `-c <key=value>`,
# `--opt=<value>`, `--git-dir <path>`-style pairs, and bare flags such as
# `--no-pager` in that position, so matching only `git <verb>` let every one of
# those spellings through. An option value may be quoted to hold spaces.
ARG="(\"[^\"]*\"|'[^']*'|[^[:space:];&|\"']+)"
GIT_OPT="(-[Cc][[:space:]]+${ARG}|--(git-dir|work-tree|namespace|config-env|super-prefix)[[:space:]]+${ARG}|--[a-z][a-z-]*(=${ARG})?|-[pP])"
GIT_PATH="([^[:space:];&|\"']*/)?"
G="${GIT_PATH}git([[:space:]]+${GIT_OPT})*[[:space:]]+"

# Per-call bypass: rewrite each git token that BYPASS_DESTRUCTIVE_GIT=1 directly
# prefixes (other VAR=value assignments may sit around it) to a placeholder the
# patterns cannot match. Only that one call is exempt; every other git call in
# the command is still checked. Capture groups: 1 boundary, 2 and 3 assignment
# runs, 4 path, 5 the whitespace after `git`.
ASSIGN='[A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*[[:space:]]+'
BYPASSED="${BOUNDARY}(${ASSIGN})*BYPASS_DESTRUCTIVE_GIT=1[[:space:]]+(${ASSIGN})*${GIT_PATH}git([[:space:]])"
SCAN=$(printf '%s' "$NORM" | sed -E "s#${BYPASSED}#\\1__bypassed_git__\\5#g")

# Destructive verbs. Each alternative is anchored on the right by at least one
# flag/keyword that makes the call unambiguously destructive.
PATTERNS=(
  "${BOUNDARY}${G}reset[[:space:]]+--hard(\b|[[:space:]]|$)"
  "${BOUNDARY}${G}push[[:space:]][^&;|]*(-f|--force|--force-with-lease)(\b|=|[[:space:]]|$)"
  "${BOUNDARY}${G}clean[[:space:]][^&;|]*(-[a-zA-Z]*f[a-zA-Z]*|--force)(\b|=|[[:space:]]|$)"
  # One pattern for both verbs, and the dot must TERMINATE the pathspec.
  #
  # The previous form ended in `\.(\b|$)`. The `$` correctly caught a trailing
  # bare dot, but the `\b` also matched a DOTFILE pathspec -- dot -> letter is
  # a word boundary -- so restoring a single ignore or config file was blocked
  # as if it were a wholesale discard. That false positive is the bug fixed
  # here; it trains people to work around the guard, which is worse than not
  # having one.
  #
  # A downstream copy that kept only the `\b` and dropped the `$` additionally
  # failed OPEN on a trailing bare dot, since `\b` cannot match after a
  # non-word character at end-of-string. Requiring the dot to terminate the
  # pathspec removes both failure modes.
  #
  # `(--[[:space:]]+)?` also covers an explicit end-of-options separator before
  # the pathspec, and `(/)?` the trailing-slash spelling.
  #
  # Test with /usr/bin/grep. A shell aliased to ugrep mis-compiles `(\b|$)` as
  # an empty sub-expression and reports NO match, so a broken pattern reads as
  # a passing one.
  "${BOUNDARY}${G}(checkout|restore)[[:space:]]+(--[[:space:]]+)?\.(/)?([[:space:]]|$)"
  "${BOUNDARY}${G}branch[[:space:]]+-D\b"
  "${BOUNDARY}${G}worktree[[:space:]]+remove[[:space:]]+--force\b"
)

for rx in "${PATTERNS[@]}"; do
  if printf '%s' "$SCAN" | grep -qE "$rx"; then
    {
      echo "BLOCKED: Destructive git operation detected. Get explicit user confirmation first."
      echo "         Bypass (only with user confirmation): run that one call as BYPASS_DESTRUCTIVE_GIT=1 git <args>"
    } >&2
    exit 2
  fi
done

exit 0
