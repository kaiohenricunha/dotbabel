#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/scripts/handoff-resolve.sh.
# Resolves <cli> <identifier> to an absolute JSONL file path.
# Supports: claude (uuid|short-uuid|latest|customTitle|aiTitle),
#           copilot (uuid|short-uuid|latest|workspace.yaml:name),
#           codex (uuid|short-uuid|latest|thread_name),
#           gemini (uuid|short-uuid|latest|checkpoint).

bats_require_minimum_version 1.5.0

load helpers

RESOLVE="$REPO_ROOT/plugins/dotbabel/scripts/handoff-resolve.sh"

# Build a hermetic $HOME with fake session trees for the four CLIs.
# Fixtures are minimal: just enough for path resolution and alias scan.
setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"

  # Claude: ~/.claude/projects/<slug>/<uuid>.jsonl
  mkdir -p "$TEST_HOME/.claude/projects/-home-user-projects-demo"
  printf '{"cwd":"/home/user/projects/demo","sessionId":"aaaa1111-1111-1111-1111-111111111111","version":"2.1"}\n' \
    > "$TEST_HOME/.claude/projects/-home-user-projects-demo/aaaa1111-1111-1111-1111-111111111111.jsonl"
  # Make a second, newer claude session so `latest` picks it.
  sleep 0.01
  mkdir -p "$TEST_HOME/.claude/projects/-home-user-projects-other"
  printf '{"cwd":"/home/user/projects/other","sessionId":"bbbb2222-2222-2222-2222-222222222222","version":"2.1"}\n' \
    > "$TEST_HOME/.claude/projects/-home-user-projects-other/bbbb2222-2222-2222-2222-222222222222.jsonl"

  # Third claude session with a customTitle record (the `claude --resume "<name>"` alias).
  sleep 0.01
  mkdir -p "$TEST_HOME/.claude/projects/-home-user-projects-demo"
  CLAUDE_ALIAS_FILE="$TEST_HOME/.claude/projects/-home-user-projects-demo/cccc1111-1111-1111-1111-111111111111.jsonl"
  printf '{"cwd":"/home/user/projects/demo","sessionId":"cccc1111-1111-1111-1111-111111111111","version":"2.1"}\n{"type":"custom-title","customTitle":"my-feature","sessionId":"cccc1111-1111-1111-1111-111111111111"}\n' \
    > "$CLAUDE_ALIAS_FILE"
  export CLAUDE_ALIAS_FILE

  # Copilot: ~/.copilot/session-state/<uuid>/events.jsonl
  mkdir -p "$TEST_HOME/.copilot/session-state/cccc3333-3333-3333-3333-333333333333"
  printf '{"type":"session.start","data":{"cwd":null,"model":null,"sessionId":"cccc3333-3333-3333-3333-333333333333"}}\n' \
    > "$TEST_HOME/.copilot/session-state/cccc3333-3333-3333-3333-333333333333/events.jsonl"
  # Second, newer copilot session for `latest`.
  sleep 0.01
  mkdir -p "$TEST_HOME/.copilot/session-state/dddd4444-4444-4444-4444-444444444444"
  printf '{"type":"session.start","data":{"cwd":"/tmp","model":"gpt","sessionId":"dddd4444-4444-4444-4444-444444444444"}}\n' \
    > "$TEST_HOME/.copilot/session-state/dddd4444-4444-4444-4444-444444444444/events.jsonl"

  # Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
  mkdir -p "$TEST_HOME/.codex/sessions/2026/04/18"
  CODEX_ONE="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T10-00-00-eeee5555-5555-5555-5555-555555555555.jsonl"
  printf '{"type":"session_meta","payload":{"id":"eeee5555-5555-5555-5555-555555555555","cwd":"/work"}}\n{"type":"event_msg","payload":{"thread_id":"eeee5555-5555-5555-5555-555555555555","thread_name":"my-feature","type":"thread_renamed"}}\n' \
    > "$CODEX_ONE"
  # A second, newer codex rollout without a thread_name (for `latest`).
  sleep 0.01
  CODEX_TWO="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T11-00-00-ffff6666-6666-6666-6666-666666666666.jsonl"
  printf '{"type":"session_meta","payload":{"id":"ffff6666-6666-6666-6666-666666666666","cwd":"/work"}}\n' \
    > "$CODEX_TWO"
  export CODEX_ONE CODEX_TWO

  # Gemini: ~/.gemini/tmp/<project>/chats/session-<timestamp>-<short>.jsonl
  mkdir -p "$TEST_HOME/.gemini/tmp/demo/chats"
  printf '/home/user/projects/demo\n' > "$TEST_HOME/.gemini/tmp/demo/.project_root"
  GEMINI_ONE="$TEST_HOME/.gemini/tmp/demo/chats/session-2026-05-06T14-11-9999aaaa.jsonl"
  printf '{"sessionId":"9999aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","projectHash":"h","startTime":"2026-05-06T14:11:01.000Z","lastUpdated":"2026-05-06T14:11:01.000Z","kind":"main"}\n{"type":"user","content":[{"text":"Start Gemini handoff"}]}\n{"type":"info","content":"Conversation checkpoint saved with tag: my-feature."}\n{"type":"gemini","content":"Gemini answer","model":"gemini-2.5-pro"}\n' \
    > "$GEMINI_ONE"
  printf '{"authType":"oauth","history":[]}\n' > "$TEST_HOME/.gemini/tmp/demo/checkpoint-my-feature.json"
  sleep 0.01
  GEMINI_TWO="$TEST_HOME/.gemini/tmp/demo/chats/session-2026-05-06T15-11-abcd9999.jsonl"
  printf '{"sessionId":"abcd9999-9999-9999-9999-999999999999","projectHash":"h","startTime":"2026-05-06T15:11:01.000Z","lastUpdated":"2026-05-06T15:11:01.000Z","kind":"main"}\n' \
    > "$GEMINI_TWO"
  export GEMINI_ONE GEMINI_TWO
}

