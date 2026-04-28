#!/usr/bin/env bats
# Behavior tests for the public surface of dotclaude-handoff.mjs (#87):
#
#   dotclaude handoff pull  [<id>] [--summary] [-o <path>] [--from <cli>]
#   dotclaude handoff fetch [<query>] [--from <cli>] [--verify]
#   dotclaude handoff push  [<query>] [--tag]
#   dotclaude handoff list
#
# Transport for push/fetch tests: a local bare repo named by
# DOTCLAUDE_HANDOFF_REPO. The git transport is the only remote
# transport since v0.9.0; no GitHub auth required.

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

  # Copilot fixture — seeded before the sleep so codex remains newest.
  mkdir -p "$TEST_HOME/.copilot/session-state/cccc3333-3333-3333-3333-333333333333"
  COPILOT_FILE="$TEST_HOME/.copilot/session-state/cccc3333-3333-3333-3333-333333333333/events.jsonl"
  cat > "$COPILOT_FILE" <<'EOF'
{"type":"session.start","data":{"sessionId":"cccc3333-3333-3333-3333-333333333333","cwd":"/work/copilot","model":"gpt-4o"}}
{"type":"user.message","data":{"content":"Implement the new feature"}}
{"type":"assistant.message","data":{"content":"Working on it now."}}
EOF

  # Codex fixture (seeded last, after sleep → newest on disk).
  sleep 0.01
  mkdir -p "$TEST_HOME/.codex/sessions/2026/04/18"
  CODEX_FILE="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T10-00-00-bbbb2222-2222-2222-2222-222222222222.jsonl"
  cat > "$CODEX_FILE" <<'EOF'
{"type":"session_meta","payload":{"id":"bbbb2222-2222-2222-2222-222222222222","cwd":"/work/demo","cli_version":"0.1"}}
{"type":"event_msg","payload":{"thread_name":"my-codex-task","type":"thread_renamed"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"ship the migration"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"running"}]}}
EOF

  # Set up a bare git repo as the remote transport endpoint.
  TRANSPORT_REPO=$(mktemp -d)
  rm -rf "$TRANSPORT_REPO"
  git init -q --bare "$TRANSPORT_REPO"
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  export CLAUDE_FILE COPILOT_FILE CODEX_FILE TRANSPORT_REPO
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

# -- help / zero-arg surface -----------------------------------------------

@test "--help prints pull fetch and list" {
  run node "$BIN" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"push"* ]]
  [[ "$output" == *"pull"* ]]
  [[ "$output" == *"fetch"* ]]
  [[ "$output" == *"list"* ]]
}

# -- pull: local resolution -----------------------------------------------

@test "pull: short UUID produces <handoff> block locally" {
  run node "$BIN" pull aaaa1111
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"</handoff>"* ]]
}

@test "pull: customTitle alias produces <handoff> block" {
  run node "$BIN" pull my-feature
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"aaaa1111"* ]]
}

@test "pull: codex thread_name alias produces <handoff> block" {
  run node "$BIN" pull my-codex-task
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
  [[ "$output" == *"bbbb2222"* ]]
}

@test "pull: unknown identifier exits 2" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    node "$BIN" pull nonexistent-xyz
  [ "$status" -eq 2 ]
}

# -- pull `latest` host-scoping (#85) ------------------------------------

@test "pull latest without host signal picks globally newest (across roots)" {
  # setup() sleeps between fixtures so the codex file is newer. No host
  # signal → cross-root winner = codex/bbbb2222.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    node "$BIN" pull latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$stderr" == *"host not detected"* ]]
}

@test "pull latest with CLAUDECODE=1 narrows to claude root" {
  # The outer-shell probe fires; `latest` must resolve within ~/.claude
  # only, so aaaa1111 wins even though the codex fixture is newer on disk.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" CLAUDECODE=1 \
    node "$BIN" pull latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" != *"bbbb2222"* ]]
  [[ "$stderr" == *"latest claude session"* ]]
  [[ "$stderr" == *"aaaa1111"* ]]
}

@test "pull latest --from codex overrides host detection" {
  # --from must outrank detectedHost, mirroring push's precedence.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" CLAUDECODE=1 \
    node "$BIN" pull latest --from codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" != *"aaaa1111"* ]]
  [[ "$stderr" == *"--from codex"* ]]
}

@test "pull latest --from with unknown cli exits 64" {
  run node "$BIN" pull latest --from bogus
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from must be one of"* ]]
}

@test "pull non-latest: host detection does NOT narrow (UUID lookup stays global)" {
  # A short-UUID is unambiguous — narrowing by host would hide a valid
  # cross-agent match. CLAUDECODE=1 must not prevent bbbb2222 lookup.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" CLAUDECODE=1 \
    node "$BIN" pull bbbb2222
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
}

