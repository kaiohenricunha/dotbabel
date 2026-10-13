#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/hooks/yolo.sh, the hook behind /yolo.
#
#   grant        UserPromptExpansion: `/yolo <scope>` writes the session's
#                grant, `/yolo off` removes it.
#   permission   PermissionRequest: while the grant lives, it approves the
#                permission dialog, except for the denylist. With no grant it
#                prints nothing, so the dialog shows as it does today.
#   session-end  SessionEnd: removes the session's grant.
#
# "Prints nothing" is the only way the hook declines: a PermissionRequest hook
# that exits 0 with no output leaves the dialog in place.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/hooks/yolo.sh"
SID="11111111-2222-3333-4444-555555555555"

setup() {
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/hooks" "$WORK/home/.claude/sessions"
  # The layout bootstrap.sh creates: ~/.claude/hooks/<hook> -> checkout.
  ln -s "$HOOK" "$WORK/hooks/yolo.sh"
  REPO="$WORK/widget"
  git init -q -b main "$REPO"
  export HOME="$WORK/home" CLAUDE_CONFIG_DIR="$WORK/home/.claude" DOTBABEL_YOLO_STATE_DIR="$WORK/state"
  unset XDG_STATE_HOME BYPASS_DESTRUCTIVE_GIT
  GRANT="$WORK/state/$SID.json"
}

teardown() {
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
  return 0
}

# expand ARGS [NAME] [SID] — a UserPromptExpansion payload into the grant entry.
expand() {
  local payload
  payload=$(jq -cn --arg args "$1" --arg name "${2:-yolo}" --arg sid "${3:-$SID}" --arg cwd "$REPO" \
    '{session_id:$sid, hook_event_name:"UserPromptExpansion", expansion_type:"slash_command",
      command_name:$name, command_args:$args, prompt:("/" + $name + " " + $args), cwd:$cwd}')
  run bash -c 'printf "%s" "$1" | "$2" grant' _ "$payload" "$WORK/hooks/yolo.sh"
}

# ask TOOL INPUT_JSON [HOOK] — a PermissionRequest payload into the gate.
ask() {
  local payload
  payload=$(jq -cn --arg tool "$1" --argjson input "$2" --arg sid "$SID" --arg cwd "$REPO" \
    '{session_id:$sid, hook_event_name:"PermissionRequest", tool_name:$tool, tool_input:$input, cwd:$cwd}')
  run bash -c 'printf "%s" "$1" | "$2" permission' _ "$payload" "${3:-$WORK/hooks/yolo.sh}"
}

ask_bash() {
  ask Bash "$(jq -cn --arg c "$1" '{command:$c}')" "${2:-}"
}

# grant_file SID EXPIRES_IN_SECONDS [MERGE] — write a grant directly.
grant_file() {
  local now
  now=$(date +%s)
  mkdir -p "$WORK/state"
  jq -cn --arg sid "$1" --argjson started "$now" --argjson expires "$((now + $2))" --argjson merge "${3:-true}" \
    '{session_id:$sid, scope:"test scope", merge:$merge, started:$started, expires:$expires}' >"$WORK/state/$1.json"
}

assert_allows() {
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PermissionRequest" ]
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.decision.behavior')" = "allow" ]
}

assert_declines() {
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# ---------------- grant ----------------

@test "grant: /yolo <scope> writes the session's grant for 4 hours by default" {
  expand "finish tifo milestone 1.5 phase 7, merge each PR when green"
  [ "$status" -eq 0 ]
  [ -f "$GRANT" ]
  [ "$(jq -r .session_id "$GRANT")" = "$SID" ]
  [ "$(jq -r .scope "$GRANT")" = "finish tifo milestone 1.5 phase 7, merge each PR when green" ]
  [ "$(jq -r .merge "$GRANT")" = "true" ]
  [ "$(jq -r '.expires - .started' "$GRANT")" = "14400" ]
  ctx=$(printf '%s' "$output" | jq -r '.hookSpecificOutput.additionalContext')
  [[ "$ctx" == *"YOLO GRANT ACTIVE"* ]]
  [[ "$ctx" == *"$GRANT"* ]]
  [[ "$ctx" == *"merge: yes"* ]]
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "UserPromptExpansion" ]
}