teardown() {
  rm -rf "$TEST_HOME"
}

# -- claude ---------------------------------------------------------------

@test "resolve claude by full UUID" {
  run --separate-stderr "$RESOLVE" claude aaaa1111-1111-1111-1111-111111111111
  [ "$status" -eq 0 ]
  [ "$output" = "$TEST_HOME/.claude/projects/-home-user-projects-demo/aaaa1111-1111-1111-1111-111111111111.jsonl" ]
  [[ "$stderr" == *"matched-field=uuid"* ]]
  [[ "$stderr" == *"matched-value=aaaa1111-1111-1111-1111-111111111111"* ]]
}

@test "resolve claude by short UUID (first 8 hex)" {
  run --separate-stderr "$RESOLVE" claude aaaa1111
  [ "$status" -eq 0 ]
  [ "$output" = "$TEST_HOME/.claude/projects/-home-user-projects-demo/aaaa1111-1111-1111-1111-111111111111.jsonl" ]
  [[ "$stderr" == *"matched-field=short-uuid"* ]]
  [[ "$stderr" == *"matched-value=aaaa1111"* ]]
}

@test "resolve claude latest picks newest mtime" {
  run --separate-stderr "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  # cccc1111 is created last (sleep 0.01 after bbbb2222) so it is the newest.
  [[ "$output" == *"cccc1111-1111-1111-1111-111111111111.jsonl" ]]
  [[ "$stderr" == *"matched-field=latest"* ]]
  [[ "$stderr" == *"matched-value=latest"* ]]
}

@test "resolve claude miss exits 2 with structured error" {
  run "$RESOLVE" claude 00000000-0000-0000-0000-000000000000
  [ "$status" -eq 2 ]
  [[ "$output" == *"handoff-resolve:"* ]]
  [[ "$output" == *"not found"* ]]
}

