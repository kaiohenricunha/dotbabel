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
# OPT-IN, NOT OPT-OUT — and that asymmetry with check-on-write.sh is
# deliberate. Project-context checks run the project's BUILD tooling, and
# build tooling executes repo-controlled code by design:
#
#   cargo check   runs build.rs           (confirmed: it wrote a marker file)
#   mvn compile   runs Maven plugins
#   dotnet build  runs MSBuild targets
#   go vet        compiles, so cgo directives reach a C compiler
#
# A global Stop hook fires in whatever repo the session is in, so an opt-out
# default would mean: clone a hostile repo, ask the model to edit one file,
# and arbitrary code runs at turn end with the user's privileges. Unlike the
# per-file checkers in check-on-write.sh, there is no flag that disables this
# — executing build logic is the whole point of these tools.
#
# The trust record therefore lives OUTSIDE the repo. An in-tree marker file
# does not work and was tried first: a hostile repo simply commits it and
# arrives pre-trusted on clone (reproduced — a build.rs payload executed).
# Authorization read out of the artifact being authorized is not
# authorization. The allowlist is user-scope, one realpath per line:
#
#   Enable:  echo "$(realpath .)" >> ~/.config/dotbabel/check-on-stop-trusted
#   Or:      CHECK_ON_STOP_TRUST_ALL=1 for blanket behavior
#
# Comparison is exact against the resolved path, not a prefix, so a trusted
# /srv/app does not silently trust /srv/app-untrusted.
# Bypass:  BYPASS_CHECK_ON_STOP=1
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

# Matched case-INSENSITIVELY (grep -i, below). That is deliberate, not
# cosmetic: Maven emits "Could not resolve dependencies" with a capital C, so a
# case-sensitive match against the lowercase alternative never fired, and the
# cold-cache suppression this file documents for `mvn -o` did not work at all.
#
# "cannot access .* in offline mode" replaces a hard-coded "Cannot access
# central". The repository id is whatever the user's settings.xml names, so
# anyone behind a corporate mirror saw "Cannot access nexus (...)" and matched
# nothing.
#
# The NETSDK1004 group is the .NET counterpart. `dotnet build --no-restore`
# emits it on any fresh clone, because obj/ is gitignored by the standard
# template — a state the model cannot fix by editing .cs files.
readonly NOISE_RX='not installed for the toolchain|command not found|No such file or directory|is not recognized as|Permission denied|cannot execute binary|unrecognized command-line option|Unable to find|could not resolve dependencies|cannot access .* in offline mode|NETSDK1004|assets file .* not found|run a nuget package restore'

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

# Resolve ROOT once, here, and use the physical form for everything below.
#
# This is not only for the trust compare. `git rev-parse --show-toplevel`
# returns a physical path, so the containment test in find_project_root would
# compare a resolved directory against an unresolved $ROOT and never match —
# meaning a repo reached through a symlink silently ran no checks at all.
# Claude Code passes exactly such a path when a session works inside a
# worktree, so this is the common case, not an edge one.
ROOT=$(cd "$ROOT" 2>/dev/null && pwd -P) || exit 0

# Trust gate. See the header: these checkers execute repo-controlled build
# code, so the user must have allowlisted this repo out-of-tree. Nothing
# below this point may read anything from $ROOT — note in particular that
# `git rev-parse`/`git status` would load the repo's own .git/config.
if [ "${CHECK_ON_STOP_TRUST_ALL:-0}" != "1" ]; then
  TRUST_FILE="${CHECK_ON_STOP_TRUSTED_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dotbabel/check-on-stop-trusted}"
  [ -f "$TRUST_FILE" ] || exit 0
  TRUSTED=0
  while IFS= read -r entry; do
    case "$entry" in ''|'#'*) continue ;; esac
    entry_real=$(cd "$entry" 2>/dev/null && pwd -P) || continue
    if [ "$entry_real" = "$ROOT" ]; then
      TRUSTED=1
      break
    fi
  done < "$TRUST_FILE"
  [ "$TRUSTED" = "1" ] || exit 0