@test "grant: the state directory and the grant are private to the user" {
  expand "fix the flaky test"
  [ "$(stat -c %a "$WORK/state")" = "700" ]
  [ "$(stat -c %a "$GRANT")" = "600" ]
}

@test "grant: --for sets the lifetime in hours or minutes" {
  expand "--for 2h fix the flaky test"
  [ "$(jq -r '.expires - .started' "$GRANT")" = "7200" ]
  [ "$(jq -r .scope "$GRANT")" = "fix the flaky test" ]
  expand "fix the flaky test --for 30m"
  [ "$(jq -r '.expires - .started' "$GRANT")" = "1800" ]
}

@test "grant: --for refuses a malformed or over-24-hour lifetime and writes nothing" {
  for bad in "--for soon fix it" "--for 25h fix it" "--for 0h fix it" "fix it --for"; do
    expand "$bad"
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .decision)" = "block" ]
    [ ! -e "$GRANT" ]
  done
}

@test "grant: merges are in scope only when the scope says so" {
  expand "fix the flaky test and open a PR"
  [ "$(jq -r .merge "$GRANT")" = "false" ]
  [[ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.additionalContext')" == *"merge: no"* ]]
  expand "open the PRs but do not merge them"
  [ "$(jq -r .merge "$GRANT")" = "false" ]
  expand "land phase 7, don't merge"
  [ "$(jq -r .merge "$GRANT")" = "false" ]
  expand "land phase 7 and merge when green"
  [ "$(jq -r .merge "$GRANT")" = "true" ]
  expand "land phase 7 --merge"
  [ "$(jq -r .merge "$GRANT")" = "true" ]
  expand "land phase 7 and merge when green --no-merge"
  [ "$(jq -r .merge "$GRANT")" = "false" ]
}

@test "grant: /yolo off removes the grant" {
  expand "fix the flaky test"
  [ -f "$GRANT" ]
  expand "off"
  [ "$status" -eq 0 ]
  [ ! -e "$GRANT" ]
  [[ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.additionalContext')" == *"YOLO GRANT REMOVED"* ]]
}

@test "grant: an empty scope is refused with the usage" {
  expand "   "
  [ "$(printf '%s' "$output" | jq -r .decision)" = "block" ]
  [[ "$(printf '%s' "$output" | jq -r .reason)" == *"/yolo <scope>"* ]]
  [ ! -e "$GRANT" ]
}

@test "grant: a plugin-namespaced command name counts" {
  expand "fix the flaky test" "dotbabel:yolo"
  [ -f "$GRANT" ]
}

@test "grant: another command expands untouched" {
  expand "fix the flaky test" "pr-conductor"
  assert_declines
  [ ! -e "$WORK/state" ]
}

@test "grant: an unsafe session id writes nothing" {
  expand "fix the flaky test" yolo "../../escape"
  [ "$(printf '%s' "$output" | jq -r .decision)" = "block" ]
  [ -z "$(ls -A "$WORK/state" 2>/dev/null)" ]
}

# ---------------- permission: no grant ----------------

@test "permission: with no grant, the three ask rules and every other dialog stay" {
  ask_bash "gh pr merge 12 --squash"
  assert_declines
  ask_bash "git push origin --delete feat/x"
  assert_declines
  ask Skill '{"skill":"pr-conductor"}'
  assert_declines
  ask_bash "npm test"
  assert_declines
}

# ---------------- permission: live grant ----------------

@test "permission: a live grant approves the dialog for ordinary work" {
  grant_file "$SID" 3600
  ask_bash "npm test"
  assert_allows
  ask_bash "git push -u origin feat/yolo"
  assert_allows
  ask Skill '{"skill":"pr-conductor"}'
  assert_allows
  ask Edit "$(jq -cn --arg p "$REPO/src/app.js" '{file_path:$p, old_string:"a", new_string:"b"}')"
  assert_allows
  ask WebFetch '{"url":"https://example.com","prompt":"x"}'
  assert_allows
}

@test "permission: the grant never adds a permission rule" {
  grant_file "$SID" 3600
  ask_bash "npm test"
  assert_allows
  [ "$(printf '%s' "$output" | jq '.hookSpecificOutput.decision | has("updatedPermissions")')" = "false" ]
}

@test "permission: gh pr merge passes only when merges are in the scope" {
  grant_file "$SID" 3600 true
  ask_bash "gh pr merge 12 --squash"
  assert_allows
  ask Skill '{"skill":"merge-pr"}'
  assert_allows
  grant_file "$SID" 3600 false
  ask_bash "gh pr merge 12 --squash"
  assert_declines
  ask Skill '{"skill":"merge-pr"}'
  assert_declines
}

@test "permission: a recursive rm inside the worktree passes" {
  grant_file "$SID" 3600
  ask_bash "rm -rf node_modules dist"
  assert_allows
  ask_bash "rm -rf $REPO/coverage"
  assert_allows
}

@test "permission: each denylist command keeps its dialog under a live grant" {
  grant_file "$SID" 3600
  for cmd in \
    "git push --force origin feat/x" \
    "git push -f origin feat/x" \
    "git push --force-with-lease origin feat/x" \
    "git reset --hard origin/main" \
    "BYPASS_DESTRUCTIVE_GIT=1 git reset --hard HEAD~1" \
    "git branch -D feat/x" \
    "git branch -d feat/x" \
    "git branch --delete feat/x" \
    "git push origin --delete feat/x" \
    "git push origin :feat/x" \
    "git push origin +feat/x" \
    "gh repo delete acme/widget --yes" \
    "gh api -X DELETE repos/acme/widget/git/refs/heads/x" \
    "gh pr merge 12 --squash --delete-branch" \
    "gh pr merge 12 -s -d" \
    "rm -rf /" \
    "rm -rf ~/projects" \
    "rm -rf ../sibling" \
    "rm -rf /tmp/elsewhere" \
    "rm -r -f \$HOME/x" \
    "cd /tmp && rm -rf build" \
    "terraform destroy -auto-approve" \
    "tofu destroy" \
    "terraform apply -destroy" \
    "terragrunt run-all destroy" \
    "vercel --prod" \
    "vercel deploy --prod" \
    "netlify deploy --prod" \
    "flyctl deploy" \
    "fly deploy --app widget" \
    "npm publish" \
    "gh release create v1.0.0"; do
    ask_bash "$cmd"
    [ -z "$output" ] || {
      echo "approved a denylist command: $cmd"
      return 1
    }
  done
}

@test "permission: deploy and release skills keep their dialog" {
  grant_file "$SID" 3600
  for skill in rollback-prod release-conductor flyctl vercel:deploy; do
    ask Skill "$(jq -cn --arg s "$skill" '{skill:$s}')"
    [ -z "$output" ] || {
      echo "approved skill: $skill"
      return 1
    }
  done
}

@test "permission: destructive or deploying MCP tools keep their dialog" {
  grant_file "$SID" 3600
  for tool in mcp__claude_ai_Vercel__create_deployment mcp__claude_ai_Vercel__request_promote \
    mcp__claude_ai_Vercel__request_rollback mcp__github__delete_branch mcp__x__destroy_stack; do
    ask "$tool" '{}'
    [ -z "$output" ] || {
      echo "approved tool: $tool"
      return 1
    }
  done
}

@test "permission: an edit to spec text keeps its dialog" {
  grant_file "$SID" 3600
  for tool in Edit Write MultiEdit; do
    ask "$tool" "$(jq -cn --arg p "$REPO/docs/specs/tifo/spec.md" '{file_path:$p}')"
    assert_declines
  done
  ask NotebookEdit "$(jq -cn --arg p "$REPO/docs/specs/tifo/notes.ipynb" '{notebook_path:$p}')"
  assert_declines
}

# ---------------- permission: expiry and pruning ----------------

@test "permission: an expired grant is ignored and removed" {
  grant_file "$SID" -1
  ask_bash "npm test"
  assert_declines
  [ ! -e "$GRANT" ]
}

@test "permission: a malformed grant is ignored" {
  mkdir -p "$WORK/state"
  printf '{not json' >"$GRANT"
  ask_bash "npm test"
  assert_declines
}

@test "permission: prunes other sessions' expired grants and grants with no live session" {
  local live="aaaaaaaa-0000-0000-0000-000000000001"
  local dead="aaaaaaaa-0000-0000-0000-000000000002"
  local expired="aaaaaaaa-0000-0000-0000-000000000003"
  sleep 600 &
  local peer=$!
  printf '{"pid":%d,"sessionId":"%s"}\n' "$peer" "$live" >"$CLAUDE_CONFIG_DIR/sessions/$peer.json"
  printf '{"pid":%d,"sessionId":"%s"}\n' 999999999 "$dead" >"$CLAUDE_CONFIG_DIR/sessions/999999999.json"
  printf '{"pid":%d,"sessionId":"%s"}\n' "$peer" "$expired" >"$CLAUDE_CONFIG_DIR/sessions/1.json"
  grant_file "$SID" 3600
  grant_file "$live" 3600
  grant_file "$dead" 3600
  grant_file "$expired" -1
  jq -cn '{scope:"x", expires:9999999999}' >"$WORK/state/orphan.json"
  ask_bash "npm test"
  kill "$peer" 2>/dev/null || true
  assert_allows
  [ -f "$GRANT" ]
  [ -f "$WORK/state/$live.json" ]
  [ ! -e "$WORK/state/$dead.json" ]
  [ ! -e "$WORK/state/$expired.json" ]
  [ ! -e "$WORK/state/orphan.json" ]
}

# ---------------- permission: fails closed ----------------

@test "permission: without jq the dialog stays" {
  grant_file "$SID" 3600
  local bin="$WORK/nojq"
  mkdir -p "$bin"
  for tool in bash cat date rm mkdir mv grep sed tr dirname readlink basename chmod git; do
    ln -s "$(command -v "$tool")" "$bin/$tool"
  done
  local payload
  payload=$(jq -cn --arg sid "$SID" '{session_id:$sid, tool_name:"Bash", tool_input:{command:"npm test"}}')
  run env PATH="$bin" bash -c 'printf "%s" "$1" | "$2" permission' _ "$payload" "$WORK/hooks/yolo.sh"
  assert_declines
}

@test "permission: without guard-destructive-git.sh beside it, a Bash dialog stays" {
  grant_file "$SID" 3600
  mkdir -p "$WORK/lonely"
  cp "$HOOK" "$WORK/lonely/yolo.sh"
  ask_bash "npm test" "$WORK/lonely/yolo.sh"
  assert_declines
  ask WebFetch '{"url":"https://example.com","prompt":"x"}' "$WORK/lonely/yolo.sh"
  assert_allows
}

@test "permission: an unknown subcommand prints nothing" {
  grant_file "$SID" 3600
  run bash -c 'printf "{}" | "$1" nonsense' _ "$WORK/hooks/yolo.sh"
  assert_declines
}

# ---------------- session-end ----------------

@test "session-end: removes the session's grant and no other" {
  local other="bbbbbbbb-0000-0000-0000-000000000001"
  grant_file "$SID" 3600
  grant_file "$other" 3600
  run bash -c 'printf "%s" "$1" | "$2" session-end' _ "{\"session_id\":\"$SID\",\"reason\":\"prompt_input_exit\"}" "$WORK/hooks/yolo.sh"
  [ "$status" -eq 0 ]
  [ ! -e "$GRANT" ]
  [ -f "$WORK/state/$other.json" ]
}

# ---------------- shipping ----------------

@test "every shipped copy of the hook is byte-identical to the canonical file" {
  for copy in \
    plugins/dotbabel/templates/claude/hooks/yolo.sh \
    examples/minimal-consumer/.claude/hooks/yolo.sh; do
    run cmp "$HOOK" "$REPO_ROOT/$copy"
    [ "$status" -eq 0 ]
  done
}

@test "the settings template registers the three entries and keeps the three ask rules" {
  for settings in \
    "$REPO_ROOT/plugins/dotbabel/templates/claude/settings.json" \
    "$REPO_ROOT/examples/minimal-consumer/.claude/settings.json"; do
    jq -e '.hooks.UserPromptExpansion[] | select(.matcher == "yolo") | .hooks[].command | test("yolo\\.sh\" grant$")' "$settings"
    jq -e '.hooks.PermissionRequest[].hooks[].command | test("yolo\\.sh\" permission$")' "$settings"
    jq -e '.hooks.SessionEnd[].hooks[].command | test("yolo\\.sh\" session-end$")' "$settings"
    jq -e '.permissions.ask | (index("Skill(pr-conductor)") and index("Bash(gh pr merge:*)") and index("Bash(git push origin --delete:*)"))' "$settings"
  done
}
