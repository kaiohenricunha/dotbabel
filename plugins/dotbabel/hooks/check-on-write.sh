#!/usr/bin/env bash
# PostToolUse hook: syntax-check the file Claude just edited.
#
# Reads JSON from stdin (Claude Code hook protocol) and dispatches a per-file
# syntax checker based on the file's extension. Hard errors (parse/syntax) are
# reported; style findings are not.
#
# Exit 2 = show stderr to Claude. For PostToolUse this does NOT block — the
# tool already ran — it only surfaces the diagnostic to the model so it can
# fix what it just broke. Exit 0 = silent (no finding, or nothing applicable).
#
# This hook is READ-ONLY by construction: every checker is syntax-only and
# writes nothing (note gofmt is invoked without -w). That is the key
# difference from .claude/hooks/format-on-write.sh, and it is why this hook
# cannot re-trigger itself.
#
# Deliberately self-contained — do NOT source scripts/lib/output.sh. The file
# is symlinked into ~/.claude/hooks/, so a relative source resolves against
# the wrong directory; and output.sh's pass/fail/warn print to stdout, which
# would corrupt the hook output contract.
#
# Bypass: BYPASS_CHECK_ON_WRITE=1 in the environment.
# Tuning:  CHECK_ON_WRITE_TIMEOUT (seconds, default 5)
#          CHECK_ON_WRITE_MAX_LINES (default 40)
#          CHECK_ON_WRITE_MAX_CHARS (default 4000)
#
# Only per-file checks live here. Project-context checks that need the whole
# build graph (tsc --noEmit, go vet, cargo check, javac, dotnet build) belong
# in a Stop hook, which fires once per turn when the graph is coherent —
# running them per-edit reports true-but-useless errors mid-refactor.

set -euo pipefail

# Associative arrays and ${var,,} are bash 4+. Stock macOS ships bash 3.2;
# degrade to a silent no-op there rather than spewing syntax errors.
(( BASH_VERSINFO[0] >= 4 )) || exit 0

[ "${BYPASS_CHECK_ON_WRITE:-0}" = "1" ] && exit 0

# Always use this in a condition, never bare: `set -e` would abort on a miss.
have() { command -v "$1" >/dev/null 2>&1; }

# Fail open if jq is not installed — never break edits over a missing parser.
have jq || exit 0

readonly CHECK_TIMEOUT="${CHECK_ON_WRITE_TIMEOUT:-5}"
readonly MAX_LINES="${CHECK_ON_WRITE_MAX_LINES:-40}"
readonly MAX_CHARS="${CHECK_ON_WRITE_MAX_CHARS:-4000}"
readonly MAX_BYTES=1000000

# Output that means "the toolchain failed to run", not "the code is wrong".
# Version-manager shims (rustup/pyenv/gvm/nvm) exit non-zero with these, which
# is indistinguishable from a real syntax error by exit code alone. Reporting
# them to the model as code defects is worse than staying silent.
readonly NOISE_RX='not installed for the toolchain|command not found|No such file or directory|ExperimentalWarning|is not recognized as|Permission denied|cannot execute binary|bad option|unrecognized command-line option|compilation terminated'

# ---------------------------------------------------------------- input ----

INPUT=$(cat)

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
# NotebookEdit is deliberately absent: its tool_input carries notebook_path,
# not file_path, so it could never reach a checker anyway.
case "$TOOL" in
  Edit|Write|MultiEdit) ;;
  *) exit 0 ;;
esac

FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$FILE" ] || exit 0

# Claude Code always sends absolute paths for file tools. A relative path means
# something unexpected upstream — refuse to resolve it against an arbitrary CWD.
case "$FILE" in
  /*) ;;
  *) exit 0 ;;
esac

# --------------------------------------------------------------- filters ----

# Cheapest guard first: pure-bash path-segment denylist, no subprocess.
case "$FILE/" in
  */node_modules/*|*/vendor/*|*/.git/*|*/dist/*|*/build/*|*/target/*|*/.venv/*|*/__pycache__/*|*/.next/*|*/.cache/*)
    exit 0 ;;
esac
case "$FILE" in
  "${HOME:-/nonexistent}"/.claude/*) exit 0 ;;
esac

BASE="${FILE##*/}"
# No dot at all means no extension to dispatch on.
case "$BASE" in
  *.*) ;;
  *) exit 0 ;;
