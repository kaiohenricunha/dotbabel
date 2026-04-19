#!/usr/bin/env bash
# Shared helpers for the bats suite. Source from every .bats file.
#
#   load helpers
#
# Provides:
#   REPO_ROOT             absolute path to the dotclaude checkout (export).
#   make_tmp_home         mktemp a hermetic $HOME for bootstrap tests.
#   make_tmp_git_repo     mktemp an initialized git repo with an origin remote.
#   with_fake_git_bin     prepend a shim dir to PATH providing a fake `git`.
#   feed_hook_json        send a PreToolUse JSON payload to a hook script.
#   pass_assert / fail_assert  internal helpers (not for consumer use).

# BATS_TEST_DIRNAME is the directory of the current .bats file.
# REPO_ROOT is four levels up: bats/ → tests/ → harness/ → plugins/ → repo root.
REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)"
export REPO_ROOT

make_tmp_home() {
  local dir
  dir=$(mktemp -d)
  mkdir -p "$dir/.claude"
  echo "$dir"
}

make_tmp_git_repo() {
  local dir
  dir=$(mktemp -d)
  (
    cd "$dir"
    git init -q -b main
    git config user.email "bats@example.test"
    git config user.name "bats"
    # Seed an initial commit so `origin/main` exists after the bare-remote push.
    echo "init" > README.md
    git add README.md
    git commit -q -m "init"
  )
  # Stand up a local bare remote so `git fetch origin` works hermetically.
  local bare="$dir-bare.git"
  git clone -q --bare "$dir" "$bare"
  (cd "$dir" && git remote add origin "$bare" && git push -q -u origin main)
  # Return the *working* clone. Bats captures stdout from the last line.
  echo "$dir"
}

# Write a minimal BASH-language shim and prepend its dir to PATH.
# Usage: with_fake_git_bin <shim-body>
# Inside shim, $1.. are the args `git` was called with.
with_fake_git_bin() {
  local body="$1"
  local dir
  dir=$(mktemp -d)
  cat > "$dir/git" <<EOF
#!/usr/bin/env bash
$body
EOF
  chmod +x "$dir/git"
  PATH="$dir:$PATH"
  export PATH
  echo "$dir"
}

# -- handoff session-tree fixtures ----------------------------------------
#
# Each helper seeds a hermetic session tree under $1 (usually an ephemeral
# $HOME created by mktemp in setup()). Callers select which fixtures they
# need — suites that only touch claude don't pay the codex/copilot cost.
# All helpers are idempotent-ish: they create parent directories with -p.

# make_claude_session_tree <home> [uuid1] [uuid2] ...
# Seeds ~/.claude/projects/<slug>/<uuid>.jsonl with one record containing
# cwd + sessionId. Subsequent UUIDs get unique slugs so the resolver finds
# them deterministically. Exports CLAUDE_SESSION_UUIDS (space-separated).
make_claude_session_tree() {
  local home="$1"; shift
  local uuids=("$@")
  [[ ${#uuids[@]} -gt 0 ]] || uuids=("aaaa1111-1111-1111-1111-111111111111")
  local i=0
  for uuid in "${uuids[@]}"; do
    local slug="-home-user-projects-demo${i}"
    local dir="$home/.claude/projects/$slug"
    mkdir -p "$dir"
    printf '{"cwd":"/home/user/projects/demo%d","sessionId":"%s","version":"2.1"}\n' \
      "$i" "$uuid" > "$dir/$uuid.jsonl"
    i=$((i + 1))
    sleep 0.01
  done
  CLAUDE_SESSION_UUIDS="${uuids[*]}"
  export CLAUDE_SESSION_UUIDS
}

# make_copilot_session_tree <home> [uuid1] [uuid2] ...
# Seeds ~/.copilot/session-state/<uuid>/events.jsonl.
make_copilot_session_tree() {
  local home="$1"; shift
  local uuids=("$@")
  [[ ${#uuids[@]} -gt 0 ]] || uuids=("cccc3333-3333-3333-3333-333333333333")
  for uuid in "${uuids[@]}"; do
    local dir="$home/.copilot/session-state/$uuid"
    mkdir -p "$dir"
    printf '{"type":"session.start","data":{"cwd":"/tmp","model":"gpt","sessionId":"%s"}}\n' \
      "$uuid" > "$dir/events.jsonl"
  done
  COPILOT_SESSION_UUIDS="${uuids[*]}"
  export COPILOT_SESSION_UUIDS
}

# make_codex_session_tree <home> [uuid1] [uuid2] ...
# Seeds ~/.codex/sessions/2026/04/18/rollout-<ts>-<uuid>.jsonl.
# Each UUID gets a distinct timestamp so file-ordering is deterministic.
make_codex_session_tree() {
  local home="$1"; shift
  local uuids=("$@")
  [[ ${#uuids[@]} -gt 0 ]] || uuids=("eeee5555-5555-5555-5555-555555555555")
  local dir="$home/.codex/sessions/2026/04/18"
  mkdir -p "$dir"
  local i=0
  local -a paths=()
  for uuid in "${uuids[@]}"; do
    local hh; printf -v hh '%02d' "$i"
    local path="$dir/rollout-2026-04-18T${hh}-00-00-${uuid}.jsonl"
    printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/work"}}\n' \
      "$uuid" > "$path"
    paths+=("$path")
    i=$((i + 1))
  done
  CODEX_SESSION_UUIDS="${uuids[*]}"
  export CODEX_SESSION_UUIDS
}

# make_transport_repo <dir>
# Initialise a bare git repo at <dir>. Use as DOTCLAUDE_HANDOFF_REPO for
# push/pull tests. Caller is responsible for cleanup.
make_transport_repo() {
  local dir="$1"
  git init -q --bare "$dir"
  echo "$dir"
}

# make_session_with_content <path> <content>
# Overwrite the session JSONL at <path> with <content>. Useful for
# boundary tests (empty files, unicode, malformed records).
make_session_with_content() {
  local path="$1" content="$2"
  mkdir -p "$(dirname "$path")"
  printf '%s' "$content" > "$path"
}

# Feed a hook JSON payload to a PreToolUse guard script.
# Usage: feed_hook_json <path-to-hook> <command-string>
# Sets ${status}, ${output}, ${lines[@]} as bats' standard `run` would.
feed_hook_json() {
  local hook="$1"
  local cmd="$2"
  local payload
  # Build the JSON once, then pipe it to the hook. jq -Rs .< the command as a
  # JSON string so embedded quotes/backslashes round-trip safely.
  payload=$(jq -n --arg cmd "$cmd" '{tool_name:"Bash", tool_input:{command:$cmd}}')
  run bash -c "printf '%s' \"\$1\" | '$hook'" _ "$payload"
}