@test "resolve claude by customTitle alias" {
  run --separate-stderr "$RESOLVE" claude my-feature
  [ "$status" -eq 0 ]
  [ "$output" = "$CLAUDE_ALIAS_FILE" ]
  [[ "$stderr" == *"matched-field=customTitle"* ]]
  [[ "$stderr" == *"matched-value=my-feature"* ]]
}

@test "resolve claude unknown customTitle exits 2" {
  run "$RESOLVE" claude nonexistent-feature-alias
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

@test "intra-file dedup: 100 identical customTitle records resolve to one row" {
  # Verifies the (d).3 dedup-by-sessionId retrofit. Claude Code rewrites the
  # custom-title record on every save, producing 100+ identical records per
  # file in the wild (Phase 1 cardinality survey: 73-366 records per file).
  # Without dedup, naive collect-all would emit a 100-row collision TSV from
  # a single-session match. With dedup, the 100 records collapse to one row.
  local uuid="dddd3333-3333-3333-3333-333333333333"
  local dir="$TEST_HOME/.claude/projects/-home-user-projects-dedup"
  mkdir -p "$dir"
  local path="$dir/$uuid.jsonl"
  printf '{"cwd":"/home/user/projects/dedup","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$path"

  # Append 100 identical custom-title records (simulates rewrite-on-every-save).
  local i=0
  while (( i < 100 )); do
    set_claude_custom_title "$path" "$uuid" "force-push-collision-guard"
    i=$((i + 1))
  done

  run --separate-stderr "$RESOLVE" claude "force-push-collision-guard"
  [ "$status" -eq 0 ]
  [ "$output" = "$path" ]
  [[ "$stderr" == *"matched-field=customTitle"* ]]
  [[ "$stderr" == *"matched-value=force-push-collision-guard"* ]]
}

@test "intra-CLI collision: claude customTitle + aiTitle cross-mechanism emits 5-col TSV" {
  # Claude has TWO alias mechanisms — customTitle (user-set) and aiTitle
  # (auto-generated). Per ARCH-3, both are equally-weighted alias surfaces
  # for the same CLI; a query that matches one mechanism in session A and
  # the other mechanism in session B is a real cross-mechanism collision,
  # not a single-hit. The resolver must collect rows from BOTH scans into
  # one Claude alias candidate set before deciding single-hit vs collision.
  local uuid_custom="aaaa9999-9999-9999-9999-999999999999"
  local uuid_ai="bbbb5555-5555-5555-5555-555555555555"
  local dir_custom="$TEST_HOME/.claude/projects/-home-user-projects-cross-mech1"
  local dir_ai="$TEST_HOME/.claude/projects/-home-user-projects-cross-mech2"
  mkdir -p "$dir_custom" "$dir_ai"
  local path_custom="$dir_custom/$uuid_custom.jsonl"
  local path_ai="$dir_ai/$uuid_ai.jsonl"
  printf '{"cwd":"/home/user/projects/cm1","sessionId":"%s","version":"2.1"}\n' "$uuid_custom" > "$path_custom"
  set_claude_custom_title "$path_custom" "$uuid_custom" "shared-cross-mech"
  printf '{"cwd":"/home/user/projects/cm2","sessionId":"%s","version":"2.1"}\n' "$uuid_ai" > "$path_ai"
  set_claude_ai_title "$path_ai" "$uuid_ai" "shared-cross-mech"

  run --separate-stderr "$RESOLVE" claude "shared-cross-mech"
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == *"multiple sessions match"* ]]
  [[ "$stderr" == *"$path_custom"* ]]
  [[ "$stderr" == *"$path_ai"* ]]
  # Each row carries its own matched-field tag.
  local custom_rows
  custom_rows=$(echo "$stderr" | grep -c $'\t'"customTitle"$)
  [ "$custom_rows" -eq 1 ]
  local ai_rows
  ai_rows=$(echo "$stderr" | grep -c $'\t'"aiTitle"$)
  [ "$ai_rows" -eq 1 ]
}

