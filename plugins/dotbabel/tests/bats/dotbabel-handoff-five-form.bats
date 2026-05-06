#!/usr/bin/env bats
# Behavior tests for the public surface of dotbabel-handoff.mjs (#87):
#
#   dotbabel handoff pull  [<id>] [--summary] [-o <path>] [--from <cli>]
#   dotbabel handoff fetch [<query>] [--from <cli>] [--verify]
#   dotbabel handoff push  [<query>] [--tag]
#   dotbabel handoff list
#
# Transport for push/fetch tests: a local bare repo named by
# DOTBABEL_HANDOFF_REPO. The git transport is the only remote
# transport since v0.9.0; no GitHub auth required.

load helpers

bats_require_minimum_version 1.5.0

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-handoff.mjs"

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
  export DOTBABEL_HANDOFF_REPO="$TRANSPORT_REPO"

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

@test "pull Latest (mixed case) under CLAUDECODE=1 narrows to claude root" {
  # The resolver case-folds the `latest` keyword (Decision 2). The wrapper's
  # host-scope dispatch must do the same — otherwise mixed-case `Latest`
  # bypasses resolveLatestWithHostScope and falls through to `any Latest`,
  # which case-folds at the resolver layer and returns the cross-root newest
  # (codex here, not the host-scoped claude).
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" CLAUDECODE=1 \
    node "$BIN" pull Latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]]
  [[ "$output" != *"bbbb2222"* ]]
  [[ "$stderr" == *"latest claude session"* ]]
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

@test "pull (no --from): wrapper passes through intra-CLI claude customTitle collision verbatim" {
  # 2 distinct claude sessions sharing customTitle. Wrapper path:
  # resolveLocalForPull(narrowTo=null) → resolveAny → parseCollisionAndDispatch
  # → non-TTY stderr passthrough. Verifies the resolveAny aggregation wires
  # correctly from per-CLI single-hit emits into a 2-row collision TSV.
  local uuid1="aaaa4444-4444-4444-4444-444444444444"
  local uuid2="aaaa5555-5555-5555-5555-555555555555"
  local dir1="$TEST_HOME/.claude/projects/-home-u-collide1"
  local dir2="$TEST_HOME/.claude/projects/-home-u-collide2"
  mkdir -p "$dir1" "$dir2"
  local path1="$dir1/$uuid1.jsonl"
  local path2="$dir2/$uuid2.jsonl"
  printf '{"type":"user","cwd":"/c1","sessionId":"%s","version":"2.1","message":{"content":"hi"}}\n' "$uuid1" > "$path1"
  set_claude_custom_title "$path1" "$uuid1" "shared-title"
  printf '{"type":"user","cwd":"/c2","sessionId":"%s","version":"2.1","message":{"content":"hi"}}\n' "$uuid2" > "$path2"
  set_claude_custom_title "$path2" "$uuid2" "shared-title"

  run --separate-stderr node "$BIN" pull "shared-title" </dev/null
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == *"multiple sessions match"* ]]
  [[ "$stderr" == *"$path1"* ]]
  [[ "$stderr" == *"$path2"* ]]
  local row_count
  row_count=$(echo "$stderr" | grep -c $'\t'"customTitle"$)
  [ "$row_count" -eq 2 ]
}

@test "pull --from copilot: wrapper passes through intra-CLI copilot name collision verbatim" {
  # 2 distinct copilot sessions sharing workspace.yaml:name. Wrapper path:
  # resolveLocalForPull(narrowTo="copilot") → resolveNarrowed → per-CLI
  # emit_collision_tsv → parseCollisionAndDispatch → stderr passthrough.
  # Verifies resolveNarrowed's collision-aware extension from Step 3 (3).
  local uuid1="cccc4444-4444-4444-4444-444444444444"
  local uuid2="cccc5555-5555-5555-5555-555555555555"
  make_copilot_session_tree "$TEST_HOME" "$uuid1"
  make_copilot_session_tree "$TEST_HOME" "$uuid2"
  set_copilot_workspace_name "$TEST_HOME" "$uuid1" "shared-name"
  set_copilot_workspace_name "$TEST_HOME" "$uuid2" "shared-name"
  local path1="$TEST_HOME/.copilot/session-state/$uuid1/events.jsonl"
  local path2="$TEST_HOME/.copilot/session-state/$uuid2/events.jsonl"

  run --separate-stderr node "$BIN" pull "shared-name" --from copilot </dev/null
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == *"multiple sessions match"* ]]
  [[ "$stderr" == *"$path1"* ]]
  [[ "$stderr" == *"$path2"* ]]
  local row_count
  row_count=$(echo "$stderr" | grep -c $'\t'"name"$)
  [ "$row_count" -eq 2 ]
}

