#!/usr/bin/env bats
# Portability tests for handoff-resolve (GNU primary path) and handoff-extract.
# pick_newest now uses a probe-once approach (_STAT_FLAVOR) rather than a
# runtime fallback chain; busybox substrate coverage lives in
# handoff-resolve-busybox.bats.

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
  # Verifies the gnu probe path: on a GNU/Linux system _STAT_FLAVOR=gnu and
  # pick_newest uses find -printf %T@ for fractional-ms resolution.
  local older="aaaa1111-1111-1111-1111-111111111111"
  local newer="bbbb2222-2222-2222-2222-222222222222"
  seed_fractional_pair "$older" "$newer"
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
