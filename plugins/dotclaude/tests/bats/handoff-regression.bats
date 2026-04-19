#!/usr/bin/env bats
# Regression seeds: each test locks in a bug previously fixed in the
# handoff scripts. Failing any of these means a fix has been lost.

load helpers

RESOLVE="$REPO_ROOT/plugins/dotclaude/scripts/handoff-resolve.sh"
EXTRACT="$REPO_ROOT/plugins/dotclaude/scripts/handoff-extract.sh"
HANDOFF_BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  [ -x "$EXTRACT" ] || chmod +x "$EXTRACT"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
}

teardown() {
  rm -rf "$TEST_HOME"
}

# -- pick_newest sub-second mtime regression -----------------------------

@test "pick_newest distinguishes files created within the same second" {
  # Bug: old `stat -c "%Y"` returned whole seconds, so `latest` was
  # non-deterministic for files created <1s apart. Fix moved to
  # `find -printf '%T@'` (GNU) / `stat -f '%Fm'` (BSD) with ms arithmetic.
  local dir="$TEST_HOME/.claude/projects/-regression"
  mkdir -p "$dir"
  local a="$dir/aaaa1111-1111-1111-1111-111111111111.jsonl"
  local b="$dir/bbbb2222-2222-2222-2222-222222222222.jsonl"
  printf '{"cwd":"/x","sessionId":"aaaa1111-1111-1111-1111-111111111111"}\n' > "$a"
  printf '{"cwd":"/x","sessionId":"bbbb2222-2222-2222-2222-222222222222"}\n' > "$b"
  # Force deterministic mtimes, 100 ms apart, same whole second.
  if touch -d '2026-04-18 12:00:00.100000000' "$a" 2>/dev/null; then
    touch -d '2026-04-18 12:00:00.500000000' "$b"
  else
    skip "GNU touch -d with fractional seconds unavailable"
  fi
  run "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
}

# -- jq streaming regression (no slurp) ----------------------------------

@test "meta_claude handles multi-record transcript without slurping" {
  # Bug: early version read the whole file with `[inputs]` (slurp) and
  # quadratic memory on long transcripts. Fix switched to
  # `first(inputs | select(...))` which stops at the first matching record.
  # This test only proves correctness on a moderate input — the ms
  # characteristic is covered in Phase 2/3 large-file tests.
  local uuid="cccc3333-3333-3333-3333-333333333333"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  # 1 cwd-bearing record followed by 100 noise records with no cwd.
  printf '{"cwd":"/real","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$file"
  for i in $(seq 1 100); do
    printf '{"type":"noise","n":%d}\n' "$i" >> "$file"
  done
  run "$EXTRACT" meta claude "$file"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cwd":"/real"'* ]]
  [[ "$output" == *"\"session_id\":\"$uuid\""* ]]
}

# -- word-split regression (paths with spaces) ---------------------------

@test "resolve tolerates session roots with spaces" {
  # Bug: a `for f in $(find ...)` in the alias-scan path would word-split
  # on spaces. Fix uses `while IFS= read -r`. A path with spaces in
  # $HOME must still resolve.
  export HOME="$TEST_HOME/home with spaces"
  mkdir -p "$HOME"
  make_claude_session_tree "$HOME" "dddd4444-4444-4444-4444-444444444444"
  run "$RESOLVE" claude dddd4444
  [ "$status" -eq 0 ]
  [[ "$output" == *"dddd4444-4444-4444-4444-444444444444.jsonl" ]]
}

# -- DOTCLAUDE_HANDOFF_REPO absolute path regression --------------------

@test "push accepts absolute-path DOTCLAUDE_HANDOFF_REPO (bare repo)" {
  # Bug: the URL allowlist originally required an explicit URL scheme
  # (https/git@/ssh://), rejecting local bare-repo paths used by tests
  # and by air-gapped setups. Fix added `/` and `file://` to the regex.
  local bare="$TEST_HOME/bare.git"
  make_transport_repo "$bare"
  # Seed a session so push has something to extract.
  make_claude_session_tree "$TEST_HOME" "eeee5555-5555-5555-5555-555555555555"
  DOTCLAUDE_HANDOFF_REPO="$bare" \
    run node "$HANDOFF_BIN" push eeee5555 --via git-fallback
  # The push path may fail later for unrelated reasons in a hermetic env
  # (no git user config etc.) — what we care about is that the URL
  # validator did NOT reject up-front. Accept exit 0 OR a non-URL-related
  # error as a pass.
  [[ "$status" -eq 0 || ( "$status" -ne 0 && "$output" != *"must be an https"* ) ]]
}

# -- grep-prefilter alias scan regression --------------------------------

@test "codex alias scan finds thread_name via grep-prefilter path" {
  # Bug: a naive implementation jq-parsed every rollout file even when
  # none contained the alias. Fix uses `grep -rl -F` to prefilter and
  # only jq-verifies candidates. This test proves the prefilter + verify
  # round trip still finds a match.
  local uuid="ffff6666-6666-6666-6666-666666666666"
  local path="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T12-00-00-${uuid}.jsonl"
  mkdir -p "$(dirname "$path")"
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/work"}}\n{"type":"event_msg","payload":{"thread_id":"%s","thread_name":"regression-target","type":"thread_renamed"}}\n' \
    "$uuid" "$uuid" > "$path"
  run "$RESOLVE" codex "regression-target"
  [ "$status" -eq 0 ]
  [ "$output" = "$path" ]
}
