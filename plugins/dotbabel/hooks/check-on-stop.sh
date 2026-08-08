#!/usr/bin/env bash
# Stop hook: run project-context checks once per turn.
#
# The counterpart to check-on-write.sh. That hook does per-file syntax checks
# after every edit; this one runs the checks that need the whole build graph
# (tsc --noEmit, go vet, cargo check, mvn, dotnet build) at the moment the
# graph is supposed to be coherent — after the model has finished editing.
#
# Running these per-edit would be wrong, not merely slow: mid-refactor a
# single edit legitimately leaves the graph broken (change a signature in
# a.ts and b.ts is wrong until the next tool call), so the errors reported
# would be true but useless.
#
# On failure this emits decision:"block", which makes Claude keep working
# rather than stopping. That is the point — and it is also the risk, so
# there are TWO independent loop guards:
#
#   1. stop_hook_active — Claude Code sets this while a Stop hook is already
#      in flight. Checked FIRST, before any state is written.
#   2. A per-session give-up counter. If the same failure signature blocks
#      twice in a row, the model demonstrably cannot fix it, so stop nagging.
#
# Guard 2 exists because guard 1 is undocumented: `stop_hook_active` appears
# in Anthropic's own shipped Stop hook as load-bearing recursion protection
# but is absent from the published hooks reference. Never rely on it alone.
#
# Output shape: guidance on stderr AND top-level decision/reason JSON on
# stdout, exit 0. Stop is NOT a member of Claude Code's hookSpecificOutput
# union — emitting hookSpecificOutput{hookEventName:"Stop"} fails schema
# validation. Claude Code's Stop delivery reads `stderr || stdout` for the
# model-visible body, so the guidance must be on stderr too.
#
# Deliberately self-contained — do NOT source scripts/lib/output.sh. The file
# is symlinked into ~/.claude/hooks/, so a relative source resolves against
# the wrong directory; and its helpers print to stdout, which would corrupt
# the JSON contract. The ~30 lines shared with check-on-write.sh are
# duplicated on purpose for the same reason.
#
# Bypass:  BYPASS_CHECK_ON_STOP=1
# Opt out: a .dotbabel-nocheck file at the project root
# Tuning:  CHECK_ON_STOP_TIMEOUT (seconds per check, default 120)
#          CHECK_ON_STOP_MAX_LINES (default 30)
#          CHECK_ON_STOP_STATE_DIR (give-up counter location)

set -euo pipefail

(( BASH_VERSINFO[0] >= 4 )) || exit 0

[ "${BYPASS_CHECK_ON_STOP:-0}" = "1" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

readonly CHECK_TIMEOUT="${CHECK_ON_STOP_TIMEOUT:-120}"
readonly MAX_LINES="${CHECK_ON_STOP_MAX_LINES:-30}"
readonly MAX_BLOCKS=2

readonly NOISE_RX='not installed for the toolchain|command not found|No such file or directory|is not recognized as|Permission denied|cannot execute binary|unrecognized command-line option|Unable to find|could not resolve dependencies|Cannot access central'

INPUT=$(cat)

# ---- GUARD 1: recursion. Must precede every side effect, including state. ----
ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null) || exit 0
[ "$ACTIVE" = "true" ] && exit 0

SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "default"' 2>/dev/null) || exit 0
# Sanitize: the session id becomes a filename.
SESSION="${SESSION//[^A-Za-z0-9._-]/_}"
[ -n "$SESSION" ] || SESSION=default

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || exit 0
fi
[ -n "$ROOT" ] || exit 0
[ -d "$ROOT" ] || exit 0

[ -e "$ROOT/.dotbabel-nocheck" ] && exit 0

# ------------------------------------------------------------- state ------

STATE_DIR="${CHECK_ON_STOP_STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dotbabel/check-on-stop}"
STATE_FILE="$STATE_DIR/$SESSION.state"

clear_state() {
  rm -f "$STATE_FILE" 2>/dev/null || true
}

# -------------------------------------------------------- what changed ----

command -v git >/dev/null 2>&1 || exit 0
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

CHANGED=$(git -C "$ROOT" status --porcelain 2>/dev/null) || exit 0
if [ -z "$CHANGED" ]; then
  # Nothing changed this turn — a conversational turn, not an edit turn.
  clear_state
  exit 0
fi

declare -A TOUCHED=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  # Strip the two-column status plus its separating space, then take the
  # destination of a rename ("R  old -> new").
  path="${line:3}"
  case "$path" in *" -> "*) path="${path##* -> }" ;; esac
  base="${path##*/}"
  case "$base" in *.*) ;; *) continue ;; esac
  ext="${base##*.}"
  case "${ext,,}" in
    go)                TOUCHED[go]=1 ;;
    rs)                TOUCHED[rust]=1 ;;
    ts|tsx|mts|cts)    TOUCHED[ts]=1 ;;
    java)              TOUCHED[java]=1 ;;
    cs)                TOUCHED[csharp]=1 ;;
  esac
done <<< "$CHANGED"

[ "${#TOUCHED[@]}" -gt 0 ] || exit 0

