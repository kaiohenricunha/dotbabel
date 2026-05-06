#!/usr/bin/env bats
# End-to-end: `dotclaude handoff push` must refuse to clobber a remote
# branch whose `metadata.session_id` does not match the local session's.
# Issue #90 Gap 3 — force-push collision guardrail.
#
# The branch name includes an 8-hex-char short UUID prefix, so two sessions
# whose full UUIDs share those 8 chars (~32-bit birthday collision) would
# otherwise silently force-push over each other. The probe reads
# `metadata.json` on the existing remote branch and fails closed on
# mismatch unless `--force-collision` is passed.

load helpers

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

# Emits the short-ref name of the session's pushed branch, or empty if none.
handoff_branch_for() {
  local short_uuid="$1"
  git --git-dir="$TRANSPORT_REPO" for-each-ref \
    --format='%(refname:short)' \
    "refs/heads/handoff/*/claude/*/$short_uuid"
}

# Build a claude session file under $CLAUDE_DIR with the given full UUID.
# All sessions share the same cwd so their handoff branches collide.
seed_claude_session() {
  local uuid="$1"
  local file="$CLAUDE_DIR/$uuid.jsonl"
  cat > "$file" <<EOF
{"type":"user","cwd":"/home/u/collidedemo","sessionId":"$uuid","version":"2.1","message":{"content":"hello"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}
EOF
  echo "$file"
}

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  CLAUDE_DIR="$TEST_HOME/.claude/projects/-home-u-collidedemo"
  mkdir -p "$CLAUDE_DIR"

  # Two UUIDs that share the first 8 chars → same short_id → same branch.
  UUID_A="aaaa1111-1111-1111-1111-111111111111"
  UUID_B="aaaa1111-2222-2222-2222-222222222222"
  seed_claude_session "$UUID_A" >/dev/null
  seed_claude_session "$UUID_B" >/dev/null

  TRANSPORT_REPO=$(make_transport_repo "$(mktemp -d)")
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"
  export TEST_HOME CLAUDE_DIR TRANSPORT_REPO UUID_A UUID_B
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

@test "push: first push of a never-seen short-id succeeds (create mode)" {
  run node "$BIN" push "$UUID_A"
  [ "$status" -eq 0 ]
  local branch
  branch="$(handoff_branch_for aaaa1111)"
  [ -n "$branch" ]
  # Remote metadata.session_id must reflect the pushing session.
  run bash -c "git --git-dir='$TRANSPORT_REPO' show '$branch:metadata.json' | jq -r .session_id"
  [ "$status" -eq 0 ]
  [ "$output" = "$UUID_A" ]
}

@test "push: same-session repeat push succeeds (update mode, no collision)" {
  run node "$BIN" push "$UUID_A"
  [ "$status" -eq 0 ]
  local branch first_sha
  branch="$(handoff_branch_for aaaa1111)"
  [ -n "$branch" ]
  first_sha="$(git --git-dir="$TRANSPORT_REPO" rev-parse "$branch")"
  # Touch the session file so the next commit has a different tree.
  cat >> "$CLAUDE_DIR/$UUID_A.jsonl" <<EOF
{"type":"user","cwd":"/home/u/collidedemo","sessionId":"$UUID_A","message":{"content":"second turn"}}
EOF
  run node "$BIN" push "$UUID_A"
  [ "$status" -eq 0 ]
  # Remote still owned by session A.
  run bash -c "git --git-dir='$TRANSPORT_REPO' show '$branch:metadata.json' | jq -r .session_id"
  [ "$output" = "$UUID_A" ]
  # The branch must have advanced to a new commit.
  local second_sha
  second_sha="$(git --git-dir="$TRANSPORT_REPO" rev-parse "$branch")"
  [ "$first_sha" != "$second_sha" ]
}

@test "push: different session on same short-id is refused (exit 2)" {
  # Session A claims the short-id first.
  run node "$BIN" push "$UUID_A"
  [ "$status" -eq 0 ]
  # Session B tries to push on the colliding short-id. Must fail closed.
  run node "$BIN" push "$UUID_B"
  [ "$status" -eq 2 ]
  [[ "$output" == *"short-id collision"* ]]
  # Remote branch is untouched — still session A's metadata.
  local branch
  branch="$(handoff_branch_for aaaa1111)"
  [ -n "$branch" ]
  run bash -c "git --git-dir='$TRANSPORT_REPO' show '$branch:metadata.json' | jq -r .session_id"
  [ "$output" = "$UUID_A" ]
}

@test "push: --force-collision overrides the refusal and clobbers the branch" {
  run node "$BIN" push "$UUID_A"
  [ "$status" -eq 0 ]
  # Override; stderr must still warn so the user has an audit trail.
  run node "$BIN" push "$UUID_B" --force-collision
  [ "$status" -eq 0 ]
  [[ "$output" == *"short-id collision"* ]] || \
    [[ "$output" == *"forcing over"* ]] || \
    [[ "$output" == *"--force-collision"* ]]
  local branch
  branch="$(handoff_branch_for aaaa1111)"
  [ -n "$branch" ]
  # Remote is now session B's metadata.
  run bash -c "git --git-dir='$TRANSPORT_REPO' show '$branch:metadata.json' | jq -r .session_id"
  [ "$output" = "$UUID_B" ]
}

@test "push: legacy branch without metadata.json is treated as collision" {
  # Simulate a pre-metadata handoff branch: only handoff.md + description.txt.
  local work branch
  branch="handoff/collidedemo/claude/$(date -u +%Y-%m)/aaaa1111"
  work=$(mktemp -d)
  (
    cd "$work"
    git init -q -b "$branch"
    git config user.email "bats@example.test"
    git config user.name "bats"
    echo "legacy body" > handoff.md
    echo "handoff:v1:claude:aaaa1111:legacy" > description.txt
    git add handoff.md description.txt
    git commit -q -m "legacy seed"
    git push -q "$TRANSPORT_REPO" "HEAD:refs/heads/$branch"
  )
  rm -rf "$work"

  # Push from a real session should refuse — no metadata.json means no
  # proof of ownership, so we cannot prove it's safe to update.
  run node "$BIN" push "$UUID_A"
  [ "$status" -eq 2 ]
  [[ "$output" == *"collision"* ]]

  # --force-collision is the documented escape hatch for legacy branches.
  run node "$BIN" push "$UUID_A" --force-collision
  [ "$status" -eq 0 ]
}