@test "intra-CLI collision: claude customTitle shared by 2 sessions emits 5-col TSV" {
  # Two distinct claude sessions (different UUIDs) with the same customTitle.
  # Without dedup-by-sessionId would dedupe; with dedup-by-sessionId these
  # remain distinct rows since their sessionIds differ. Real ARCH-3 collision.
  local uuid1="aaaa2222-2222-2222-2222-222222222222"
  local uuid2="aaaa3333-3333-3333-3333-333333333333"
  local dir1="$TEST_HOME/.claude/projects/-home-user-projects-collide1"
  local dir2="$TEST_HOME/.claude/projects/-home-user-projects-collide2"
  mkdir -p "$dir1" "$dir2"
  local path1="$dir1/$uuid1.jsonl"
  local path2="$dir2/$uuid2.jsonl"
  printf '{"cwd":"/home/user/projects/c1","sessionId":"%s","version":"2.1"}\n' "$uuid1" > "$path1"
  set_claude_custom_title "$path1" "$uuid1" "shared-title"
  printf '{"cwd":"/home/user/projects/c2","sessionId":"%s","version":"2.1"}\n' "$uuid2" > "$path2"
  set_claude_custom_title "$path2" "$uuid2" "shared-title"

  run --separate-stderr "$RESOLVE" claude "shared-title"
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == *"multiple sessions match"* ]]
  [[ "$stderr" == *"$path1"* ]]
  [[ "$stderr" == *"$path2"* ]]
  local row_count
  row_count=$(echo "$stderr" | grep -c $'\t'"customTitle"$)
  [ "$row_count" -eq 2 ]
}

@test "resolve claude by aiTitle alias" {
  # Seed an extra claude session with an ai-title record. Claude Code emits
  # ai-title as the auto-generated TUI summary (4/24 sessions in the dotbabel
  # project per Phase 1) — distinct from user-set customTitle.
  local uuid="dddd2222-2222-2222-2222-222222222222"
  local dir="$TEST_HOME/.claude/projects/-home-user-projects-aititle"
  mkdir -p "$dir"
  local path="$dir/$uuid.jsonl"
  printf '{"cwd":"/home/user/projects/aititle","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$path"
  set_claude_ai_title "$path" "$uuid" "Refactor extract pipeline"

  run --separate-stderr "$RESOLVE" claude "Refactor extract pipeline"
  [ "$status" -eq 0 ]
  [ "$output" = "$path" ]
  [[ "$stderr" == *"matched-field=aiTitle"* ]]
  [[ "$stderr" == *"matched-value=Refactor extract pipeline"* ]]
}

# -- copilot --------------------------------------------------------------

@test "resolve copilot by full UUID" {
  run --separate-stderr "$RESOLVE" copilot cccc3333-3333-3333-3333-333333333333
  [ "$status" -eq 0 ]
  [ "$output" = "$TEST_HOME/.copilot/session-state/cccc3333-3333-3333-3333-333333333333/events.jsonl" ]
}

@test "resolve copilot by short UUID" {
  run --separate-stderr "$RESOLVE" copilot cccc3333
  [ "$status" -eq 0 ]
  [[ "$output" == *"cccc3333-3333-3333-3333-333333333333/events.jsonl" ]]
}

@test "resolve copilot latest picks newest mtime" {
  run --separate-stderr "$RESOLVE" copilot latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"dddd4444-4444-4444-4444-444444444444/events.jsonl" ]]
}

