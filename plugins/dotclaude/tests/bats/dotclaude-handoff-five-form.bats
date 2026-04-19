#!/usr/bin/env bats
# Behavior tests for the five-form public surface of dotclaude-handoff.mjs:
#
#   dotclaude handoff                          # push host's current session
#   dotclaude handoff <query>                  # local cross-agent: <handoff> block
#   dotclaude handoff push [<query>] [--tag]   # explicit push
#   dotclaude handoff pull  [<query>]          # pull by fuzzy match; bare = latest
#   dotclaude handoff list                     # unified local + remote table
#
# Transport for push/pull tests: `--via git-fallback` against a local
# bare repo (DOTCLAUDE_HANDOFF_REPO). No GitHub auth required.

load helpers

bats_require_minimum_version 1.5.0

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Claude fixture: a real-looking session with customTitle + content.
  mkdir -p "$TEST_HOME/.claude/projects/-home-u-demo"
  CLAUDE_FILE="$TEST_HOME/.claude/projects/-home-u-demo/aaaa1111-1111-1111-1111-111111111111.jsonl"
  cat > "$CLAUDE_FILE" <<'EOF'
{"type":"user","cwd":"/home/u/demo","sessionId":"aaaa1111-1111-1111-1111-111111111111","version":"2.1","message":{"content":"Fix the retry loop"}}
{"type":"user","cwd":"/home/u/demo","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"Run the suite"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"OK running now."}]}}
{"type":"custom-title","customTitle":"my-feature","sessionId":"aaaa1111-1111-1111-1111-111111111111"}
EOF

  # Codex fixture: a rollout renamed to "refactor" (for collision with claude below)
  sleep 0.01
  mkdir -p "$TEST_HOME/.codex/sessions/2026/04/18"
  CODEX_FILE="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T10-00-00-bbbb2222-2222-2222-2222-222222222222.jsonl"
  cat > "$CODEX_FILE" <<'EOF'
{"type":"session_meta","payload":{"id":"bbbb2222-2222-2222-2222-222222222222","cwd":"/work/demo","cli_version":"0.1"}}
{"type":"event_msg","payload":{"thread_name":"my-codex-task","type":"thread_renamed"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"ship the migration"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"running"}]}}
EOF

  # Set up a bare git repo as the git-fallback transport endpoint.
  # Push/pull tests use `--via git-fallback` which doesn't need GitHub auth.
  TRANSPORT_REPO=$(mktemp -d)
  rm -rf "$TRANSPORT_REPO"
  git init -q --bare "$TRANSPORT_REPO"
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  export CLAUDE_FILE CODEX_FILE TRANSPORT_REPO
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

# -- zero-arg and <query> (local, no network) ----------------------------

@test "--help prints the five-form surface" {
  # Bare invocation no longer prints usage — it executes `push`. Help
  # lives behind --help, which is the conventional opt-in.
  run node "$BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"push"* ]]
  [[ "$output" == *"pull"* ]]
  [[ "$output" == *"list"* ]]
}

@test "<query>: short UUID produces <handoff> block locally" {
  run node "$BIN" aaaa1111
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"</handoff>"* ]]
}

@test "<query>: customTitle alias produces <handoff> block" {
  run node "$BIN" my-feature
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"aaaa1111"* ]]
}

@test "<query>: codex thread_name alias produces <handoff> block" {
  run node "$BIN" my-codex-task
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"bbbb2222"* ]]
}

@test "<query>: unknown identifier exits 2" {
  run node "$BIN" nonexistent-xyz
  [ "$status" -eq 2 ]
}

@test "<query>: collision across CLIs on non-TTY stdin exits 2 with candidate list" {
  # Introduce collision: claude customTitle "both" + codex thread_name "both"
  printf '{"type":"custom-title","customTitle":"both","sessionId":"aaaa1111-1111-1111-1111-111111111111"}\n' \
    >> "$CLAUDE_FILE"
  printf '{"type":"event_msg","payload":{"thread_name":"both","type":"thread_renamed"}}\n' \
    >> "$CODEX_FILE"
  run node "$BIN" both </dev/null
  [ "$status" -eq 2 ]
  [[ "$output" == *"claude"* ]]
  [[ "$output" == *"codex"* ]]
}

# -- list (unified + filters) --------------------------------------------

@test "list: default shows a Location column and both local roots" {
  run node "$BIN" list </dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"Location"* ]]
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" == *"bbbb2222"* ]]
}

@test "list --local filters to local sessions only" {
  run node "$BIN" list --local
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  # No remote/gist content:
  [[ "$output" != *"gist.github"* ]]
}

# -- push (git-fallback transport) ---------------------------------------

@test "push <query> uploads to transport (git-fallback bare repo)" {
  run node "$BIN" push my-feature --via git-fallback
  [ "$status" -eq 0 ]
  # Confirm the transport repo has the new branch.
  run bash -c "git --git-dir='$TRANSPORT_REPO' branch -a"
  [ "$status" -eq 0 ]
  [[ "$output" == *"handoff/claude/aaaa1111"* ]]
}

@test "push --tag label embeds tag in the transport description" {
  run node "$BIN" push my-feature --via git-fallback --tag finishing-auth
  [ "$status" -eq 0 ]
  # The description line includes the tag (commit message carries it).
  run bash -c "git --git-dir='$TRANSPORT_REPO' log --format=%s handoff/claude/aaaa1111"
  [ "$status" -eq 0 ]
  [[ "$output" == *"finishing-auth"* ]]
}

