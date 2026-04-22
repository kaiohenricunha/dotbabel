#!/usr/bin/env bats
# Behavior tests for the binary-side port of `doctor`, `remote-list`,
# and `search`. Before v0.9.0 these were skill-interpreted (Claude /
# Copilot read SKILL.md and ran shell commands by hand); this suite
# verifies the binary matches the documented contract so Codex can
# invoke them directly.

load helpers

bats_require_minimum_version 1.5.0

BIN="$REPO_ROOT/plugins/dotclaude/bin/dotclaude-handoff.mjs"

setup() {
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  mkdir -p "$TEST_HOME/.claude/projects/-home-u-demo"
  CLAUDE_FILE="$TEST_HOME/.claude/projects/-home-u-demo/aaaa1111-1111-1111-1111-111111111111.jsonl"
  cat > "$CLAUDE_FILE" <<'EOF'
{"type":"user","cwd":"/home/u/demo","sessionId":"aaaa1111-1111-1111-1111-111111111111","version":"2.1","message":{"content":"Fix the migration bug in the auth middleware"}}
{"type":"user","cwd":"/home/u/demo","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"Run the suite"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"OK running now."}]}}
{"type":"custom-title","customTitle":"my-feature","sessionId":"aaaa1111-1111-1111-1111-111111111111"}
EOF

  sleep 0.01
  mkdir -p "$TEST_HOME/.codex/sessions/2026/04/18"
  CODEX_FILE="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T10-00-00-bbbb2222-2222-2222-2222-222222222222.jsonl"
  cat > "$CODEX_FILE" <<'EOF'
{"type":"session_meta","payload":{"id":"bbbb2222-2222-2222-2222-222222222222","cwd":"/work/demo","cli_version":"0.1"}}
{"type":"event_msg","payload":{"thread_name":"my-codex-task","type":"thread_renamed"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"ship the migration bug fix"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"running"}]}}
EOF

  # Set up a bare git repo as the remote transport endpoint. The binary
  # no longer requires any schema pin or init step — pushes land
  # straight onto `handoff/...` branches.
  TRANSPORT_REPO=$(mktemp -d)
  rm -rf "$TRANSPORT_REPO"
  git init -q --bare "$TRANSPORT_REPO"
  export DOTCLAUDE_HANDOFF_REPO="$TRANSPORT_REPO"

  export CLAUDE_FILE CODEX_FILE TRANSPORT_REPO
}

teardown() {
  rm -rf "$TEST_HOME" "$TRANSPORT_REPO"
}

# ---- doctor (binary wrapper around handoff-doctor.sh) ------------------

@test "doctor: exit 0 when DOTCLAUDE_HANDOFF_REPO points at a reachable repo" {
  run node "$BIN" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"ok"* ]]
}

@test "doctor: exit 0 with an info line when DOTCLAUDE_HANDOFF_REPO is unset (auto-bootstrap is the recovery path)" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" node "$BIN" doctor
  [ "$status" -eq 0 ]
  [[ "$output" == *"info: DOTCLAUDE_HANDOFF_REPO is not set"* ]]
  [[ "$output" == *"auto-bootstrap"* ]] || [[ "$output" == *"will offer to create"* ]]
}

# ---- remote-list -------------------------------------------------------

@test "remote-list: empty transport exits 0 with 'No handoffs found'" {
  run node "$BIN" remote-list
  [ "$status" -eq 0 ]
  [[ "$output" == *"No handoffs found"* ]]
}

@test "remote-list: after pushes, returns a table with both branches" {
  run node "$BIN" push my-feature
  [ "$status" -eq 0 ]
  run node "$BIN" push my-codex-task
  [ "$status" -eq 0 ]
  run node "$BIN" remote-list
  [ "$status" -eq 0 ]
  # v2 branches include project + month; fixture cwd resolves to "demo".
  [[ "$output" =~ handoff/demo/claude/[0-9]{4}-[0-9]{2}/aaaa1111 ]]
  [[ "$output" =~ handoff/demo/codex/[0-9]{4}-[0-9]{2}/bbbb2222 ]]
}

@test "remote-list --cli claude filters to claude-only" {
  run node "$BIN" push my-feature
  run node "$BIN" push my-codex-task
  run node "$BIN" remote-list --cli claude
  [ "$status" -eq 0 ]
  [[ "$output" =~ handoff/demo/claude/[0-9]{4}-[0-9]{2}/aaaa1111 ]]
  [[ "$output" != *"bbbb2222"* ]]
}

@test "remote-list --json emits a JSON array of handoff entries" {
  run node "$BIN" push my-feature
  run node "$BIN" --json remote-list
  [ "$status" -eq 0 ]
  # Parseable JSON and at least one entry with the expected fields.
  [[ "$output" == *'"branch":'* ]]
  [[ "$output" == *'"cli":'* ]]
  [[ "$output" == *'"short_id":'* ]]
}