esac
EXT="${BASE##*.}"
EXT="${EXT,,}"

# ------------------------------------------------------------- dispatch ----
#
# Extension -> checker function. Adding a language is one line here plus one
# chk_* function below.
#
# Deliberately ABSENT, because no honest per-file check exists — these need a
# build graph and belong in the Stop hook:
#   .rs    rustc --emit=metadata fails on any `mod` / `use crate::`
#   .java  javac without a classpath errors on every import
#   .cs    Roslyn ships no standalone syntax-only CLI
#   .tsx .jsx .js  Node's parser cannot handle JSX, and React codebases
#                  routinely put JSX in bare .js
#   .ts .mts .cts  `node --check` does NOT honor --experimental-transform-types
#                  or --experimental-strip-types (verified on Node 22.22.2): it
#                  reports "Missing initializer in const declaration" on the
#                  perfectly valid `const x: number = 1`. Running the file
#                  instead would execute it, which a read-only hook must never
#                  do. TS is covered properly by tsc --noEmit in the Stop hook.
#   .c .h .cc .cpp .cxx .hpp .hh
#                  `gcc -fsyntax-only` still runs the preprocessor, and GCC's
#                  caret display quotes included source. An absolute
#                  `#include "$HOME/.ssh/id_rsa"` bypasses -I and pipes the key
#                  material straight into the model transcript (reproduced);
#                  `#error` gives a hostile file an arbitrary-text channel.
#                  No GCC flag disables #include. Separately, `.h` is ambiguous
#                  by convention and a C++ header parsed as C reports hard
#                  errors on valid code. Both are the same build-graph problem
#                  as .rs/.java/.cs — the -I"${1%/*}" hack was an admission of
#                  it — so C/C++ belongs in the Stop hook too.
declare -A CHECKERS=(
  [sh]=chk_shell   [bash]=chk_shell
  [go]=chk_go
  [py]=chk_python  [pyi]=chk_python
  [mjs]=chk_node   [cjs]=chk_node
  [r]=chk_r
)

FN="${CHECKERS[$EXT]:-}"
# Most edits land here — exit before spawning any subprocess.
[ -n "$FN" ] || exit 0

# --------------------------------------------------------- file sanity ----

[ -f "$FILE" ] || exit 0
[ -r "$FILE" ] || exit 0

SIZE=$(wc -c < "$FILE" 2>/dev/null) || exit 0
[ "$SIZE" -le "$MAX_BYTES" ] || exit 0

# Generated code is not the model's to fix. The Go convention is standardized;
# the others are common enough to be worth honoring.
if head -n 3 "$FILE" 2>/dev/null \
  | grep -qE 'Code generated .* DO NOT EDIT|@generated|Autogenerated by'; then
  exit 0
fi

# Respect the project's own ignore rules, but only after an extension match so
# the ~13ms cost is paid on files that were going to be checked anyway.
if have git && git -C "${FILE%/*}" check-ignore -q -- "$FILE" 2>/dev/null; then
  exit 0
fi

# ---------------------------------------------------------------- runner ----

TIMEOUT_BIN=""
if have timeout; then
  TIMEOUT_BIN="timeout"
elif have gtimeout; then
  TIMEOUT_BIN="gtimeout"
fi

# Run a checker, bounded. `timeout` is GNU coreutils and absent on stock macOS;
# running bare is an acceptable residual risk at these latencies.
run_bounded() {
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" -k 1 "$CHECK_TIMEOUT" "$@"
  else
    "$@"
  fi
}

# Each chk_* prints diagnostics on stdout and returns the checker's exit code.
# Returning 127 means "no usable toolchain" and is treated as silence.

chk_shell() {
  have shellcheck || return 127
  # -S error yields only SC1xxx parse errors; style (SC2086 et al) stays quiet.
  #
  # SC2148 is excluded despite being error-severity: it means "I cannot tell
  # which shell dialect this is", not "this code is broken". Sourced fragments
  # legitimately have no shebang (/etc/profile.d/*.sh, activate.sh, scripts/lib
  # helpers), and reporting those as syntax failures is a false positive on
  # perfectly valid files. Note .bash files are unaffected — shellcheck infers
  # the dialect from that extension.
  run_bounded shellcheck -S error -e SC2148 --format=gcc -- "$1" 2>&1
}

