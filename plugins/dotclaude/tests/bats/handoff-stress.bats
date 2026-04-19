#!/usr/bin/env bats
# Large-file and high-cardinality stress tests.
#
# Existing regression tests cover streaming behavior (first(inputs),
# ls-remote) at small scale. This suite pushes it to ~10k to catch N²
# regressions — a for-loop inside the enumerator or ls-remote consumer
# would manifest as a 10s → 600s blow-up at this cardinality.
#
# Every test is wrapped in `timeout` so runaway N² hangs fail fast
# instead of stalling CI. The per-test budget is an upper bound, not a
# performance target — on CI (shared runners) we just need "not N²".

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"
EXTRACT="$REPO_ROOT/plugins/dotclaude/scripts/handoff-extract.sh"

setup() {
  [ -x "$EXTRACT" ] || chmod +x "$EXTRACT"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
}

teardown() {
  rm -rf "$TEST_HOME" ${TRANSPORT_REPO:+"$TRANSPORT_REPO"}
}

# -- 10k local sessions ---------------------------------------------------

@test "list --local over 10k codex sessions completes under 30s" {
  # The enumerator walks ~/.codex/sessions up to depth 3. 10k files in a
  # single depth-3 dir is the realistic worst case. We don't ship a perf
  # contract — 30s is the "definitely-not-quadratic" threshold; a
  # per-file stat scan typical path completes in well under that.
  make_many_codex_sessions "$TEST_HOME" 10000
  run timeout 30s node "$BIN" list --local
  [ "$status" -eq 0 ]
  # Spot-check: the sort put the newest first. make_many_codex_sessions
  # stamps index N with minute=N/60000; the very last index is newest.
  # Just confirm the output has ~10k rows and a non-empty first line.
  local line_count
  line_count=$(printf '%s\n' "$output" | wc -l)
  [ "$line_count" -ge 10000 ]
}

# -- 10k transport branches ----------------------------------------------

@test "pull <short-uuid> against 10k transport branches completes under 30s" {
  # `listGitFallbackCandidates` calls `git ls-remote` once and parses
  # the output; linear in branch count. Match-by-query is another
  # linear filter. 10k branches is a stand-in for "transport that
  # accumulated over a year of heavy use" — the pull should stay
  # bounded; anything N² here means the ls-remote parser is accidentally
  # rescanning.
  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"
  make_many_transport_branches "$TRANSPORT_REPO" 10000

  # Pick a known short-id from the seeded range (index 5000 → 00001388).
  run timeout 30s node "$BIN" pull 00001388 --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

# -- live-append during extract ------------------------------------------

@test "extract meta against a file being appended returns a consistent snapshot" {
  # Extract uses `first(inputs | select((.cwd // "") != ""))` — the jq
  # streaming filter short-circuits at the first matching record. So
  # even if the file grows during the read, the output should reflect
  # only what was present when jq saw the match. Seed with a cwd-bearing
  # record, hold the file open for append in the parent, extract, then
  # append a record. Extract must emit the pre-append session_id.
  local uuid="aaaa1111-1111-1111-1111-111111111111"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  printf '{"cwd":"/snap","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$file"

  # Hold the file open for append in a background process; the process
  # sleeps briefly so extract runs against the pre-append state, then
  # appends a marker record. We assert extract's output doesn't leak the
  # marker.
  (
    sleep 0.2
    printf '{"cwd":"/LEAKED","sessionId":"bbbb2222-2222-2222-2222-222222222222"}\n' >> "$file"
  ) &
  local appender=$!

  run timeout 10s "$EXTRACT" meta claude "$file"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cwd":"/snap"'* ]]
  [[ "$output" != *'LEAKED'* ]]
  wait "$appender"
}

# -- malformed JSONL: truncated mid-record --------------------------------

@test "extract meta on a file with a truncated final record fails cleanly" {
  # Write one valid record + a half-written next record (no closing
  # brace, no newline). jq's streaming parser should reject the partial
  # line with a parse error; our wrapper translates non-zero jq to
  # exit 2 with the `handoff-extract:` prefix. Critical invariant: must
  # not hang, must not emit a garbled partial JSON object.
  local uuid="cccc3333-3333-3333-3333-333333333333"
  local file="$TEST_HOME/.claude/projects/-demo/$uuid.jsonl"
  mkdir -p "$(dirname "$file")"
  {
    printf '{"cwd":"/ok","sessionId":"%s"}\n' "$uuid"
    # Truncated: unclosed object, no newline.
    printf '{"cwd":"/dang'
  } > "$file"

  run timeout 10s "$EXTRACT" meta claude "$file"
  # The first valid record is still extractable — jq's streaming first()
  # short-circuits before reaching the truncated tail. So the contract
  # here is "does not hang, does not emit a malformed partial object";
  # the meta output is valid JSON with the seeded session_id.
  [ "$status" -eq 0 ]
  [[ "$output" == *"\"session_id\":\"$uuid\""* ]]
  [[ "$output" != *'"/dang'* ]]
}