@test "resolve copilot miss exits 2" {
  run "$RESOLVE" copilot 00000000-0000-0000-0000-000000000000
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

@test "resolve copilot by name alias" {
  # Seed an extra copilot session with workspace.yaml:name set. The `name`
  # field is what `copilot --resume`'s picker displays — distinct from
  # short-UUID resolution and from events.jsonl content.
  local uuid="eeee2222-2222-2222-2222-222222222222"
  make_copilot_session_tree "$TEST_HOME" "$uuid"
  set_copilot_workspace_name "$TEST_HOME" "$uuid" "Validate Cross-Root Pull Behavior"

  run --separate-stderr "$RESOLVE" copilot "Validate Cross-Root Pull Behavior"
  [ "$status" -eq 0 ]
  [ "$output" = "$TEST_HOME/.copilot/session-state/$uuid/events.jsonl" ]
  [[ "$stderr" == *"matched-field=name"* ]]
  [[ "$stderr" == *"matched-value=Validate Cross-Root Pull Behavior"* ]]
}

@test "intra-CLI collision: copilot name shared by 2 sessions emits 5-col TSV" {
  # Two distinct copilot sessions (different UUID dirs) with workspace.yaml:name
  # set to the same value. Copilot dedup is by directory; different dirs with
  # same name are real collisions.
  local uuid1="ffff3333-3333-3333-3333-333333333333"
  local uuid2="ffff4444-4444-4444-4444-444444444444"
  make_copilot_session_tree "$TEST_HOME" "$uuid1"
  make_copilot_session_tree "$TEST_HOME" "$uuid2"
  set_copilot_workspace_name "$TEST_HOME" "$uuid1" "Shared Workspace Name"
  set_copilot_workspace_name "$TEST_HOME" "$uuid2" "Shared Workspace Name"

  local path1="$TEST_HOME/.copilot/session-state/$uuid1/events.jsonl"
  local path2="$TEST_HOME/.copilot/session-state/$uuid2/events.jsonl"

  run --separate-stderr "$RESOLVE" copilot "Shared Workspace Name"
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == *"multiple sessions match"* ]]
  [[ "$stderr" == *"$path1"* ]]
  [[ "$stderr" == *"$path2"* ]]
  local row_count
  row_count=$(echo "$stderr" | grep -c $'\t'"name"$)
  [ "$row_count" -eq 2 ]
}

# -- codex ----------------------------------------------------------------

@test "resolve codex by full UUID" {
  run --separate-stderr "$RESOLVE" codex eeee5555-5555-5555-5555-555555555555
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_ONE" ]
}

@test "resolve codex by short UUID" {
  run --separate-stderr "$RESOLVE" codex eeee5555
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_ONE" ]
}

@test "resolve codex latest picks newest mtime" {
  run --separate-stderr "$RESOLVE" codex latest
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_TWO" ]
}

@test "resolve codex by alias (thread_name scan)" {
  run --separate-stderr "$RESOLVE" codex my-feature
  [ "$status" -eq 0 ]
  [ "$output" = "$CODEX_ONE" ]
  [[ "$stderr" == *"matched-field=thread_name"* ]]
  [[ "$stderr" == *"matched-value=my-feature"* ]]
}

@test "intra-CLI collision: codex thread_name shared by 2 sessions emits 5-col TSV" {
  # Two distinct codex rollouts with the same thread_name. Codex's dedup is
  # by-path; different paths with same thread_name are real collisions.
  local uuid1="eeee3333-3333-3333-3333-333333333333"
  local uuid2="eeee4444-4444-4444-4444-444444444444"
  local dir="$TEST_HOME/.codex/sessions/2026/04/19"
  mkdir -p "$dir"
  local path1="$dir/rollout-2026-04-19T10-00-00-${uuid1}.jsonl"
  local path2="$dir/rollout-2026-04-19T11-00-00-${uuid2}.jsonl"
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/work"}}\n' "$uuid1" > "$path1"
  set_codex_thread_name "$path1" "$uuid1" "shared-thread"
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/work"}}\n' "$uuid2" > "$path2"
  set_codex_thread_name "$path2" "$uuid2" "shared-thread"

  run --separate-stderr "$RESOLVE" codex "shared-thread"
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == *"multiple sessions match"* ]]
  [[ "$stderr" == *"$path1"* ]]
  [[ "$stderr" == *"$path2"* ]]
  local row_count
  row_count=$(echo "$stderr" | grep -c $'\t'"thread_name"$)
  [ "$row_count" -eq 2 ]
}