@test "pull: collision across CLIs on non-TTY stdin exits 2 with candidate list" {
  # Introduce collision: claude customTitle "both" + codex thread_name "both"
  printf '{"type":"custom-title","customTitle":"both","sessionId":"aaaa1111-1111-1111-1111-111111111111"}\n' \
    >> "$CLAUDE_FILE"
  printf '{"type":"event_msg","payload":{"thread_name":"both","type":"thread_renamed"}}\n' \
    >> "$CODEX_FILE"
  run node "$BIN" pull both </dev/null
  [ "$status" -eq 2 ]
  [[ "$output" == *"claude"* ]]
  [[ "$output" == *"codex"* ]]
}

# -- pull: no-match hint for remote handoffs (#87) ------------------------

@test "pull <unmatched> with DOTCLAUDE_HANDOFF_REPO set appends fetch hint" {
  run --separate-stderr node "$BIN" pull nonexistent-tag
  [ "$status" -eq 2 ]
  # DOTCLAUDE_HANDOFF_REPO is set in setup(); hint must surface.
  [[ "$stderr" == *"fetch"* ]]
}

@test "pull <unmatched> without DOTCLAUDE_HANDOFF_REPO emits no fetch hint" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    node "$BIN" pull nonexistent-tag
  [ "$status" -eq 2 ]
  [[ "$stderr" != *"fetch <id>"* ]]
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

# -- push (remote git transport) -----------------------------------------

@test "push <query> uploads to remote (v2 branch shape)" {
  run node "$BIN" push my-feature
  [ "$status" -eq 0 ]
  run bash -c "git --git-dir='$TRANSPORT_REPO' branch -a"
  [ "$status" -eq 0 ]
  [[ "$output" =~ handoff/demo/claude/[0-9]{4}-[0-9]{2}/aaaa1111 ]]
}

@test "push --tag label embeds tag in the transport description" {
  run node "$BIN" push my-feature --tag finishing-auth
  [ "$status" -eq 0 ]
  run bash -c "git --git-dir='$TRANSPORT_REPO' for-each-ref --format='%(refname:short)' 'refs/heads/handoff/demo/claude/*/aaaa1111'"
  [ "$status" -eq 0 ]
  branch="$output"
  run bash -c "git --git-dir='$TRANSPORT_REPO' log --format=%s $branch"
  [ "$status" -eq 0 ]
  [[ "$output" == *"finishing-auth"* ]]
}

@test "push (zero-arg, no --from) exits 64 — §5.5.2 mandatory --from" {
  run --separate-stderr node "$BIN" push
  [ "$status" -eq 64 ]
  [[ "$stderr" == *"requires --from"* ]]
}

# -- fetch (remote git transport, formerly `pull`) -----------------------

@test "fetch <tag-substring> fetches by tag match" {
  run node "$BIN" push my-feature --tag finishing-auth
  [ "$status" -eq 0 ]
  run node "$BIN" fetch finishing-auth
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "fetch <short-uuid> fetches by short UUID match" {
  run node "$BIN" push my-feature
  [ "$status" -eq 0 ]
  run node "$BIN" fetch aaaa1111
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "fetch (zero-arg) fetches the latest" {
  run node "$BIN" push my-feature --tag keepme
  [ "$status" -eq 0 ]
  run node "$BIN" fetch
  [ "$status" -eq 0 ]
  [[ "$output" == *"<handoff"* ]]
}

@test "fetch <tag>: exact-tag match wins over substring (#91 Gap 7)" {
  # Two branches with overlapping tag substrings: "alpha" and "alpha-beta".
  # Pre-Gap-7, `fetch alpha` would substring-match both and exit 2 with a
  # collision. Post-Gap-7, exact-tag pre-pass resolves to the `alpha` branch.
  run node "$BIN" push my-feature --tag alpha
  [ "$status" -eq 0 ]
  run node "$BIN" push my-codex-task --tag alpha-beta
  [ "$status" -eq 0 ]
  run node "$BIN" fetch alpha </dev/null
  [ "$status" -eq 0 ]
}

@test "fetch collision on non-TTY exits 2 when substring matches both descriptions" {
  # `my-feature` substring appears in two distinct branch descriptions
  # (one for the claude session, one for the codex session). With no
  # exact-tag match available, the resolver falls back to substring and
  # surfaces both candidates as a collision.
  run node "$BIN" push my-feature
  [ "$status" -eq 0 ]
  run node "$BIN" push my-codex-task
  [ "$status" -eq 0 ]
  run node "$BIN" fetch demo </dev/null
  [ "$status" -eq 2 ]
  [[ "$output" =~ handoff/demo/(claude|codex)/ ]]
}

# -- back-compat removal: no <cli> positional allowed --------------------

@test "<cli>-positional form is rejected (<cli> <id> no longer accepted)" {
  run node "$BIN" claude aaaa1111
  # "claude" is not a valid subcommand and not a query (no such alias),
  # so it must exit 2 (no session matches) — NOT 0.
  [ "$status" -ne 0 ]
}

# -- --from flag ----------------------------------------------------------

@test "push --from codex (no query) narrows the fallback to the codex root" {
  run env -i HOME="$TEST_HOME" PATH="$PATH" DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO" \
    node "$BIN" push --from codex
  [ "$status" -eq 0 ]
  run git --git-dir="$TRANSPORT_REPO" branch -a
  [[ "$output" =~ handoff/demo/codex/[0-9]{4}-[0-9]{2}/bbbb2222 ]]
}

@test "push --from with an unknown CLI exits 64" {
  run node "$BIN" push --from bogus
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from must be one of"* ]]
}

@test "pull --from codex narrows to local codex session" {
  # `pull --from codex` resolves locally; bbbb2222 is the only codex session.
  run node "$BIN" pull --from codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" != *"aaaa1111"* ]]
}

@test "pull --from with an unknown CLI exits 64" {
  run node "$BIN" pull --from bogus
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from must be one of"* ]]
}

@test "fetch --from codex narrows the remote candidate pool" {
  # Push one handoff per CLI, then fetch with --from codex and confirm
  # the returned block names the codex session (bbbb2222), not the
  # claude one (aaaa1111). Proves --from is wired through pullRemote.
  run node "$BIN" push my-feature
  [ "$status" -eq 0 ]
  run node "$BIN" push my-codex-task
  [ "$status" -eq 0 ]
  run node "$BIN" fetch --from codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" != *"aaaa1111"* ]]
}

@test "push --from codex beats CLAUDECODE=1 (override precedence)" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO" CLAUDECODE=1 \
    node "$BIN" push --from codex
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"using --from codex override"* ]]
  run git --git-dir="$TRANSPORT_REPO" branch -a
  [[ "$output" =~ handoff/demo/codex/[0-9]{4}-[0-9]{2}/bbbb2222 ]]
}