fi

# ------------------------------------------------------------- state ------

STATE_DIR="${CHECK_ON_STOP_STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dotbabel/check-on-stop}"
STATE_FILE="$STATE_DIR/$SESSION.state"

clear_state() {
  rm -f "$STATE_FILE" 2>/dev/null || true
}

# -------------------------------------------------------- what changed ----

command -v git >/dev/null 2>&1 || exit 0
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# `git status --porcelain` reports paths relative to the repository TOP LEVEL,
# not to the -C directory, so every changed path is resolved against this.
GIT_TOP=$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$GIT_TOP" ] || exit 0

# marker_for <lang> — the file that identifies a project root for a language.
# C# is empty on purpose: it matches a glob (*.csproj / *.sln), handled below.
marker_for() {
  case "$1" in
    go)     printf 'go.mod' ;;
    rust)   printf 'Cargo.toml' ;;
    ts)     printf 'tsconfig.json' ;;
    java)   printf 'pom.xml' ;;
    # Roots for the opt-in tests stage (KD-12). `node` keys on package.json
    # rather than tsconfig.json because that is where the runner is declared.
    node)   printf 'package.json' ;;
    python) printf 'pyproject.toml' ;;
    *)      printf '' ;;
  esac
}

# find_project_root <lang> <dir> — print the nearest directory at or above
# <dir> that holds the language's marker. The walk stops at the repo top.
#
# The marker used to be looked up at $ROOT only, which made this hook a silent
# no-op on every monorepo: squadranks keeps go.mod at api/go.mod, so a Go edit
# found no marker at the root and no check ever ran.
#
# The result must stay inside $ROOT. $ROOT is the directory the user put on
# the trust allowlist, and these checkers execute repo-controlled build code,
# so a root discovered outside it is refused rather than checked.
find_project_root() {
  local lang="$1" dir="$2" marker parent f
  marker=$(marker_for "$lang")
  while :; do
    if [ -n "$marker" ]; then
      if [ -f "$dir/$marker" ]; then
        case "$dir/" in "$ROOT"/*) printf '%s' "$dir"; return 0 ;; esac
        return 1
      fi
    else
      for f in "$dir"/*.csproj "$dir"/*.sln; do
        if [ -e "$f" ]; then
          case "$dir/" in "$ROOT"/*) printf '%s' "$dir"; return 0 ;; esac
          return 1
        fi
      done
    fi
    [ "$dir" = "$GIT_TOP" ] && return 1
    parent="${dir%/*}"
    [ -n "$parent" ] || return 1
    [ "$parent" = "$dir" ] && return 1
    dir="$parent"
  done
}

# -z and --untracked-files=all are both load-bearing:
#
#   -z   disables git's C-quoting. `core.quotePath` defaults to true, so a
#        path with any byte >= 0x80 is emitted wrapped in quotes —
#        `?? "caf\303\251.rs"` — and the trailing quote lands in the
#        extension (`rs"`), matching no arm below. One accented directory
#        component silently disabled checking for everything beneath it.
#
#   --untracked-files=all  expands new directories. The default collapses
#        them to a single `?? newdir/` entry, whose basename is empty, so a
#        file created in a brand-new directory was never seen — which is
#        exactly the turn most worth checking. The explicit flag also
#        overrides a repo-level `status.showUntrackedFiles=no`.
#
# Reading NUL-delimited records means the loop cannot use a here-string (a
# bash variable cannot hold NUL), so it consumes a process substitution —
# which still runs in the current shell, keeping TOUCHED assignments visible.
declare -A TOUCHED=()
# The tests stage needs the FILES, not just the languages: every runner below
# scopes by file path. Kept separate from TOUCHED so the static checks keep
# their existing language map and behavior exactly.
declare -A TEST_TOUCHED=()
SAW_CHANGE=0
while IFS= read -r -d '' entry; do
  [ -n "$entry" ] || continue
  SAW_CHANGE=1
  # Under -z a rename emits TWO records: "R  <new>" then a bare "<old>" with
  # no XY prefix (the " -> " form exists only in the non -z encoding). Strip
  # the prefix only when the record actually carries one. Classifying the
  # rename source as well as its destination is harmless — both extensions
  # belong to the same language in any realistic rename.
  case "$entry" in
    ??" "*) path="${entry:3}" ;;
    *)      path="$entry" ;;
  esac
  base="${path##*/}"
  case "$base" in *.*) ;; *) continue ;; esac
  ext="${base##*.}"
  case "${ext,,}" in
    go)                lang=go ;;
    rs)                lang=rust ;;
    ts|tsx|mts|cts)    lang=ts ;;
    java)              lang=java ;;
    cs)                lang=csharp ;;
    *)                 continue ;;
  esac
  # Key on language AND project root, so a monorepo runs one check per
  # sub-project instead of one check for the whole tree.
  abs="$GIT_TOP/$path"
  proj=$(find_project_root "$lang" "${abs%/*}") || continue
  TOUCHED["$lang"$'\t'"$proj"]=1
