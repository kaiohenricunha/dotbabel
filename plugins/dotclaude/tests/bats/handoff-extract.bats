#!/usr/bin/env bats
# Behavior tests for plugins/dotclaude/scripts/handoff-extract.sh.
# Subcommands:
#   meta    <cli> <file>   JSON on stdout: {cli, session_id, short_id, cwd, model, started_at}
#   prompts <cli> <file>   Clean user prompts, newline-separated, order preserved
#   turns   <cli> <file>   Last-N assistant turns (default N=20, tail-only)

load helpers

EX="$REPO_ROOT/plugins/dotclaude/scripts/handoff-extract.sh"

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

  # --- Codex fixture: session_meta + env-context first user turn + real prompts ---
  CODEX_FILE="$TEST_DIR/codex.jsonl"
  cat > "$CODEX_FILE" <<'EOF'
{"type":"session_meta","payload":{"id":"eeee5555-5555-5555-5555-555555555555","cwd":"/work/demo","cli_version":"0.121.0","timestamp":"2026-04-18T20:38:53Z","model_provider":"openai"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"<environment_context>shell: zsh\ncwd: /work/demo</environment_context>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"Improve documentation in @README.md"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"I'll read README.md first."}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"Go ahead"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"text","text":"Refactor this:\n- step one\n- step two"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"Done."}]}}
EOF

  export CLAUDE_FILE COPILOT_FILE COPILOT_DIR CODEX_FILE TEST_DIR
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
