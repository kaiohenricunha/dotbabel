#!/usr/bin/env bats
# Verify pick_newest() works correctly on a busybox substrate where
# `stat -f` accepts the flag but ignores the format string, dumps
# multi-line default output, and exits 0 (so a runtime fallback chain
# cannot detect the failure). The stat probe at init detects this case
# and sets _STAT_FLAVOR=posix, causing pick_newest to use `stat -c %Y`.

load helpers

RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"

# Shim body that simulates busybox stat behavior:
#   --version  → non-GNU string (probe falls through to bsd check)
#   -f         → multi-line default output + exit 0 (bsd probe grep fails → posix)
#   *          → delegate to real stat (stat -c %Y works correctly on busybox)
BUSYBOX_STAT_BODY='
case "$1" in
  --version)
    printf "BusyBox v1.36.1 multi-call binary\n"
    exit 0
    ;;
  -f)
    printf "  File: \"stub\"\n  Size: 1234\tBlocks: 8\tIO Block: 4096 regular file\n"
    printf "Device: fd01h/64769d\tInode: 123456\tLinks: 1\n"
    exit 0
    ;;
  *)
    exec /usr/bin/stat "$@"
    ;;
esac
'

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
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

@test "pick_newest selects newer file on busybox substrate (stat -c %Y path)" {
  local older="aaaa1111-1111-1111-1111-111111111111"
  local newer="bbbb2222-2222-2222-2222-222222222222"
  local dir="$TEST_HOME/.claude/projects/-demo"
  mkdir -p "$dir"
  printf '{"cwd":"/x","sessionId":"%s"}\n' "$older" > "$dir/$older.jsonl"
  printf '{"cwd":"/x","sessionId":"%s"}\n' "$newer" > "$dir/$newer.jsonl"
  # Whole-second resolution — files must be ≥1 s apart for stat -c %Y to distinguish
  touch -d '2026-04-18 10:00:00' "$dir/$older.jsonl"
  touch -d '2026-04-18 10:00:02' "$dir/$newer.jsonl"

  local shim
  shim=$(with_fake_tool_bin stat "$BUSYBOX_STAT_BODY")
  SHIM_DIRS+=("$shim")

  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$newer.jsonl" ]]
}

@test "resolve does not crash when stat -f returns multi-line garbage" {
  # Regression for the busybox bug: stat -f exits 0 with multi-line output,
  # causing secs to capture a path fragment and set -u fires on unbound var.
  local uuid="cccc3333-3333-3333-3333-333333333333"
  local dir="$TEST_HOME/.claude/projects/-demo"
  mkdir -p "$dir"
  printf '{"cwd":"/x","sessionId":"%s"}\n' "$uuid" > "$dir/$uuid.jsonl"

  local shim
  shim=$(with_fake_tool_bin stat "$BUSYBOX_STAT_BODY")
  SHIM_DIRS+=("$shim")

  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$uuid.jsonl" ]]
}

@test "pick_newest returns a file gracefully when stat -c returns 0 for all" {
  # If all timestamps compare equal (frac_ms stays 0), pick_newest should still
  # return the last file seen rather than crashing or returning empty.
  local uuid="dddd4444-4444-4444-4444-444444444444"
  local dir="$TEST_HOME/.claude/projects/-demo"
  mkdir -p "$dir"
  printf '{"cwd":"/x","sessionId":"%s"}\n' "$uuid" > "$dir/$uuid.jsonl"

  # Shim that returns 0 for all stat -c calls (simulates timestamp unavailable)
  local shim
  shim=$(with_fake_tool_bin stat '
case "$1" in
  --version) printf "BusyBox v1.36.1 multi-call binary\n"; exit 0 ;;
  -f)        printf "  File: \"stub\"\n  Size: 0\n"; exit 0 ;;
  -c)        printf "0\n"; exit 0 ;;
  *)         exec /usr/bin/stat "$@" ;;
esac
')
  SHIM_DIRS+=("$shim")

  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$uuid.jsonl" ]]
}