done < <(git -C "$ROOT" status --porcelain -z --untracked-files=all 2>/dev/null)

# Second pass for the tests stage. It classifies a WIDER set of extensions than
# the static checks: .js and .py have no static checker here, but they very much
# have tests, and a turn that only touched them would otherwise reach no stage
# at all.
if [ "${CHECK_ON_STOP_TESTS:-0}" = "1" ]; then
  while IFS= read -r -d '' entry; do
    [ -n "$entry" ] || continue
    case "$entry" in
      ??" "*) path="${entry:3}" ;;
      *)      path="$entry" ;;
    esac
    base="${path##*/}"
    case "$base" in *.*) ;; *) continue ;; esac
    ext="${base##*.}"
    case "${ext,,}" in
      js|jsx|cjs|mjs|ts|tsx|mts|cts) tlang=node ;;
      go)                            tlang=go ;;
      py)                            tlang=python ;;
      *)                             continue ;;
    esac
    tabs="$GIT_TOP/$path"
    [ -f "$tabs" ] || continue
    tproj=$(find_project_root "$tlang" "${tabs%/*}") || continue
    tkey="$tlang"$'\t'"$tproj"
    TEST_TOUCHED["$tkey"]="${TEST_TOUCHED[$tkey]:+${TEST_TOUCHED[$tkey]}$'\n'}$tabs"
  done < <(git -C "$ROOT" status --porcelain -z --untracked-files=all 2>/dev/null)
fi

if [ "$SAW_CHANGE" -eq 0 ]; then
  # Nothing changed this turn — a conversational turn, not an edit turn.
  clear_state
  exit 0
fi

# A turn that touched only .js or .py has an empty TOUCHED but a populated
# TEST_TOUCHED, so exiting on TOUCHED alone would make the tests stage dead.
[ "${#TOUCHED[@]}" -gt 0 ] || [ "${#TEST_TOUCHED[@]}" -gt 0 ] || exit 0

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

# Each takes the project root as $1 — find_project_root already proved the
# marker is there, so none of them re-tests for it. `cd` happens in a subshell
# so the caller's working directory is never disturbed between projects.

# ---- related-test runners (KD-12), each scoped by the runner's OWN flag ----
#
# Whole-suite runs are deliberately not offered. The point of this stage is
# feedback on what the turn touched; a full suite at the end of every turn is
# slow enough that it would be switched off, and then it protects nothing.
# `review-pr` step 5 uses exactly these flags for the same reason.