@test "pull (no --from): wrapper passes through cross-CLI claude+copilot collision verbatim" {
  # 1 claude + 1 copilot sharing alias value across distinct alias mechanisms.
  # Wrapper path: resolveLocalForPull(narrowTo=null) → resolveAny → cross-CLI
  # aggregation → 5-col TSV with mixed matched-field rows. Each row carries
  # the per-CLI matched-field tag — disambiguation preserved end-to-end.
  local claude_uuid="aaaa6666-6666-6666-6666-666666666666"
  local copilot_uuid="cccc6666-6666-6666-6666-666666666666"
  local claude_dir="$TEST_HOME/.claude/projects/-home-u-cross"
  mkdir -p "$claude_dir"
  local claude_path="$claude_dir/$claude_uuid.jsonl"
  printf '{"type":"user","cwd":"/cross","sessionId":"%s","version":"2.1","message":{"content":"hi"}}\n' "$claude_uuid" > "$claude_path"
  set_claude_custom_title "$claude_path" "$claude_uuid" "shared-cross-cli"

  make_copilot_session_tree "$TEST_HOME" "$copilot_uuid"
  set_copilot_workspace_name "$TEST_HOME" "$copilot_uuid" "shared-cross-cli"
  local copilot_path="$TEST_HOME/.copilot/session-state/$copilot_uuid/events.jsonl"

  run --separate-stderr node "$BIN" pull "shared-cross-cli" </dev/null
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == *"multiple sessions match"* ]]
  [[ "$stderr" == *"$claude_path"* ]]
  [[ "$stderr" == *"$copilot_path"* ]]
  local claude_rows
  claude_rows=$(echo "$stderr" | grep -c $'\t'"customTitle"$)
  [ "$claude_rows" -eq 1 ]
  local copilot_rows
  copilot_rows=$(echo "$stderr" | grep -c $'\t'"name"$)
  [ "$copilot_rows" -eq 1 ]
}

# -- pull: no-match hint for remote handoffs (#87) ------------------------

@test "pull <unmatched> with DOTBABEL_HANDOFF_REPO set appends fetch hint" {
  run --separate-stderr node "$BIN" pull nonexistent-tag
  [ "$status" -eq 2 ]
  # DOTBABEL_HANDOFF_REPO is set in setup(); hint must surface.
  [[ "$stderr" == *"fetch"* ]]
}

@test "pull <unmatched> without DOTBABEL_HANDOFF_REPO emits no fetch hint" {
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
  run env -i HOME="$TEST_HOME" PATH="$PATH" DOTBABEL_HANDOFF_REPO="$TRANSPORT_REPO" \
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
  # `pull latest --from codex` resolves locally; bbbb2222 is the only codex session.
  # Explicit `latest` is required per §5.2.1 (<query> mandatory always).
  run node "$BIN" pull latest --from codex
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
    DOTBABEL_HANDOFF_REPO="$TRANSPORT_REPO" CLAUDECODE=1 \
    node "$BIN" push --from codex
  [ "$status" -eq 0 ]
  [[ "$stderr" == *"using --from codex override"* ]]
  run git --git-dir="$TRANSPORT_REPO" branch -a
  [[ "$output" =~ handoff/demo/codex/[0-9]{4}-[0-9]{2}/bbbb2222 ]]
}

# -- honest stderr fallback notes ----------------------------------------

@test "push (no args, no host signal) exits 64 — §5.5.2 mandatory --from" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    DOTBABEL_HANDOFF_REPO="$TRANSPORT_REPO" \
    node "$BIN" push
  [ "$status" -eq 64 ]
  [[ "$stderr" == *"requires --from"* ]]
}

@test "push (no args, CLAUDECODE=1) exits 64 — §5.5.2 mandatory --from" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" \
    DOTBABEL_HANDOFF_REPO="$TRANSPORT_REPO" CLAUDECODE=1 \
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

@test "pull latest under CODEX_HOME narrows to codex root" {
  # CODEX_HOME triggers the CODEX_* env-var probe, returning "codex" from
  # detectHost(). Host-scoped `latest` then narrows to the codex root.
  # bbbb2222 is the newest codex session (seeded last in setup).
  # Explicit `latest` is required per §5.2.1 (<query> mandatory always).
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" CODEX_HOME="/any/path" \
    node "$BIN" pull latest
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
