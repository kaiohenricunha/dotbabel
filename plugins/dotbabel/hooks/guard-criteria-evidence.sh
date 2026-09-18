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
# so that is where it has to be enforced.
#
# THERE IS NO ALLOW-LIST, deliberately. The sanctioned writer,
# `dotbabel criteria verify --pr <N> --post`, does not carry the marker in its
# COMMAND TEXT — only in its output. So any command whose text contains the
# marker is writing it by hand, and needs no exception. An earlier revision did
# carry allow-rules and they were the whole vulnerability twice over: first the
# bare token `dotbabel-criteria` matched inside the marker itself, then, after
# that was narrowed to an invocation shape, merely MENTIONING the bin anywhere
# in the line still whitelisted it —
#   gh pr comment 1 --body '<!-- dotbabel-criteria verified-sha=… --> via dotbabel-criteria.mjs'
# — as did chaining a real invocation in front of a hand-written marker. A
# guard whose allow-rule the attacker controls is not a guard.
#
# SCOPE, stated plainly rather than overclaimed. This stops the marker reaching
# a comment through the command text or a `--body-file` this hook can read. It
# does NOT stop an agent that assembles the marker out of band — splitting it
# across shell variables, base64, a heredoc, or writing the body with the Write
# tool (which this PreToolUse matcher does not cover) and then posting it with
# `--body-file`. Those remain open by construction: no textual guard on one
# Bash call can close them.
#
# So treat this as a guardrail against the casual and accidental path, not as a
# security boundary. The durable fix is for the gate to stop trusting comment
# text at all — an unforgeable value derived from the run, or a check-run
# artifact the agent cannot author. See docs/hooks.md.
#
# Bypass: export BYPASS_CRITERIA_EVIDENCE_GUARD=1 in the environment Claude
# Code itself was started with, only after the user confirms. A `VAR=1 cmd`
# PREFIX DOES NOT WORK: the prefix is applied by the shell the Bash tool spawns
# later, while this hook runs earlier with Claude Code's own environment.

# `jq` is used only to read the tool payload. Do not fail open for the case
# this hook exists to catch: if jq is missing, fall back to scanning the raw
# stdin for the marker and refuse when it is there.
# Two marker families are gate-authoritative, so both are guarded.
# `dotbabel-criteria` evidence asserts a criterion result; a forged one turns a
# machine-checked verdict into an assertion. `local-attest` evidence is stronger
# still: the merge gate skips the full test suite AND the quality profile on it,
# so a forged one removes verification rather than misreporting it. The payload
# line is listed too — a marker without it is refused by the gate as INVALID, so
# guarding only the marker would leave the working forgery shape open.
MARKER='dotbabel-criteria verified-sha='
MARKERS=("$MARKER" 'local-attest verified-sha=' 'local-attest-payload ')

# True when any guarded marker appears in $1.
has_marker() {
  local hay=$1 m
  for m in "${MARKERS[@]}"; do
    [[ "$hay" == *"$m"* ]] && return 0
  done
  return 1
}

# True when any guarded marker appears in the file named by $1.
file_has_marker() {
  local f=$1 m
  for m in "${MARKERS[@]}"; do
    grep -qF "$m" "$f" 2>/dev/null && return 0
  done
  return 1
}

# Slurp stdin with the `read` BUILTIN, not `$(cat)`. The fallback below has to
# work when PATH is unusable — that is precisely when an external `cat` or
# `grep` would silently produce nothing and the guard would fail open on the
# one case it exists to catch. `read -d ''` returns non-zero at EOF while still
# setting the variable, so the `|| true` is expected, not an error.
IFS= read -r -d '' INPUT || true

if ! command -v jq >/dev/null 2>&1; then
  # `[[ == * *]]` is a builtin too, so this branch needs no external command.
  if has_marker "$INPUT"; then
    echo "BLOCKED: jq is unavailable, so this hook cannot parse the tool payload, and the input carries a dotbabel-criteria evidence marker. Refusing rather than failing open." >&2
    exit 2
  fi
  exit 0
fi

if [ "${BYPASS_CRITERIA_EVIDENCE_GUARD:-0}" = "1" ]; then
  exit 0
fi

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
# Join backslash-newline continuations: the checks below work on one string, so
# a call split across lines would otherwise hide the marker from them.
CMD=${CMD//$'\\\n'/ }
NORM=$(printf '%s' "$CMD" | tr '\t' ' ' | tr -s ' ')

block() {
  cat >&2 <<MSG
BLOCKED: this command writes a dotbabel-criteria evidence marker by hand${1}.

The merge gate trusts that marker because the tool derived it from a real
criteria run. A hand-written one is indistinguishable to the gate, so writing
it directly turns machine-checked evidence into an assertion.

Post evidence with the sanctioned writer instead:

  dotbabel criteria verify --pr <N> --post

That command does not carry the marker in its own text, so it is never blocked.

To bypass (the user must confirm first), export
BYPASS_CRITERIA_EVIDENCE_GUARD=1 in the environment Claude Code was started
with. A \`VAR=1 <command>\` prefix does NOT work — it is applied after hooks run.
MSG
  exit 2
}

# 1. The marker inline in the command text.
if has_marker "$NORM"; then
  block ""
fi

# 2. The marker inside a file the command posts with `--body-file <path>` or
#    `-F body=@<path>`. Reading the file is what keeps the obvious indirection
#    from being a free pass; `--body-file -` reads stdin and cannot be checked.
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  [ "$candidate" = "-" ] && continue
  # Strip one layer of surrounding quotes, which the command line usually has.
  candidate=${candidate%\"}
  candidate=${candidate#\"}
  candidate=${candidate%\'}
  candidate=${candidate#\'}
  [ -f "$candidate" ] || continue
  if file_has_marker "$candidate"; then
    block " (via ${candidate})"
  fi
done <<EOF
$(printf '%s' "$NORM" | grep -oE -- '--body-file[= ][^ ]+|-F body=@[^ ]+' | sed -E 's/^--body-file[= ]//; s/^-F body=@//')
EOF

exit 0