# tst_node <proj> <newline-separated files>
tst_node() {
  local proj="$1" files="$2" manifest="$1/package.json" runner=""
  [ -f "$manifest" ] || return 127
  have npx || return 127
  # Read the declared runner rather than guessing: running `vitest` in a Jest
  # repository fails in a way that looks like a test failure, not a misdetect.
  if grep -q '"vitest"' "$manifest" 2>/dev/null; then runner=vitest
  elif grep -q '"jest"' "$manifest" 2>/dev/null; then runner=jest
  else return 127
  fi
  local -a list=()
  while IFS= read -r f; do [ -n "$f" ] && list+=("$f"); done <<< "$files"
  [ "${#list[@]}" -gt 0 ] || return 127
  if [ "$runner" = "vitest" ]; then
    ( cd "$proj" && run_bounded npx vitest related --run "${list[@]}" ) 2>&1
  else
    ( cd "$proj" && run_bounded npx jest --findRelatedTests --passWithNoTests "${list[@]}" ) 2>&1
  fi
}

# tst_go <proj> <newline-separated files> — scoped to the touched PACKAGES,
# which for Go is the set of directories holding the changed files.
tst_go() {
  local proj="$1" files="$2"
  have go || return 127
  local -a pkgs=()
  local f d
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    d="${f%/*}"
    case " ${pkgs[*]} " in *" $d "*) ;; *) pkgs+=("$d") ;; esac
  done <<< "$files"
  [ "${#pkgs[@]}" -gt 0 ] || return 127
  ( cd "$proj" && run_bounded go test "${pkgs[@]}" ) 2>&1
}

# tst_python <proj> <newline-separated files> — pytest takes TEST files, so a
# changed source file with no matching test contributes nothing here.
tst_python() {
  local proj="$1" files="$2"
  have pytest || return 127
  local -a list=()
  local f base
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    base="${f##*/}"
    case "$base" in test_*.py|*_test.py) list+=("$f") ;; esac
  done <<< "$files"
  [ "${#list[@]}" -gt 0 ] || return 127
  ( cd "$proj" && run_bounded pytest "${list[@]}" ) 2>&1
}

chk_go() {
  have go || return 127
  ( cd "$1" && run_bounded go vet ./... ) 2>&1
}

chk_rust() {
  have cargo || return 127
  ( cd "$1" && run_bounded cargo check --quiet --message-format short ) 2>&1
}

chk_ts() {
  # node_modules is often hoisted to the repo top in a monorepo, so look in
  # the project first and then at the top before falling back to PATH.
  local bin=""
  if [ -x "$1/node_modules/.bin/tsc" ]; then
    bin="$1/node_modules/.bin/tsc"
  elif [ -x "$GIT_TOP/node_modules/.bin/tsc" ]; then
    bin="$GIT_TOP/node_modules/.bin/tsc"
  elif have tsc; then
    bin=tsc
  else
    return 127
  fi
  ( cd "$1" && run_bounded "$bin" --noEmit -p "$1/tsconfig.json" ) 2>&1
}

chk_java() {
  have mvn || return 127
  # -o (offline) so a turn-end check can never sit downloading Maven Central.
  # A cold cache fails fast and is swallowed by NOISE_RX rather than reported.
  ( cd "$1" && run_bounded mvn -o -q -DskipTests compile ) 2>&1
}

chk_csharp() {
  have dotnet || return 127
  ( cd "$1" && run_bounded dotnet build --nologo -v q --no-restore ) 2>&1
}

# ---------------------------------------------------------------- run ----

FAILED_LANGS=()
REPORT=""

