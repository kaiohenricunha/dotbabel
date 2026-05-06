#!/usr/bin/env bats
# End-to-end: `dotbabel handoff push` must scrub the digest before writing
# it to the remote. Ensures parity with the skill-driven github path, which
# has always scrubbed via handoff-scrub.sh. Issue #90 Gap 1.
#
# Exercises the real `pushRemote` against a local bare repo — no network.

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-handoff.mjs"
SCRUB="$REPO_ROOT/plugins/dotbabel/scripts/handoff-scrub.sh"
BAIT_GH_TOKEN="ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"

# Emits the short-ref name of the session's pushed branch, or empty if none.
# Call against $TRANSPORT_REPO. Scoped by short-UUID suffix.
handoff_branch_for() {
  local short_uuid="$1"
  git --git-dir="$TRANSPORT_REPO" for-each-ref \
    --format='%(refname:short)' \
    "refs/heads/handoff/*/claude/*/$short_uuid"
}

# Parses the `[scrubbed N secrets]` line from `$output` into a bare integer.
# Assumes the state line is the fourth line of `push` stdout.
scrub_count_from_output() {
  printf '%s\n' "$output" | sed -n '4p' | sed -E 's/^\[scrubbed ([0-9]+) secrets\]$/\1/'
}

setup() {
  [ -x "$SCRUB" ] || chmod +x "$SCRUB"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Seed a Claude session whose prompts carry a bait GitHub token. The
  # digest renderer pulls prompts straight out, so the token lands in
  # handoff.md unless pushRemote() scrubs first.
  CLAUDE_UUID="aaaa1111-1111-1111-1111-111111111111"
  CLAUDE_DIR="$TEST_HOME/.claude/projects/-home-u-scrubdemo"
  mkdir -p "$CLAUDE_DIR"
  CLAUDE_FILE="$CLAUDE_DIR/$CLAUDE_UUID.jsonl"
  cat > "$CLAUDE_FILE" <<EOF
{"type":"user","cwd":"/home/u/scrubdemo","sessionId":"$CLAUDE_UUID","version":"2.1","message":{"content":"deploy with $BAIT_GH_TOKEN"}}
{"type":"user","cwd":"/home/u/scrubdemo","sessionId":"$CLAUDE_UUID","message":{"content":"second prompt"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
EOF

  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTBABEL_HANDOFF_REPO="$TRANSPORT_REPO"
  export CLAUDE_UUID CLAUDE_FILE TRANSPORT_REPO BAIT_GH_TOKEN
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

@test "push: stdout emits [scrubbed N secrets] as a fourth line" {
  run node "$BIN" push aaaa1111
  [ "$status" -eq 0 ]
  local fourth
  fourth="$(printf '%s\n' "$output" | sed -n '4p')"
  [[ "$fourth" =~ ^\[scrubbed\ [0-9]+\ secrets\]$ ]]
  # Seeded one bait token → count must be at least 1.
  local count
  count="$(scrub_count_from_output)"
  [ "$count" -ge 1 ]
}

@test "push: pushed handoff.md does not contain the bait token" {
  run node "$BIN" push aaaa1111
  [ "$status" -eq 0 ]
  local branch
  branch="$(handoff_branch_for aaaa1111)"
  [ -n "$branch" ]
  run git --git-dir="$TRANSPORT_REPO" show "$branch:handoff.md"
  [ "$status" -eq 0 ]
  [[ "$output" != *"$BAIT_GH_TOKEN"* ]]
  [[ "$output" == *"<redacted:github-token>"* ]]
}

@test "push: metadata.json.scrubbed_count matches the stdout count" {
  run node "$BIN" push aaaa1111
  [ "$status" -eq 0 ]
  local count_stdout branch
  count_stdout="$(scrub_count_from_output)"
  branch="$(handoff_branch_for aaaa1111)"

  run bash -c "git --git-dir='$TRANSPORT_REPO' show '$branch:metadata.json' | jq -r .scrubbed_count"
  [ "$status" -eq 0 ]
  [ "$output" = "$count_stdout" ]
}

@test "push: clean session records scrubbed_count 0, stdout says [scrubbed 0 secrets]" {
  # Overwrite the session with a token-free payload. Scrubber runs but finds nothing.
  cat > "$CLAUDE_FILE" <<EOF
{"type":"user","cwd":"/home/u/scrubdemo","sessionId":"$CLAUDE_UUID","version":"2.1","message":{"content":"plain prose no secrets"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
EOF
  run node "$BIN" push aaaa1111
  [ "$status" -eq 0 ]
  local fourth
  fourth="$(printf '%s\n' "$output" | sed -n '4p')"
  [ "$fourth" = "[scrubbed 0 secrets]" ]
}

@test "push: fail-closed when scrubber is missing (no branch written)" {
  # Temporarily rename the real scrubber so the module's existsSync check
  # trips. This is the fail-closed baseline: if the scrubber cannot run,
  # the push must not commit anything to the remote.
  local backup="$SCRUB.bak.$$"
  mv "$SCRUB" "$backup"

  run node "$BIN" push aaaa1111
  local push_status="$status"
  local push_output="$output"

  # Restore before any assertion can short-circuit the test.
  mv "$backup" "$SCRUB"

  [ "$push_status" -eq 2 ]
  [[ "$push_output" == *"stage:  scrub"* ]]

  # Remote must carry no branch for this session.
  local branch
  branch="$(handoff_branch_for aaaa1111)"
  [ -z "$branch" ]
}