@test "remote-list --cli with an invalid value exits 64" {
  run node "$BIN" remote-list --cli bogus
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from must be one of"* ]]
}

@test "remote-list --from claude filters to claude-only (canonical flag)" {
  run node "$BIN" push my-feature
  run node "$BIN" push my-codex-task
  run node "$BIN" remote-list --from claude
  [ "$status" -eq 0 ]
  [[ "$output" =~ handoff/demo/claude/[0-9]{4}-[0-9]{2}/aaaa1111 ]]
  [[ "$output" != *"bbbb2222"* ]]
}

# ---- search ------------------------------------------------------------

@test "search <query> returns matching sessions across roots" {
  run node "$BIN" search migration
  [ "$status" -eq 0 ]
  [[ "$output" == *"aaaa1111"* ]] || [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" == *"migration"* ]]
}

@test "search --cli codex narrows to the codex root only" {
  run node "$BIN" search migration --cli codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" != *"aaaa1111"* ]]
}

@test "search with no match exits 0 with 'No sessions matching'" {
  run node "$BIN" search absolutelynothingmatches
  [ "$status" -eq 0 ]
  [[ "$output" == *"No sessions matching"* ]]
}

@test "search missing <query> exits 64" {
  run node "$BIN" search
  [ "$status" -eq 64 ]
  [[ "$output" == *"search requires a <query>"* ]]
}

@test "search --from bogus exits 64" {
  run node "$BIN" search migration --from bogus
  [ "$status" -eq 64 ]
  [[ "$output" == *"--from must be one of"* ]]
}

@test "search --from codex narrows to codex (canonical flag)" {
  run node "$BIN" search migration --from codex
  [ "$status" -eq 0 ]
  [[ "$output" == *"bbbb2222"* ]]
  [[ "$output" != *"aaaa1111"* ]]
}

@test "search --since with an invalid date exits 64" {
  run node "$BIN" search migration --since not-a-date
  [ "$status" -eq 64 ]
  [[ "$output" == *"--since must be ISO-8601"* ]]
}

@test "search --json emits the documented shape (cli/short_id/session_id/path/cwd/mtime/match_snippet)" {
  run node "$BIN" --json search migration
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cli":'* ]]
  [[ "$output" == *'"short_id":'* ]]
  [[ "$output" == *'"session_id":'* ]]
  [[ "$output" == *'"path":'* ]]
  [[ "$output" == *'"cwd":'* ]]
  [[ "$output" == *'"mtime":'* ]]
  [[ "$output" == *'"match_snippet":'* ]]
}

@test "search --fixed makes regex metacharacters literal (no regex parse error, only literal match)" {
  local fixed_home
  fixed_home=$(mktemp -d)
  mkdir -p "$fixed_home/.claude/projects/-home-u-demo"
  cat > "$fixed_home/.claude/projects/-home-u-demo/cccc3333-3333-3333-3333-333333333333.jsonl" <<'EOF'
{"type":"user","cwd":"/home/u/demo","sessionId":"cccc3333-3333-3333-3333-333333333333","version":"2.1","message":{"content":"Call foo.bar() from the handler"}}
EOF

  # Regex-mode `foo.bar` matches `foobar` too, but here it happens to match
  # the literal. The real signal is that the literal-paren query `foo.bar()`
  # would fail as a regex (unescaped `(`) — `--fixed` must let it through.
  run env HOME="$fixed_home" node "$BIN" search "foo.bar()" --fixed
  [ "$status" -eq 0 ]
  [[ "$output" == *"cccc3333"* ]]
  rm -rf "$fixed_home"
}

@test "search -F short flag matches --fixed" {
  local fixed_home
  fixed_home=$(mktemp -d)
  mkdir -p "$fixed_home/.claude/projects/-home-u-demo"
  cat > "$fixed_home/.claude/projects/-home-u-demo/dddd4444-4444-4444-4444-444444444444.jsonl" <<'EOF'
{"type":"user","cwd":"/home/u/demo","sessionId":"dddd4444-4444-4444-4444-444444444444","version":"2.1","message":{"content":"Grep for a+b literally"}}
EOF
  run env HOME="$fixed_home" node "$BIN" search "a+b" -F
  [ "$status" -eq 0 ]
  [[ "$output" == *"dddd4444"* ]]
  rm -rf "$fixed_home"
}

@test "search drops candidates whose only raw match is inside a tool_use payload" {
  # A claude session where 'widgetizer' appears only as a tool_use block,
  # never in any user prompt or assistant text. The raw-regex pass catches
  # it, but the clean pass (extractPrompts + extractTurns) must drop it.
  local tu_home
  tu_home=$(mktemp -d)
  mkdir -p "$tu_home/.claude/projects/-home-u-demo"
  cat > "$tu_home/.claude/projects/-home-u-demo/eeee5555-5555-5555-5555-555555555555.jsonl" <<'EOF'
{"type":"user","cwd":"/home/u/demo","sessionId":"eeee5555-5555-5555-5555-555555555555","version":"2.1","message":{"content":"Do something unrelated"}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"widgetizer --run"}}]}}
EOF
  run env HOME="$tu_home" node "$BIN" search widgetizer
  [ "$status" -eq 0 ]
  [[ "$output" == *"No sessions matching"* ]]
  rm -rf "$tu_home"
}

