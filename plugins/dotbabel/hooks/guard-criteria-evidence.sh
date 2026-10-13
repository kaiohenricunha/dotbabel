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
# SCOPE, stated plainly rather than overclaimed. This stops a marker that
# reaches a comment through the command text, or through a file that the
# command names in one of the forms listed at step 2 below, when this hook can
# resolve and read that file. It does NOT stop an agent that assembles the
# marker out of band: a file path through any other shell variable, text split
# across shell words, variables or a heredoc, text encoded (base64, a JSON
# escape), or a body written with the Write tool (which this PreToolUse matcher
# does not cover) and then posted. Those remain open by construction: no
# textual guard on one Bash call can close them.
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
# Three marker families are authoritative, so all are guarded.
# `dotbabel-criteria` evidence asserts a criterion result; a forged one turns a
# machine-checked verdict into an assertion. `local-attest` evidence is stronger
# still: the merge gate skips the full test suite AND the quality profile on it,
# so a forged one removes verification rather than misreporting it. The payload
# line is listed too — a marker without it is refused by the gate as INVALID, so
# guarding only the marker would leave the working forgery shape open. Each
# payload entry starts with the `<!-- ` opener, because each payload reader
# accepts line 2 only when it starts with that opener and the token. So a
# read-only search for the bare token (`grep`, `git log -S`) is not blocked.
# The compressed criteria prefix, `<!-- dotbabel-criteria-payload z1:`, begins
# with the plain criteria entry below, so one entry covers both forms.
# `review-complete` evidence lets `/pr-conductor` skip the review stage on a
# commit, so a forged one skips a review nobody did. The `post-pr-review`
# receipt is guarded with it because it is what the sanctioned writer reads to
# believe a review ran: forging the receipt would launder a forged completion
# through the honest command. The per-finding idempotency marker
# (`post-pr-review:v1:<16 hex>`) is deliberately NOT guarded: findings carry it
# in ordinary use and no skip decision rests on it.
MARKER='dotbabel-criteria verified-sha='
MARKERS=(
  "$MARKER"
  '<!-- dotbabel-criteria-payload '
  'local-attest verified-sha='
  '<!-- local-attest-payload '
  'review-complete verified-sha='
  '<!-- review-complete-payload '
  'post-pr-review:v1:receipt'
)

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
    echo "BLOCKED: jq is unavailable, so this hook cannot parse the tool payload, and the input carries a dotbabel evidence marker. Refusing rather than failing open." >&2
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
# The directory the command runs in, from the hook input. A relative body-file
# path resolves against it; without it, the path resolves against this hook's
# own directory.
HOOK_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')

block() {
  cat >&2 <<MSG
BLOCKED: this command writes a dotbabel evidence marker by hand${1}.

The gate and the conductor trust that marker because the tool derived it from a
real run. A hand-written one is indistinguishable to them, so writing it
directly turns machine-checked evidence into an assertion.

Post evidence with the sanctioned writer for its family instead:

  dotbabel criteria verify --pr <N> --post       criteria results
  dotbabel local-attest --pr <N>                 the CI matrix
  dotbabel pr-stack review-complete --pr <N>     the review stage finished

None of them carries its marker in its own command text, so none is blocked.

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

# Remove the shell quoting from one word: `"a b"`, `'a b'` and `a\ b` all give
# `a b`. It follows the quoting rules of the shell, but it expands nothing.
unquote_word() {
  local word=$1 out='' quote='' ch i
  for ((i = 0; i < ${#word}; i++)); do
    ch=${word:i:1}
    if [ -n "$quote" ]; then
      if [ "$ch" = "$quote" ]; then quote=''; else out+=$ch; fi
    elif [ "$ch" = '"' ] || [ "$ch" = "'" ]; then
      quote=$ch
    elif [ "$ch" = '\' ]; then
      i=$((i + 1))
      out+=${word:i:1}
    else
      out+=$ch
    fi
  done
  printf '%s' "$out"
}

# Print the file that a body-file value names, or nothing when this hook cannot
# tell. It expands only a leading `~/`, `$HOME`, `${HOME}`, `$TMPDIR` or
# `${TMPDIR}`, from this hook's own environment, and it evaluates nothing. A
# relative path resolves against HOOK_CWD when the hook input gives one.
resolve_body_path() {
  local p=$1 name='' rest=''
  case $p in
    \~/*) name=HOME rest=${p#\~} ;;
    '${HOME}'*) name=HOME rest=${p#'${HOME}'} ;;
    '${TMPDIR}'*) name=TMPDIR rest=${p#'${TMPDIR}'} ;;
    '$HOME' | '$HOME'[!A-Za-z0-9_]*) name=HOME rest=${p#'$HOME'} ;;
    '$TMPDIR' | '$TMPDIR'[!A-Za-z0-9_]*) name=TMPDIR rest=${p#'$TMPDIR'} ;;
  esac
  if [ -n "$name" ]; then
    [ -n "${!name:-}" ] || return 0
    p=${!name}$rest
  fi
  case $p in
    /*) ;;
    *) [ -z "$HOOK_CWD" ] || p=$HOOK_CWD/$p ;;
  esac
  printf '%s' "$p"
}

# 2. The marker inside a file the command posts. The hook reads the file that
#    each of these forms names:
#      --body-file <path>, --body-file=<path>
#      -F <path>          a value with no `=`; `gh pr comment` and `gh pr create`
#                         read it as the body file
#      --input <path>     the request body of `gh api`
#      -F body=@<path>    and `--field body=@<path>`
#    The value can be in single or double quotes, and it can contain spaces.
#    Reading the file is what keeps the obvious indirection from being a free
#    pass. A value of `-` reads stdin and cannot be checked, and a path that
#    resolve_body_path cannot resolve, or that is not a readable file, is
#    skipped: a legitimate command can name a file through any variable.
#
#    WORD is one shell word: plain characters, a backslash escape, or a quoted
#    run. The match runs on CMD, not NORM, so the spaces in a quoted path stay.
WORD="([^[:space:]\"'\\\\]|\\\\.|\"[^\"]*\"|'[^']*')+"
FILE_FLAGS="(^|[[:blank:]])(--body-file|--input|--field|-F)(=|[[:blank:]]+)$WORD"
while IFS= read -r found; do
  [ -n "$found" ] || continue
  found=${found#"${found%%[![:blank:]]*}"}
  flag=${found%%[=[:blank:]]*}
  value=${found#"$flag"}
  value=${value#=}
  value=${value#"${value%%[![:blank:]]*}"}
  value=$(unquote_word "$value")
  case $flag in
    -F | --field)
      case $value in
        body=@*) value=${value#body=@} ;;
        *=*) continue ;;
        # Only -F, never --field, names a body file without a `key=`.
        *) [ "$flag" = "-F" ] || continue ;;
      esac
      ;;
  esac
  if [ -z "$value" ] || [ "$value" = "-" ]; then
    continue
  fi
  candidate=$(resolve_body_path "$value")
  if [ -z "$candidate" ] || [ ! -f "$candidate" ]; then
    continue
  fi
  if file_has_marker "$candidate"; then
    block " (via ${candidate})"
  fi
done <<EOF
$(printf '%s' "$CMD" | grep -oE -- "$FILE_FLAGS")
EOF

exit 0
