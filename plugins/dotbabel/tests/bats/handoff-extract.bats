#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/scripts/handoff-extract.sh.
# Subcommands:
#   meta    <cli> <file>   JSON on stdout: {cli, session_id, short_id, cwd, model, started_at}
#   prompts <cli> <file>   Clean user prompts, newline-separated, order preserved
#   turns   <cli> <file>   Last-N assistant turns (default N=20, tail-only)

load helpers

EX="$REPO_ROOT/plugins/dotbabel/scripts/handoff-extract.sh"

setup() {
  [ -x "$EX" ] || chmod +x "$EX"
  TEST_DIR=$(mktemp -d)

  # --- Claude fixture: mix of real prompts + noise records ---
  # promptId groups model Claude Code's real transcript shape:
  #   - p-caveat: synthetic noise only
  #   - p-typed:  real typed user prompts (one multi-line)
  #   - p-slash:  a typed prompt + a /slash invocation + its skill body
  CLAUDE_FILE="$TEST_DIR/claude.jsonl"
  cat > "$CLAUDE_FILE" <<'EOF'
{"type":"user","promptId":"p-caveat","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","version":"2.1","message":{"content":"<local-command-caveat>Caveat: this was auto-generated</local-command-caveat>"}}
{"type":"user","promptId":"p-typed","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"Actually fix the retry loop"}}
{"type":"user","promptId":"p-typed","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":[{"type":"tool_result","content":"file contents"}]}}
{"type":"user","promptId":"p-typed","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":[{"type":"text","text":"<system-reminder>do not respond to this</system-reminder>"}]}}
{"type":"user","promptId":"p-typed","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":[{"type":"text","text":"Run the full suite and report\nevery failure with its stack trace"}]}}
{"type":"user","promptId":"p-slash","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"oPEN pr"}}
{"type":"user","promptId":"p-slash","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"<command-message>simplify</command-message>\n<command-name>/simplify</command-name>"}}
{"type":"user","promptId":"p-slash","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"# Simplify: Code Review and Cleanup\n\nReview all changed files.\nEnd of skill body."}}
{"type":"user","promptId":"p-slash","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"<command-message>review-pr</command-message>\n<command-name>/review-pr</command-name>\n<command-args>#80</command-args>"}}
{"type":"user","promptId":"p-slash","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"Review a pull request: fetch comments, apply fixes.\nARGUMENTS: #80"}}
{"type":"user","promptId":"p-bare","cwd":"/home/u/proj","sessionId":"aaaa1111-1111-1111-1111-111111111111","message":{"content":"<command-name>/clear</command-name>"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Sure, running tests now."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[{"content":"GOAL-FINISH-RETRY-LOOP","status":"in_progress","activeForm":"Finishing retry loop fix"},{"content":"GOAL-WRITE-REGRESSION-TEST","status":"pending","activeForm":"Writing regression test"}]}}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"All 205 tests passed."}]}}
EOF

  # --- Copilot fixture: session.start with null cwd; workspace.yaml fallback ---
  COPILOT_DIR="$TEST_DIR/copilot-session"
  mkdir -p "$COPILOT_DIR"
  COPILOT_FILE="$COPILOT_DIR/events.jsonl"
  cat > "$COPILOT_FILE" <<'EOF'
{"type":"session.start","data":{"cwd":null,"model":null,"sessionId":"cccc3333-3333-3333-3333-333333333333"}}
{"type":"user.message","data":{"content":"First user prompt"}}
{"type":"assistant.message","data":{"content":"First assistant reply"}}
{"type":"user.message","data":{"content":"Second prompt","transformedContent":"<wrapped><system-reminder>ignore</system-reminder>Second prompt</wrapped>"}}
{"type":"user.message","data":{"content":"Multi-line prompt\nwith two lines"}}
EOF
  cat > "$COPILOT_DIR/workspace.yaml" <<'EOF'
id: cccc3333-3333-3333-3333-333333333333
cwd: /workspace/demo
model: gpt-5
summary: Test session
EOF

  # --- Codex fixture: session_meta + turn_context + response_items + event_msg mirrors.
  # Schema mirror per docs/audits/codex-extraction-investigation-2026-04-30.md Phase 2:
  # top-level types {session_meta, turn_context, response_item, event_msg}; response_item
  # content blocks use input_text (user) / output_text (assistant).
  CODEX_FILE="$TEST_DIR/codex.jsonl"
  cat > "$CODEX_FILE" <<'EOF'
{"type":"session_meta","payload":{"id":"eeee5555-5555-5555-5555-555555555555","cwd":"/work/demo","cli_version":"0.121.0","timestamp":"2026-04-18T20:38:53Z","model_provider":"openai"}}
{"type":"turn_context","payload":{"cwd":"/work/demo","sandbox_policy":{"mode":"workspace-write"}}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>shell: zsh\ncwd: /work/demo</environment_context>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Improve documentation in @README.md"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"Improve documentation in @README.md"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I'll read README.md first."}]}}
{"type":"event_msg","payload":{"type":"agent_message","message":"I'll read README.md first.","phase":"commentary"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Go ahead"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Refactor this:\n- step one\n- step two"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Done.","phase":"final"}}
EOF

  # --- Codex empty-case fixture: shell-only session with no assistant turns.
  # Mirrors the 019ddf95 profile from the investigation — turns_codex must
  # return empty (not crash) and prompts_codex must filter the env_context
  # record cleanly to also return empty.
  CODEX_EMPTY_FILE="$TEST_DIR/codex-empty.jsonl"
  cat > "$CODEX_EMPTY_FILE" <<'EOF'
{"type":"session_meta","payload":{"id":"ffff6666-6666-6666-6666-666666666666","cwd":"/work/empty","cli_version":"0.121.0","timestamp":"2026-04-30T15:10:00Z","model_provider":"openai"}}
{"type":"turn_context","payload":{"cwd":"/work/empty","sandbox_policy":{"mode":"workspace-write"}}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>shell: bash\ncwd: /work/empty</environment_context>"}]}}
{"type":"event_msg","payload":{"type":"exec_command_end","exit_code":0,"stdout":"ok"}}
EOF

  # --- Gemini fixture: project root sidecar + session JSONL transcript.
  GEMINI_DIR="$TEST_DIR/gemini-project"
  mkdir -p "$GEMINI_DIR/chats"
  printf '/work/gemini-demo\n' > "$GEMINI_DIR/.project_root"
  GEMINI_FILE="$GEMINI_DIR/chats/session-2026-05-06T14-11-9999aaaa.jsonl"
  cat > "$GEMINI_FILE" <<'EOF'
{"sessionId":"9999aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","projectHash":"h","startTime":"2026-05-06T14:11:01.780Z","lastUpdated":"2026-05-06T14:11:01.780Z","kind":"main"}
{"type":"user","timestamp":"2026-05-06T14:11:04.000Z","content":[{"text":"First Gemini prompt"}]}
{"type":"gemini","timestamp":"2026-05-06T14:11:05.000Z","content":"First Gemini reply","model":"gemini-2.5-pro"}
{"type":"gemini","timestamp":"2026-05-06T14:11:05.100Z","content":"First Gemini reply","model":"gemini-2.5-pro","toolCalls":[{"name":"ReadFile"}]}
{"type":"info","timestamp":"2026-05-06T14:11:06.000Z","content":"Conversation checkpoint saved with tag: test."}
{"type":"user","timestamp":"2026-05-06T14:11:07.000Z","content":[{"text":"Multi-line Gemini prompt\nwith two lines"}]}
{"type":"gemini","timestamp":"2026-05-06T14:11:08.000Z","content":"","thoughts":"tool-only thought"}
{"type":"gemini","timestamp":"2026-05-06T14:11:09.000Z","content":"Second Gemini reply","model":"gemini-2.5-pro"}
EOF

  export CLAUDE_FILE COPILOT_FILE COPILOT_DIR CODEX_FILE CODEX_EMPTY_FILE GEMINI_FILE GEMINI_DIR TEST_DIR
}

teardown() {
  rm -rf "$TEST_DIR"
}

# -- meta -----------------------------------------------------------------

@test "meta claude emits JSON with cwd and sessionId" {
  run "$EX" meta claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cwd":"/home/u/proj"'* ]]
  [[ "$output" == *'"session_id":"aaaa1111-1111-1111-1111-111111111111"'* ]]
  [[ "$output" == *'"short_id":"aaaa1111"'* ]]
  [[ "$output" == *'"cli":"claude"'* ]]
}

@test "meta copilot falls back to workspace.yaml when session.start cwd is null" {
  run "$EX" meta copilot "$COPILOT_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cwd":"/workspace/demo"'* ]]
  [[ "$output" == *'"model":"gpt-5"'* ]]
  [[ "$output" == *'"session_id":"cccc3333-3333-3333-3333-333333333333"'* ]]
  [[ "$output" != *'"cwd":null'* ]]
}

@test "meta codex reads session_meta record" {
  run "$EX" meta codex "$CODEX_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cwd":"/work/demo"'* ]]
  [[ "$output" == *'"session_id":"eeee5555-5555-5555-5555-555555555555"'* ]]
  [[ "$output" == *'"short_id":"eeee5555"'* ]]
}

@test "meta gemini reads header record and .project_root cwd" {
  run "$EX" meta gemini "$GEMINI_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"cli":"gemini"'* ]]
  [[ "$output" == *'"cwd":"/work/gemini-demo"'* ]]
  [[ "$output" == *'"session_id":"9999aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"'* ]]
  [[ "$output" == *'"short_id":"9999aaaa"'* ]]
  [[ "$output" == *'"model":"gemini-2.5-pro"'* ]]
  [[ "$output" == *'"started_at":"2026-05-06T14:11:01.780Z"'* ]]
}

# -- prompts --------------------------------------------------------------

@test "prompts claude excludes local-command-caveat, tool_result, system-reminder, and raw command-wrapper tags" {
  run "$EX" prompts claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  # Real prompts present:
  [[ "$output" == *"Actually fix the retry loop"* ]]
  [[ "$output" == *"Run the full suite and report"* ]]
  [[ "$output" == *"oPEN pr"* ]]
  # Noise excluded:
  [[ "$output" != *"<local-command-caveat>"* ]]
  [[ "$output" != *"<command-name>"* ]]
  [[ "$output" != *"<command-message>"* ]]
  [[ "$output" != *"<command-args>"* ]]
  [[ "$output" != *"<system-reminder>"* ]]
  [[ "$output" != *"file contents"* ]]
}

@test "prompts claude emits one JSON-encoded string per message (not per line)" {
  run "$EX" prompts claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  # Real prompts (3) + compact slash forms (3) = 6 records.
  local n
  n=$(printf '%s\n' "$output" | grep -cv '^$')
  [ "$n" -eq 6 ]
}

@test "prompts claude keeps multi-line messages atomic (not split by line)" {
  run "$EX" prompts claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  # JSON-encoded two-line message — newline is escaped as \n inside one quoted string.
  [[ "$output" == *'"Run the full suite and report\nevery failure with its stack trace"'* ]]
}

@test "prompts claude renders /slash commands in compact form with args" {
  run "$EX" prompts claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"/simplify"'* ]]
  [[ "$output" == *'"/review-pr #80"'* ]]
  [[ "$output" == *'"/clear"'* ]]
}

@test "prompts claude drops skill body that follows a command wrapper" {
  run "$EX" prompts claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  # Skill body content must not leak into the prompt list.
  [[ "$output" != *"End of skill body"* ]]
  [[ "$output" != *"Simplify: Code Review"* ]]
  [[ "$output" != *"ARGUMENTS: #80"* ]]
}

@test "prompts copilot extracts .data.content (not transformedContent)" {
  run "$EX" prompts copilot "$COPILOT_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"First user prompt"* ]]
  [[ "$output" == *"Second prompt"* ]]
  [[ "$output" != *"<system-reminder>"* ]]
  [[ "$output" != *"<wrapped>"* ]]
}

@test "prompts copilot keeps multi-line messages atomic" {
  run "$EX" prompts copilot "$COPILOT_FILE"
  [ "$status" -eq 0 ]
  local n
  n=$(printf '%s\n' "$output" | grep -cv '^$')
  [ "$n" -eq 3 ]
  [[ "$output" == *'"Multi-line prompt\nwith two lines"'* ]]
}

@test "prompts codex excludes environment_context" {
  run "$EX" prompts codex "$CODEX_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Improve documentation in @README.md"* ]]
  [[ "$output" == *"Go ahead"* ]]
  [[ "$output" != *"<environment_context>"* ]]
}

@test "prompts codex keeps multi-line messages atomic" {
  run "$EX" prompts codex "$CODEX_FILE"
  [ "$status" -eq 0 ]
  local n
  n=$(printf '%s\n' "$output" | grep -cv '^$')
  [ "$n" -eq 3 ]
  [[ "$output" == *'"Refactor this:\n- step one\n- step two"'* ]]
}

@test "prompts gemini extracts text parts and keeps multi-line messages atomic" {
  run "$EX" prompts gemini "$GEMINI_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"First Gemini prompt"'* ]]
  [[ "$output" == *'"Multi-line Gemini prompt\nwith two lines"'* ]]
  [[ "$output" != *"Conversation checkpoint"* ]]
  local n
  n=$(printf '%s\n' "$output" | grep -cv '^$')
  [ "$n" -eq 2 ]
}

# -- turns (assistant tail) -----------------------------------------------

@test "turns claude returns assistant messages in order" {
  run "$EX" turns claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Sure, running tests now."* ]]
  [[ "$output" == *"All 205 tests passed."* ]]
}

@test "turns codex returns assistant messages" {
  run "$EX" turns codex "$CODEX_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"I'll read README.md first."* ]]
  [[ "$output" == *"Done."* ]]
}

@test "turns codex returns empty for shell-only session" {
  run "$EX" turns codex "$CODEX_EMPTY_FILE"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "turns gemini returns non-empty assistant content and dedupes adjacent duplicates" {
  run "$EX" turns gemini "$GEMINI_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"First Gemini reply"* ]]
  [[ "$output" == *"Second Gemini reply"* ]]
  [[ "$output" != *"tool-only thought"* ]]
  local first_rows
  first_rows=$(echo "$output" | grep -c "First Gemini reply")
  [ "$first_rows" -eq 1 ]
}

@test "prompts codex returns empty when only environment_context user record exists" {
  run "$EX" prompts codex "$CODEX_EMPTY_FILE"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "meta codex still parses session_meta on shell-only session" {
  run "$EX" meta codex "$CODEX_EMPTY_FILE"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"session_id":"ffff6666-6666-6666-6666-666666666666"'* ]]
  [[ "$output" == *'"cwd":"/work/empty"'* ]]
}

# -- todos / mirror (Approach B layered fidelity) -------------------------

@test "todos claude emits one JSON line per TodoWrite entry" {
  run "$EX" todos claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  # Two todos in the fixture's TodoWrite tool_use record.
  local count
  count=$(printf '%s\n' "$output" | grep -c .)
  [ "$count" -eq 2 ]
  [[ "$output" == *'"content":"GOAL-FINISH-RETRY-LOOP"'* ]]
  [[ "$output" == *'"status":"in_progress"'* ]]
  [[ "$output" == *'"content":"GOAL-WRITE-REGRESSION-TEST"'* ]]
  [[ "$output" == *'"status":"pending"'* ]]
}

@test "todos non-claude cli emits empty (no carrier today)" {
  run "$EX" todos codex "$CODEX_FILE"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "mirror codex emits each event_msg agent_message in order" {
  run "$EX" mirror codex "$CODEX_FILE"
  [ "$status" -eq 0 ]
  # Two agent_message events in the fixture: "I'll read README.md first." and "Done.".
  local count
  count=$(printf '%s\n' "$output" | grep -c .)
  [ "$count" -eq 2 ]
  [[ "$output" == *"I'll read README.md first."* ]]
  [[ "$output" == *"Done."* ]]
}

@test "mirror non-codex cli emits empty (no event_msg equivalent)" {
  run "$EX" mirror claude "$CLAUDE_FILE"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# -- usage / errors -------------------------------------------------------

@test "missing subcommand exits 64" {
  run "$EX"
  [ "$status" -eq 64 ]
  [[ "$output" == *"usage:"* ]]
}

@test "unknown subcommand exits 64" {
  run "$EX" blarg claude "$CLAUDE_FILE"
  [ "$status" -eq 64 ]
}

@test "unknown cli exits 64" {
  run "$EX" meta bogus "$CLAUDE_FILE"
  [ "$status" -eq 64 ]
  [[ "$output" == *"cli must be one of"* ]]
}

@test "missing file argument exits 64" {
  run "$EX" meta claude
  [ "$status" -eq 64 ]
}

@test "nonexistent file exits 2" {
  run "$EX" meta claude "$TEST_DIR/does-not-exist.jsonl"
  [ "$status" -eq 2 ]
  [[ "$output" == *"file not found"* ]]
}
