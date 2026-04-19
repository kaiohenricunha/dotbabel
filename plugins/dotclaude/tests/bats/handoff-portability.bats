#!/usr/bin/env bats
# Portability tests. The shell scripts are deliberately written to run
# on both GNU and BSD toolchains. Production picks whichever works;
# these tests shim PATH to force each fallback branch and prove the
# chain holds.
#
# Covered fallbacks:
#   handoff-resolve.sh:pick_newest
#     - find -printf %T@        (GNU primary)
#     - stat -f %Fm              (BSD)
#     - stat -c %Y               (GNU fallback, whole-second only)
#   handoff-extract.sh:file_iso_mtime
#     - date -u -r               (BSD + GNU coreutils)
#     - date -u -d @$(stat ...)  (older coreutils without -r)

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

# Seed two claude sessions with fractional-second mtime delta. pick_newest's
# primary branch resolves this via `find -printf %T@`; fallbacks that rely
# on whole-second mtime can't distinguish them.
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

# -- pick_newest primary (GNU find -printf) ------------------------------

@test "pick_newest picks newest via find -printf %T@ (GNU primary)" {
  # Baseline: no shim. Resolver should see the fractional-ms delta and
  # pick the newer file. If this fails, the fallback tests below have no
  # meaningful baseline.
  local older="aaaa1111-1111-1111-1111-111111111111"
  local newer="bbbb2222-2222-2222-2222-222222222222"
  seed_fractional_pair "$older" "$newer"
  # Short-UUID prefix is intentionally non-matching so `find` enumerates
  # the whole dir; `latest` would bypass the fractional logic on some
  # code paths. Use `claude latest` which exercises pick_newest directly.
  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$newer.jsonl" ]]
}

# -- pick_newest BSD stat fallback --------------------------------------

@test "pick_newest falls back to BSD stat -f %Fm when find -printf fails" {
  local older="cccc3333-3333-3333-3333-333333333333"
  local newer="dddd4444-4444-4444-4444-444444444444"
  seed_fractional_pair "$older" "$newer"

  # Shim `find`: for `-maxdepth 0 -printf '%T@'` (pick_newest's probe),
  # exit non-zero to force the fallback. For any other invocation,
  # delegate to the real `find`. The shim must appear on PATH before
  # `/usr/bin/find`.
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

# -- pick_newest GNU stat -c %Y fallback --------------------------------

@test "pick_newest falls back to stat -c %Y when find -printf and stat -f fail" {
  # With both fractional-precision paths disabled, pick_newest falls
  # back to whole-second mtime. Use 2-second-apart stamps so the
  # fallback can resolve ordering.
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
# Reject BSD-style -f %Fm; delegate everything else to real stat.
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

# -- file_iso_mtime fallback --------------------------------------------

@test "extract meta returns valid started_at when date -r is unavailable" {
  # file_iso_mtime's primary is `date -u -r <file>`; fallback is
  # `date -u -d "@$(stat ...)"`. Shim `date` to reject -r (emulating
  # environments without GNU coreutils date), then assert extract still
  # emits a well-formed ISO-8601 timestamp.
  local uuid="aaaa0000-0000-0000-0000-000000000000"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  printf '{"cwd":"/z","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$file"

  local shim
  shim=$(with_fake_tool_bin date '
# Reject any invocation that uses -r <file>; delegate everything else.
for arg in "$@"; do
  [[ "$arg" == "-r" ]] && exit 1
done
exec /usr/bin/date "$@"
')
  SHIM_DIRS+=("$shim")

  run "$EXTRACT" meta claude "$file"
  [ "$status" -eq 0 ]
  # Match the ISO-8601 UTC shape: YYYY-MM-DDTHH:MM:SSZ
  [[ "$output" =~ \"started_at\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\" ]]
}