@test "push (zero-arg) pushes host's latest session" {
  run node "$BIN" push --via git-fallback
  [ "$status" -eq 0 ]
  run bash -c "git --git-dir='$TRANSPORT_REPO' branch -a"
  [[ "$output" == *"handoff/"* ]]
}

# -- pull (fuzzy match across description fields) ------------------------

@test "pull <tag-substring> fetches by tag match" {
  # First push with a tag, then try to pull by that tag.
  run node "$BIN" push my-feature --via git-fallback --tag finishing-auth
  [ "$status" -eq 0 ]
  run node "$BIN" pull finishing-auth --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "pull <short-uuid> fetches by short UUID match" {
  run node "$BIN" push my-feature --via git-fallback
  [ "$status" -eq 0 ]
  run node "$BIN" pull aaaa1111 --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "pull (zero-arg) fetches the latest" {
  run node "$BIN" push my-feature --via git-fallback --tag keepme
  [ "$status" -eq 0 ]
  run node "$BIN" pull --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "pull collision on non-TTY exits 2 with candidate list" {
  run node "$BIN" push my-feature --via git-fallback --tag alpha
  [ "$status" -eq 0 ]
  run node "$BIN" push my-codex-task --via git-fallback --tag alpha-beta
  [ "$status" -eq 0 ]
  run node "$BIN" pull alpha --via git-fallback </dev/null
  [ "$status" -eq 2 ]
  [[ "$output" == *"handoff/claude/aaaa1111"* ]] || [[ "$output" == *"handoff/codex/bbbb2222"* ]]
}

# -- back-compat removal: no <cli> positional allowed --------------------

@test "<cli>-positional form is rejected (<cli> <id> no longer accepted)" {
  run node "$BIN" claude aaaa1111
  # "claude" is not a valid subcommand and not a query (no such alias),
  # so it must exit 2 (no session matches) — NOT 0.
  [ "$status" -ne 0 ]
}

@test "push <cli> <query> exits 64 with the breaking-change message" {
  # The shim catches the removed form and points the user at --from
  # or dropping the positional entirely.
  run node "$BIN" push claude aaaa1111
  [ "$status" -eq 64 ]
  [[ "$output" == *"no longer takes a <cli> positional"* ]]
  [[ "$output" == *"--from claude"* ]]
}

@test "pull <cli> <query> exits 64 with the breaking-change message" {
  # Mirror of the push shim — the parallel surface keeps parallel errors.
  run node "$BIN" pull claude aaaa1111
  [ "$status" -eq 64 ]
  [[ "$output" == *"no longer takes a <cli> positional"* ]]
  [[ "$output" == *"--from claude"* ]]
}

# -- --from flag ----------------------------------------------------------

@test "push --from codex (no query) narrows the fallback to the codex root" {
  # With env cleared (no host detected), --from steers the fallback away
  # from `resolveAny("latest")` (union) to the codex-only "latest".
  # setup() seeds codex with bbbb2222 as the newest of its root.
  run env -i HOME="$TEST_HOME" PATH="$PATH" DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO" \
    node "$BIN" push --from codex --via git-fallback
  [ "$status" -eq 0 ]
  run bash -c "git --git-dir='$TRANSPORT_REPO' branch -a"
  [[ "$output" == *"handoff/codex/bbbb2222"* ]]
}

@test "push --from with an unknown CLI exits 64" {
  run node "$BIN" push --from bogus --via git-fallback
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from must be one of"* ]]
}

@test "pull --from codex narrows the transport candidate pool" {
  # Push one handoff per CLI, then pull with --from codex and confirm
  # the returned block names the codex session (bbbb2222), not the
  # claude one (aaaa1111). Proves --from is wired through pullGitFallback.
  run node "$BIN" push my-feature --via git-fallback
  [ "$status" -eq 0 ]
  run node "$BIN" push my-codex-task --via git-fallback
  [ "$status" -eq 0 ]
  run node "$BIN" pull --from codex --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" != *"aaaa1111"* ]]
}

@test "pull --from with an unknown CLI exits 64" {
  run node "$BIN" pull --from bogus --via git-fallback
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from must be one of"* ]]
}

@test "push --from codex beats CLAUDECODE=1 (override precedence)" {
  # --from is an explicit user intent and must outrank the env-var
  # probe. Without this assertion, a regression swapping the precedence
  # of `fromCli ?? detectedHost` would silently mis-route a user who
  # explicitly asked for codex from inside a Claude Code session.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO" CLAUDECODE=1 \
    node "$BIN" push --from codex --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"using --from codex override"* ]]
  run bash -c "git --git-dir='$TRANSPORT_REPO' branch -a"
  [[ "$output" == *"handoff/codex/bbbb2222"* ]]
}

# -- honest stderr fallback notes ----------------------------------------

@test "push (no args, no host signal) emits stderr note about unknown host" {
  # env -i clears CLAUDECODE / CODEX_* / COPILOT_* leaking from the
  # parent shell, so detectHost() returns "unknown" and the bare-push
  # path uses the union resolver with the matching stderr note.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO" \
    node "$BIN" push --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"host not detected"* ]]
  [[ "$stderr" == *"latest across all clis"* ]]
}

@test "push (no args, CLAUDECODE=1) emits stderr note about claude" {
  # The claude probe fires, so the fallback narrows to the claude root.
  # The seeded claude session (aaaa1111) is the only one under that
  # root, so its short-UUID must surface in the stderr note.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO" CLAUDECODE=1 \
    node "$BIN" push --via git-fallback
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"latest claude session"* ]]
  [[ "$stderr" == *"aaaa1111"* ]]
}