@test "resolve codex alias miss exits 2" {
  run "$RESOLVE" codex nonexistent-alias
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

@test "exits 2 with not-found error on codex UUID-shaped miss" {
  # Decision 4 strict-precedence: UUID-shaped queries are not consulted as
  # aliases on miss (no fall-through to thread_name scan). Verifies the
  # harmonized "<cli> session not found for uuid: <id>" message.
  run "$RESOLVE" codex 99999999-9999-9999-9999-999999999999
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

# -- gemini ---------------------------------------------------------------

@test "resolve gemini by full UUID" {
  run --separate-stderr "$RESOLVE" gemini 9999aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
  [ "$status" -eq 0 ]
  [ "$output" = "$GEMINI_ONE" ]
  [[ "$stderr" == *"matched-field=uuid"* ]]
}

@test "resolve gemini by short UUID" {
  run --separate-stderr "$RESOLVE" gemini 9999aaaa
  [ "$status" -eq 0 ]
  [ "$output" = "$GEMINI_ONE" ]
  [[ "$stderr" == *"matched-field=short-uuid"* ]]
}

@test "resolve gemini latest picks newest mtime" {
  run --separate-stderr "$RESOLVE" gemini latest
  [ "$status" -eq 0 ]
  [ "$output" = "$GEMINI_TWO" ]
  [[ "$stderr" == *"matched-field=latest"* ]]
}

@test "resolve gemini by checkpoint alias" {
  run --separate-stderr "$RESOLVE" gemini my-feature
  [ "$status" -eq 0 ]
  [ "$output" = "$GEMINI_ONE" ]
  [[ "$stderr" == *"matched-field=checkpoint"* ]]
  [[ "$stderr" == *"matched-value=my-feature"* ]]
}

@test "intra-CLI collision: gemini checkpoint shared by 2 projects emits 5-col TSV" {
  local uuid="bbbb9999-9999-9999-9999-999999999999"
  local dir="$TEST_HOME/.gemini/tmp/other"
  mkdir -p "$dir/chats"
  local path="$dir/chats/session-2026-05-06T16-11-bbbb9999.jsonl"
  printf '{"sessionId":"%s","projectHash":"h","startTime":"2026-05-06T16:11:01.000Z","kind":"main"}\n{"type":"info","content":"Conversation checkpoint saved with tag: my-feature."}\n' "$uuid" > "$path"
  printf '{"authType":"oauth","history":[]}\n' > "$dir/checkpoint-my-feature.json"

  run --separate-stderr "$RESOLVE" gemini my-feature
  [ "$status" -eq 2 ]
  [ -z "$output" ]
  [[ "$stderr" == *"multiple sessions match"* ]]
  [[ "$stderr" == *"$GEMINI_ONE"* ]]
  [[ "$stderr" == *"$path"* ]]
  local row_count
  row_count=$(echo "$stderr" | grep -c $'\t'"checkpoint"$)
  [ "$row_count" -eq 2 ]
}

@test "resolve gemini checkpoint without matching session info exits 2" {
  printf '{"authType":"oauth","history":[]}\n' > "$TEST_HOME/.gemini/tmp/demo/checkpoint-orphan.json"

  run "$RESOLVE" gemini orphan
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

# -- usage / error paths --------------------------------------------------

@test "missing cli exits 64 with usage" {
  run "$RESOLVE"
  [ "$status" -eq 64 ]
  [[ "$output" == *"usage:"* ]]
}

@test "unknown cli exits 64" {
  run "$RESOLVE" foocli someid
  [ "$status" -eq 64 ]
  [[ "$output" == *"cli must be one of"* ]]
}

@test "missing identifier exits 64" {
  run "$RESOLVE" claude
  [ "$status" -eq 64 ]
  [[ "$output" == *"usage:"* ]]
}

# -- case-insensitive alias matching (Decision 1/2) ------------------------

@test "case-insensitive: claude customTitle resolves on lowercase query" {
  local uuid="aaaa7777-7777-7777-7777-777777777777"
  local dir="$TEST_HOME/.claude/projects/-home-user-projects-case1"
  mkdir -p "$dir"
  local path="$dir/$uuid.jsonl"
  printf '{"cwd":"/home/user/projects/case1","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$path"
  set_claude_custom_title "$path" "$uuid" "Refactor Pipeline"

  # Query with all-lowercase variant; jq's ascii_downcase on both sides matches.
  run --separate-stderr "$RESOLVE" claude "refactor pipeline"
  [ "$status" -eq 0 ]
  [ "$output" = "$path" ]
  [[ "$stderr" == *"matched-field=customTitle"* ]]
  # matched-value preserves case-as-stored per Decision 3.
  [[ "$stderr" == *"matched-value=Refactor Pipeline"* ]]
}

@test "case-insensitive: claude aiTitle resolves on uppercase query" {
  local uuid="aaaa8888-8888-8888-8888-888888888888"
  local dir="$TEST_HOME/.claude/projects/-home-user-projects-case2"
  mkdir -p "$dir"
  local path="$dir/$uuid.jsonl"
  printf '{"cwd":"/home/user/projects/case2","sessionId":"%s","version":"2.1"}\n' "$uuid" > "$path"
  set_claude_ai_title "$path" "$uuid" "Extract Pipeline"

  run --separate-stderr "$RESOLVE" claude "EXTRACT PIPELINE"
  [ "$status" -eq 0 ]
  [ "$output" = "$path" ]
  [[ "$stderr" == *"matched-field=aiTitle"* ]]
  [[ "$stderr" == *"matched-value=Extract Pipeline"* ]]
}

@test "case-insensitive: codex thread_name resolves on mixed-case query" {
  local uuid="ffff7777-7777-7777-7777-777777777777"
  local dir="$TEST_HOME/.codex/sessions/2026/04/19"
  mkdir -p "$dir"
  local path="$dir/rollout-2026-04-19T14-00-00-${uuid}.jsonl"
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/work"}}\n' "$uuid" > "$path"
  set_codex_thread_name "$path" "$uuid" "my-thread"

  run --separate-stderr "$RESOLVE" codex "MY-Thread"
  [ "$status" -eq 0 ]
  [ "$output" = "$path" ]
  [[ "$stderr" == *"matched-field=thread_name"* ]]
  [[ "$stderr" == *"matched-value=my-thread"* ]]
}

@test "case-insensitive: copilot name resolves on lowercase query" {
  local uuid="ffff8888-8888-8888-8888-888888888888"
  make_copilot_session_tree "$TEST_HOME" "$uuid"
  set_copilot_workspace_name "$TEST_HOME" "$uuid" "Pull Latest Changes"

  # Copilot uses bash-side LC_ALL=C tr for case-folding (no jq dependency).
  run --separate-stderr "$RESOLVE" copilot "pull latest changes"
  [ "$status" -eq 0 ]
  [ "$output" = "$TEST_HOME/.copilot/session-state/$uuid/events.jsonl" ]
  [[ "$stderr" == *"matched-field=name"* ]]
  [[ "$stderr" == *"matched-value=Pull Latest Changes"* ]]
}

@test "case-insensitive: gemini checkpoint resolves on uppercase query" {
  run --separate-stderr "$RESOLVE" gemini "MY-FEATURE"
  [ "$status" -eq 0 ]
  [ "$output" = "$GEMINI_ONE" ]
  [[ "$stderr" == *"matched-field=checkpoint"* ]]
  [[ "$stderr" == *"matched-value=my-feature"* ]]
}
