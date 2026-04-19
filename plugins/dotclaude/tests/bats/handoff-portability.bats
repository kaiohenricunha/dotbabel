#!/usr/bin/env bats
# Force each branch of the GNU/BSD fallback chains in handoff-resolve
# (pick_newest: find -printf %T@ → stat -f %Fm → stat -c %Y) and
# handoff-extract (file_iso_mtime: date -r → date -d @stat) by shimming
# PATH so the higher-precedence tool exits non-zero.

load helpers

RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"
EXTRACT="$REPO_ROOT/plugins/dotclaude/scripts/handoff-extract.sh"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  [ -x "$EXTRACT" ] || chmod +x "$EXTRACT"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  SHIM_DIRS=()
}

teardown() {
  local d
  for d in "${SHIM_DIRS[@]}"; do
    rm -rf "$d"
  done
  rm -rf "$TEST_HOME"
}

# Fractional-second mtime delta: distinguishable only by `find -printf %T@`
# or `stat -f %Fm`; the whole-second fallback can't resolve the order.
seed_fractional_pair() {
  local older="$1" newer="$2"
  local dir="$TEST_HOME/.claude/projects/-demo"
  mkdir -p "$dir"
  printf '{"cwd":"/x","sessionId":"%s"}\n' "$older" > "$dir/$older.jsonl"
  printf '{"cwd":"/x","sessionId":"%s"}\n' "$newer" > "$dir/$newer.jsonl"
  if ! touch -d '2026-04-18 10:00:00.100000000' "$dir/$older.jsonl" 2>/dev/null; then
    skip "fractional-second touch not supported on this platform"
  fi
  touch -d '2026-04-18 10:00:00.900000000' "$dir/$newer.jsonl"
}

@test "pick_newest picks newest via find -printf %T@ (GNU primary)" {
  # Baseline for the fallback tests: without a shim, the resolver should
  # resolve the fractional-ms delta via find -printf.
  local older="aaaa1111-1111-1111-1111-111111111111"
  local newer="bbbb2222-2222-2222-2222-222222222222"
  seed_fractional_pair "$older" "$newer"
  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$newer.jsonl" ]]
}

@test "pick_newest falls back to BSD stat -f %Fm when find -printf fails" {
  local older="cccc3333-3333-3333-3333-333333333333"
  local newer="dddd4444-4444-4444-4444-444444444444"
  seed_fractional_pair "$older" "$newer"

  # Shim: exit 1 on pick_newest's `-printf '%T@'` probe, delegate
  # everything else to the real `find`.
  local shim
  shim=$(with_fake_tool_bin find '
for arg in "$@"; do
  if [[ "$arg" == "%T@" ]]; then
    exit 1
  fi
done
exec /usr/bin/find "$@"
')
  SHIM_DIRS+=("$shim")

  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$newer.jsonl" ]]
}

@test "pick_newest falls back to stat -c %Y when find -printf and stat -f fail" {
  # With both fractional-precision paths disabled, pick_newest falls back
  # to whole-second mtime — so stamps must be ≥1s apart to resolve order.
  local older="eeee5555-5555-5555-5555-555555555555"
  local newer="ffff6666-6666-6666-6666-666666666666"
  local dir="$TEST_HOME/.claude/projects/-demo"
  mkdir -p "$dir"
  printf '{"cwd":"/x","sessionId":"%s"}\n' "$older" > "$dir/$older.jsonl"
  printf '{"cwd":"/x","sessionId":"%s"}\n' "$newer" > "$dir/$newer.jsonl"
  touch -d '2026-04-18 10:00:00' "$dir/$older.jsonl"
  touch -d '2026-04-18 10:00:02' "$dir/$newer.jsonl"

  # Shim find to reject -printf, and stat to reject -f %Fm.
  local find_shim stat_shim
  find_shim=$(with_fake_tool_bin find '
for arg in "$@"; do
  [[ "$arg" == "%T@" ]] && exit 1
done
exec /usr/bin/find "$@"
')
  stat_shim=$(with_fake_tool_bin stat '
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-f" && "$arg" == "%Fm" ]]; then
    exit 1
  fi
  prev="$arg"
done
exec /usr/bin/stat "$@"
')
  SHIM_DIRS+=("$find_shim" "$stat_shim")

  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$newer.jsonl" ]]
}

@test "extract meta returns valid started_at when date -r is unavailable" {
  # Shim date to reject -r, forcing the `date -u -d "@$(stat ...)"`
  # fallback. Extract must still emit a well-formed ISO-8601 timestamp.
  local uuid="aaaa0000-0000-0000-0000-000000000000"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  printf '{"cwd":"/z","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$file"

  local shim
  shim=$(with_fake_tool_bin date '
for arg in "$@"; do
  [[ "$arg" == "-r" ]] && exit 1
done
exec /usr/bin/date "$@"
')
  SHIM_DIRS+=("$shim")

  run "$EXTRACT" meta claude "$file"
  [ "$status" -eq 0 ]
  [[ "$output" =~ \"started_at\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\" ]]
}