@test "search matches terms that only appear in assistant turns" {
  local asst_home
  asst_home=$(mktemp -d)
  mkdir -p "$asst_home/.claude/projects/-home-u-demo"
  cat > "$asst_home/.claude/projects/-home-u-demo/ffff6666-6666-6666-6666-666666666666.jsonl" <<'EOF'
{"type":"user","cwd":"/home/u/demo","sessionId":"ffff6666-6666-6666-6666-666666666666","version":"2.1","message":{"content":"plain user prompt"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Zephyrine is the codename for this rollout"}]}}
EOF
  run env HOME="$asst_home" node "$BIN" search Zephyrine
  [ "$status" -eq 0 ]
  [[ "$output" == *"ffff6666"* ]]
  [[ "$output" == *"assistant:"* ]]
  rm -rf "$asst_home"
}

@test "search finds a match in an early assistant turn past extractTurns' default 20-turn window" {
  # Regression: earlier impl asked extractTurns for the default (last 20
  # turns) while calling .find() to locate the first match. A session with
  # >20 assistant turns and the target term only in turn #1 silently
  # returned no results. Seed such a session and confirm the hit comes
  # through with the unbounded-turns fix.
  local deep_home
  deep_home=$(mktemp -d)
  mkdir -p "$deep_home/.claude/projects/-home-u-demo"
  local jsonl="$deep_home/.claude/projects/-home-u-demo/deadbeef-beef-beef-beef-deadbeefbeef.jsonl"
  printf '%s\n' '{"type":"user","cwd":"/home/u/demo","sessionId":"deadbeef-beef-beef-beef-deadbeefbeef","version":"2.1","message":{"content":"driving prompt"}}' > "$jsonl"
  printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Glimfarble is the unique word we are looking for"}]}}' >> "$jsonl"
  for i in $(seq 1 40); do
    printf '{"type":"assistant","message":{"content":[{"type":"text","text":"filler turn %s"}]}}\n' "$i" >> "$jsonl"
  done
  run env HOME="$deep_home" node "$BIN" search Glimfarble
  [ "$status" -eq 0 ]
  [[ "$output" == *"deadbeef"* ]]
  [[ "$output" == *"assistant:"* ]]
  rm -rf "$deep_home"
}

# ---- self-bootstrap ----------------------------------------------------
# Replaces the old `init` sub-command: `push` auto-resolves a missing
# transport interactively, persists the URL to ~/.config/dotclaude, and
# falls back to a clear manual-setup block when non-interactive.

@test "push against an empty bare repo succeeds — no init required" {
  local fresh
  fresh=$(mktemp -d); rm -rf "$fresh"; git init -q --bare "$fresh"
  DOTCLAUDE_HANDOFF_REPO="$fresh" run node "$BIN" push aaaa1111
  [ "$status" -eq 0 ]
  # Branch landed; no schema-pin complaints on stdout/stderr.
  run git --git-dir="$fresh" ls-remote --heads "$fresh"
  [[ "$output" =~ handoff/demo/claude/[0-9]{4}-[0-9]{2}/aaaa1111 ]]
  rm -rf "$fresh"
}

@test "push with env unset + no TTY prints manual-setup block and exits 2" {
  run --separate-stderr env -i HOME="$TEST_HOME" PATH="$PATH" node "$BIN" push aaaa1111 </dev/null
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"Can't auto-bootstrap"* ]]
  [[ "$stderr" == *"gh repo create"* ]]
  [[ "$stderr" == *"DOTCLAUDE_HANDOFF_REPO"* ]]
}

@test "push with env unset + config file present auto-sources the URL" {
  local fresh configdir
  fresh=$(mktemp -d); rm -rf "$fresh"; git init -q --bare "$fresh"
  # Pin CONFIG_DIR via XDG_CONFIG_HOME so the test works regardless of the
  # developer's real XDG_CONFIG_HOME value (defaulting HOME-derivation
  # isn't enough when a caller has XDG_CONFIG_HOME exported).
  configdir="$TEST_HOME/xdg/dotclaude"
  mkdir -p "$configdir"
  printf 'export DOTCLAUDE_HANDOFF_REPO=%s\n' "$fresh" > "$configdir/handoff.env"
  run env HOME="$TEST_HOME" XDG_CONFIG_HOME="$TEST_HOME/xdg" DOTCLAUDE_HANDOFF_REPO= \
    node "$BIN" push aaaa1111
  [ "$status" -eq 0 ]
  run git --git-dir="$fresh" ls-remote --heads "$fresh"
  [[ "$output" =~ handoff/demo/claude/[0-9]{4}-[0-9]{2}/aaaa1111 ]]
  rm -rf "$fresh"
}