for key in "${!TOUCHED[@]}"; do
  lang="${key%%$'\t'*}"
  proj="${key#*$'\t'}"
  # A readable label: the project's path relative to the repo top, or "." at
  # the top itself. This is what tells a monorepo user WHICH project failed.
  label="${proj#"$GIT_TOP"}"
  label="${label#/}"
  [ -n "$label" ] || label="."
  out=""
  rc=0
  out=$("chk_$lang" "$proj" 2>/dev/null) || rc=$?
  [ "$rc" -eq 0 ] && continue
  [ "$rc" -eq 127 ] && continue
  # Timed out, or killed. Not a code defect.
  { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; } && continue
  # Drop the lines that mean "the toolchain failed to run" and keep the rest.
  #
  # This used to discard the ENTIRE output on a single match, which was far too
  # blunt: a long mvn or dotnet failure containing one incidental
  # "No such file or directory" lost every genuine compile error with it, and
  # the hook then reported success on a broken build.
  had_output=0
  [ -n "${out//[[:space:]]/}" ] && had_output=1
  out=$(printf '%s\n' "$out" | grep -viE "$NOISE_RX" || true)
  # Output existed but was entirely toolchain noise: nothing to report. This is
  # distinct from a checker that produced no output at all, which still reports
  # below — silence from a failing checker is worth surfacing.
  if [ "$had_output" -eq 1 ] && [ -z "${out//[[:space:]]/}" ]; then
    continue
  fi
  FAILED_LANGS+=("$lang:$label")
  body=$(printf '%s\n' "$out" | head -n "$MAX_LINES" || true)
  total=$(printf '%s\n' "$out" | wc -l || true)
  REPORT+="[$lang $label] project check failed"$'\n'
  if [ -n "$body" ]; then
    REPORT+="${body:0:3000}"$'\n'
  else
    REPORT+="  exited $rc with no output"$'\n'
  fi
  if [ "$total" -gt "$MAX_LINES" ]; then
    REPORT+="  ... (truncated: $MAX_LINES of $total lines shown)"$'\n'
  fi
done

# ---- tests stage (KD-12): opt-in, trusted-only, runner-scoped -------------
#
# Deliberately placed BEFORE the give-up guard below, so a failing test feeds
# the same signature counter as a failing static check. Without that, a test
# the model cannot fix would block every turn forever — this hook emits
# decision:"block", so an unbounded stage is a trap, not a safety net.
#
# Trust is already enforced far above: an untrusted repository exits before
# reaching any of this. The CHECK_ON_STOP_TESTS opt-in is a SECOND lock, not a
# replacement for it — running a repository's test suite is arbitrary code
# execution chosen by that repository's author.
if [ "${CHECK_ON_STOP_TESTS:-0}" = "1" ] && [ "${#TEST_TOUCHED[@]}" -gt 0 ]; then
  for key in "${!TEST_TOUCHED[@]}"; do
    tlang="${key%%$'\t'*}"
    tproj="${key#*$'\t'}"
    tlabel="${tproj#"$GIT_TOP"}"
    tlabel="${tlabel#/}"
    [ -n "$tlabel" ] || tlabel="."
    tout=""
    trc=0
    tout=$("tst_$tlang" "$tproj" "${TEST_TOUCHED[$key]}" 2>/dev/null) || trc=$?
    [ "$trc" -eq 0 ] && continue
    # No runner, no toolchain, or nothing in scope — silence, never a finding.
    [ "$trc" -eq 127 ] && continue
    # Timed out or killed: a bound was hit, which is not a code defect.
    { [ "$trc" -eq 124 ] || [ "$trc" -eq 137 ]; } && continue
    thad_output=0
    [ -n "${tout//[[:space:]]/}" ] && thad_output=1
    tout=$(printf '%s\n' "$tout" | grep -viE "$NOISE_RX" || true)
    if [ "$thad_output" -eq 1 ] && [ -z "${tout//[[:space:]]/}" ]; then
      continue
    fi
    FAILED_LANGS+=("$tlang-tests:$tlabel")
    tbody=$(printf '%s\n' "$tout" | head -n "$MAX_LINES" || true)
    ttotal=$(printf '%s\n' "$tout" | wc -l || true)
    REPORT+="[$tlang tests $tlabel] related tests failed"$'\n'
    if [ -n "$tbody" ]; then
      REPORT+="${tbody:0:3000}"$'\n'
    else
      REPORT+="  exited $trc with no output"$'\n'
    fi
    if [ "$ttotal" -gt "$MAX_LINES" ]; then
      REPORT+="  ... (truncated: $MAX_LINES of $ttotal lines shown)"$'\n'
    fi
  done
fi

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