# -- honest stderr fallback notes ----------------------------------------

@test "push (no args, no host signal) exits 64 — §5.5.2 mandatory --from" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO" \
    node "$BIN" push
  [ "$status" -eq 64 ]
  [[ "$stderr" == *"requires --from"* ]]
}

@test "push (no args, CLAUDECODE=1) exits 64 — §5.5.2 mandatory --from" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO" CLAUDECODE=1 \
    node "$BIN" push
  [ "$status" -eq 64 ]
  [[ "$stderr" == *"requires --from"* ]]
}

# -- cross-agent regression tests (#87) ----------------------------------
# These lock in the invariants described in SKILL.md for all three hosts.

@test "pull copilot session under CLAUDECODE=1 resolves globally and targets claude" {
  # resolveAny finds cccc3333 in the copilot root.
  # CLAUDECODE=1 → detected host = claude → next-step uses claude wording.
  # The Claude-tuned next-step hint must appear in the block.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" CLAUDECODE=1 \
    node "$BIN" pull cccc3333
  [ "$status" -eq 0 ]
  [[ "$output" == *"copilot"* ]]
  [[ "$output" == *"Continue from"* ]]
}

@test "pull zero-arg under CODEX_HOME narrows to codex root" {
  # CODEX_HOME triggers the CODEX_* env-var probe, returning "codex" from
  # detectHost(). Host-scoped `latest` then narrows to the codex root.
  # bbbb2222 is the newest codex session (seeded last in setup).
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" CODEX_HOME="/any/path" \
    node "$BIN" pull
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" != *"aaaa1111"* ]]
  [[ "$stderr" == *"latest codex session"* ]]
  [[ "$stderr" == *"bbbb2222"* ]]
}

@test "pull --from copilot under CLAUDECODE=1: source narrows, next-step uses detected host" {
  # --from narrows the local resolver to the copilot root.
  # CLAUDECODE=1 makes the detected host claude.
  # Next-step wording reflects the detected host (claude), not --from.
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" CLAUDECODE=1 \
    node "$BIN" pull cccc3333 --from copilot
  [ "$status" -eq 0 ]
  [[ "$output" == *"copilot"* ]]
  [[ "$output" == *"Continue from"* ]]
}

# -- --via flag removal (v0.9.0 breaking change) -------------------------

@test "--via with any value exits 64 (gist transport removed)" {
  run node "$BIN" push --via github
  [ "$status" -eq 64 ]
  [[ "$output" == *"--via"* ]]

  run node "$BIN" push --via git-fallback
  [ "$status" -eq 64 ]
  [[ "$output" == *"--via"* ]]

  run node "$BIN" pull --via github
  [ "$status" -eq 64 ]
  [[ "$output" == *"--via"* ]]
}