chk_go() {
  have gofmt || return 127
  # gofmt writes parse errors to stderr and formatted source to stdout. Keep
  # the diagnostics, discard the source. -l is deliberately NOT used: it
  # reports formatting drift, which is style, not a hard error.
  # The brace form (rather than `... 2>&1 >/dev/null`) is what SC2069 wants.
  { run_bounded gofmt -e -- "$1" >/dev/null; } 2>&1
}

chk_python() {
  if have ruff; then
    # --isolated ignores per-repo pyproject.toml, which a global hook must do.
    # --select E9 restricts to syntax/IO errors, excluding style entirely.
    run_bounded ruff check --isolated --no-cache --quiet \
      --select E9 --output-format concise -- "$1" 2>&1
  elif have python3; then
    # -I (isolated) is load-bearing, not cosmetic: `python3 -c` otherwise
    # prepends the CWD to sys.path, and `ast` is pure-Python stdlib, so a
    # repo-local ast.py wins the import and its module-level code executes.
    # Reproduced: editing any .py in a repo containing ast.py, on a machine
    # without ruff, ran an arbitrary payload. -I also drops PYTHON* env vars.
    run_bounded python3 -I -c \
      'import ast,sys; ast.parse(open(sys.argv[1],"rb").read())' "$1" 2>&1
  else
    return 127
  fi
}

chk_node() {
  have node || return 127
  run_bounded node --check "$1" 2>&1
}

chk_r() {
  have Rscript || return 127
  # --vanilla skips .Rprofile/.Renviron, which otherwise dominate startup cost.
  run_bounded Rscript --vanilla \
    -e 'invisible(parse(commandArgs(TRUE)[1]))' -- "$1" 2>&1
}

# ------------------------------------------------------------------ run ----

RAW=""
RC=0
# Checkers exit non-zero BY DESIGN when they find something; `|| RC=$?` keeps
# set -e from aborting here.
RAW=$("$FN" "$FILE") || RC=$?

# Toolchain absent, or the checker was happy. A checker that exits 0 while
# printing advisory text is reporting style — stay silent by policy.
[ "$RC" -eq 0 ] && exit 0
[ "$RC" -eq 127 ] && exit 0

# The toolchain failed to run rather than finding a defect. Discard the ENTIRE
# output, not just the offending line: gcc aborts at the first missing include
# and every subsequent diagnostic is downstream garbage.
if printf '%s' "$RAW" | grep -qE "$NOISE_RX"; then
  exit 0
fi

# A timeout kill is not a code defect either.
if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then
  exit 0
fi

# ---------------------------------------------------------------- report ----

# `head` exits as soon as it has enough lines, which SIGPIPEs the upstream
# printf. Under `set -o pipefail` that makes the whole substitution non-zero
# and `set -e` would abort before the report is ever written — so both of
# these assignments must swallow the pipeline status explicitly.
TOTAL=$(printf '%s\n' "$RAW" | wc -l || true)
BODY=$(printf '%s\n' "$RAW" | head -n "$MAX_LINES" || true)
# Second, independent cap on total bytes. A single very long line (minified JS,
# a g++ template instantiation) passes the line cap untouched, so without this
# the payload could be arbitrarily large. Track the pre-cut length so the
# truncation notice below fires on either limit, not just the line count.
RAW_LEN=${#BODY}
BODY="${BODY:0:$MAX_CHARS}"

{
  printf 'check-on-write: %s failed syntax check (%s)\n' "$BASE" "$EXT"
  if [ -n "$BODY" ]; then
    printf '%s\n' "$BODY"
  else
    # Silent failure is worse than noise — say that something ran and failed.
    printf '  checker exited %s with no output\n' "$RC"
  fi
  if [ "$TOTAL" -gt "$MAX_LINES" ]; then
    printf '  ... (truncated: %s of %s lines shown)\n' "$MAX_LINES" "$TOTAL"
  elif [ "$RAW_LEN" -gt "$MAX_CHARS" ]; then
    printf '  ... (truncated: %s of %s characters shown)\n' "$MAX_CHARS" "$RAW_LEN"
  fi
} >&2

exit 2