# ------------------------------------------------------------- runner ----

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi

run_bounded() {
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" -k 5 "$CHECK_TIMEOUT" "$@"
  else
    "$@"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Each chk_* prints diagnostics on stdout and returns the tool's exit code.
# 127 means "not applicable here" — no marker, or no toolchain — and is
# always treated as silence, never as a finding.

chk_go() {
  [ -f "$ROOT/go.mod" ] || return 127
  have go || return 127
  run_bounded go vet ./... 2>&1
}

chk_rust() {
  [ -f "$ROOT/Cargo.toml" ] || return 127
  have cargo || return 127
  run_bounded cargo check --quiet --message-format short 2>&1
}

chk_ts() {
  [ -f "$ROOT/tsconfig.json" ] || return 127
  local bin="$ROOT/node_modules/.bin/tsc"
  if [ ! -x "$bin" ]; then
    have tsc || return 127
    bin=tsc
  fi
  run_bounded "$bin" --noEmit -p "$ROOT/tsconfig.json" 2>&1
}

chk_java() {
  [ -f "$ROOT/pom.xml" ] || return 127
  have mvn || return 127
  # -o (offline) so a turn-end check can never sit downloading Maven Central.
  # A cold cache fails fast and is swallowed by NOISE_RX rather than reported.
  run_bounded mvn -o -q -DskipTests compile 2>&1
}

chk_csharp() {
  local found=""
  for f in "$ROOT"/*.csproj "$ROOT"/*.sln; do
    if [ -e "$f" ]; then found=1; break; fi
  done
  [ -n "$found" ] || return 127
  have dotnet || return 127
  run_bounded dotnet build --nologo -v q --no-restore 2>&1
}

# ---------------------------------------------------------------- run ----

FAILED_LANGS=()
REPORT=""

cd "$ROOT" || exit 0

for lang in "${!TOUCHED[@]}"; do
  out=""
  rc=0
  out=$("chk_$lang" 2>/dev/null) || rc=$?
  [ "$rc" -eq 0 ] && continue
  [ "$rc" -eq 127 ] && continue
  # Timed out, or killed. Not a code defect.
  { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; } && continue
  # The toolchain failed to run rather than finding a defect.
  if printf '%s' "$out" | grep -qE "$NOISE_RX"; then
    continue
  fi
  FAILED_LANGS+=("$lang")
  body=$(printf '%s\n' "$out" | head -n "$MAX_LINES" || true)
  total=$(printf '%s\n' "$out" | wc -l || true)
  REPORT+="[$lang] project check failed"$'\n'
  if [ -n "$body" ]; then
    REPORT+="${body:0:3000}"$'\n'
  else
    REPORT+="  exited $rc with no output"$'\n'
  fi
  if [ "$total" -gt "$MAX_LINES" ]; then
    REPORT+="  ... (truncated: $MAX_LINES of $total lines shown)"$'\n'
  fi
done

if [ "${#FAILED_LANGS[@]}" -eq 0 ]; then
  clear_state
  exit 0
fi

# ---- GUARD 2: give up on a failure the model has already failed to fix ----
#
# The signature covers both which languages failed AND their output, so a
# model making partial progress produces a new signature and keeps getting
# feedback; only a genuinely stuck, byte-identical failure exhausts the count.
IFS=$'\n' read -r -d '' -a SORTED < <(printf '%s\n' "${FAILED_LANGS[@]}" | sort && printf '\0')
SIG="${SORTED[*]}:$(printf '%s' "$REPORT" | cksum | tr -d ' ')"

PREV_COUNT=0
PREV_SIG=""
if [ -f "$STATE_FILE" ]; then
  PREV_COUNT=$(head -n1 "$STATE_FILE" 2>/dev/null || echo 0)
  PREV_SIG=$(sed -n '2p' "$STATE_FILE" 2>/dev/null || echo "")
fi
case "$PREV_COUNT" in ''|*[!0-9]*) PREV_COUNT=0 ;; esac

if [ "$SIG" = "$PREV_SIG" ] && [ "$PREV_COUNT" -ge "$MAX_BLOCKS" ]; then
  exit 0
fi

if [ "$SIG" = "$PREV_SIG" ]; then
  NEW_COUNT=$((PREV_COUNT + 1))
else
  NEW_COUNT=1
fi
mkdir -p "$STATE_DIR" 2>/dev/null || true
printf '%s\n%s\n' "$NEW_COUNT" "$SIG" > "$STATE_FILE" 2>/dev/null || true

# -------------------------------------------------------------- report ----

GUIDANCE="check-on-stop: project checks failed after your edits. Fix these before finishing.

$REPORT"

# stderr is the channel Claude Code's Stop delivery actually reads for the
# model-visible body (`stderr || stdout`).
printf '%s\n' "$GUIDANCE" >&2

# Top-level decision/reason. Single line — Claude Code stops scanning stdout
# after the first `{`-prefixed line. Built with jq so embedded quotes,
# newlines and UTF-8 escape correctly.
jq -cn --arg r "$GUIDANCE" '{decision:"block", reason:$r}'

exit 0
