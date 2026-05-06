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
#   with_fake_tool_bin    prepend a shim dir to PATH providing a fake <tool>.
#   make_many_codex_sessions     bulk-seed N codex sessions, no sleep.
#   make_many_transport_branches bulk-create N handoff/claude/<short> branches.
#   feed_hook_json        send a PreToolUse JSON payload to a hook script.
#   pass_assert / fail_assert  internal helpers (not for consumer use).

# BATS_TEST_DIRNAME is the directory of the current .bats file.
# REPO_ROOT is four levels up: bats/ → tests/ → harness/ → plugins/ → repo root.
REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)"
export REPO_ROOT

# Scrub host-CLI detection environment variables to ensure tests are hermetic.
unset CLAUDECODE CLAUDE_CODE_SSE_PORT
unset GITHUB_COPILOT_CLI COPILOT_SESSION
unset CODEX_HOME CODEX_SESSION_ID
unset GEMINI_CLI GEMINI_CLI_SESSION
unset GEMINI_CLI_NO_RELAUNCH

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
  with_fake_tool_bin git "$1"
}

# Generalised shim builder. Usage: with_fake_tool_bin <tool-name> <shim-body>
# Inside shim, $1.. are the args <tool-name> was called with. PATH is
# prepended so the shim shadows the real binary. Echoes the shim dir so
# callers can clean up or inspect.
with_fake_tool_bin() {
  local tool="$1"
  local body="$2"
  local dir
  dir=$(mktemp -d)
  cat > "$dir/$tool" <<EOF
#!/usr/bin/env bash
$body
EOF
  chmod +x "$dir/$tool"
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

# set_copilot_workspace_name <home> <uuid> <name>
# Set the top-level `name:` field in a copilot session's workspace.yaml — the
# alias surface for `copilot --resume`'s picker. Use AFTER make_copilot_session_tree
# (which only seeds events.jsonl). Decorative `summary:` companion is set to
# the same value to mirror copilot's actual on-disk format.
set_copilot_workspace_name() {
  local home="$1" uuid="$2" name="$3"
  local dir="$home/.copilot/session-state/$uuid"
  mkdir -p "$dir"
  printf 'id: %s\nname: %s\nsummary: %s\n' "$uuid" "$name" "$name" > "$dir/workspace.yaml"
}

# set_claude_custom_title <session-jsonl-path> <uuid> <title>
# Append a `custom-title` JSONL record (the user-set alias `claude --resume "<name>"`
# stores) to an existing claude session file. Caller is responsible for creating
# the file with its `cwd`/`sessionId` header record first.
set_claude_custom_title() {
  local path="$1" uuid="$2" title="$3"
  printf '{"type":"custom-title","customTitle":"%s","sessionId":"%s"}\n' "$title" "$uuid" >> "$path"
}

# set_claude_ai_title <session-jsonl-path> <uuid> <title>
# Append an `ai-title` JSONL record (the auto-generated TUI summary Claude Code
# emits) to an existing claude session file. Caller is responsible for creating
# the file with its `cwd`/`sessionId` header record first.
set_claude_ai_title() {
  local path="$1" uuid="$2" title="$3"
  printf '{"type":"ai-title","aiTitle":"%s","sessionId":"%s"}\n' "$title" "$uuid" >> "$path"
}

# set_codex_thread_name <rollout-jsonl-path> <uuid> <name>
# Append an `event_msg` thread-rename record (the user-set `codex thread rename`
# alias surface) to an existing codex rollout file. Caller is responsible for
# creating the file with its `session_meta` header record first.
set_codex_thread_name() {
  local path="$1" uuid="$2" name="$3"
  printf '{"type":"event_msg","payload":{"thread_id":"%s","thread_name":"%s","type":"thread_renamed"}}\n' "$uuid" "$name" >> "$path"
}

# make_many_codex_sessions <home> <count>
# Bulk-seed <count> codex sessions under ~/.codex/sessions/2026/04/18/.
# Avoids the per-iteration `sleep 0.01` of `make_codex_session_tree` so 10k
# sessions is fast. Attempts `touch -d` stamps at 1ms steps to produce
# deterministic mtime ordering where supported; silently falls back to
# filesystem-assigned mtimes on platforms without sub-second touch.
# UUIDs are derived from the index so callers can recompute them if needed.
make_many_codex_sessions() {
  local home="$1" count="$2"
  local dir="$home/.codex/sessions/2026/04/18"
  mkdir -p "$dir"
  local i=0
  while (( i < count )); do
    local hex; printf -v hex '%08x' "$i"
    local uuid="${hex}-0000-0000-0000-000000000000"
    local ms; printf -v ms '%03d' $(( i % 1000 ))
    local ss; printf -v ss '%02d' $(( (i / 1000) % 60 ))
    local mm; printf -v mm '%02d' $(( (i / 60000) % 60 ))
    local path="$dir/rollout-2026-04-18T10-${mm}-${ss}-${uuid}.jsonl"
    printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/work"}}\n' \
      "$uuid" > "$path"
    touch -d "2026-04-18 10:${mm}:${ss}.${ms}000000" "$path" 2>/dev/null || true
    i=$((i + 1))
  done
}

# make_many_transport_branches <bare-repo> <count>
# Create <count> branches of shape `handoff/claude/<short-uuid>` on the bare
# repo. All refs point at a single shared commit that carries a valid
# `handoff.md` + `description.txt` — so `pull` works against any of the
# generated short-ids. Uses `git update-ref --stdin` to set all refs in
# one pass; cost is O(N) on the server side, not N round-trips.
make_many_transport_branches() {
  local bare="$1" count="$2"
  local work
  work=$(mktemp -d)
  (
    cd "$work"
    git init -q -b main
    git config user.email "bats@example.test"
    git config user.name "bats"
    cat > handoff.md <<'HEREDOC'
<handoff origin="claude" session="deadbeef" cwd="/bulk" target="claude">

**Summary.** Bulk-seeded handoff.

**User prompts (last 10, in order).**

1. bulk prompt

**Last assistant turns (tail).**

> bulk reply

**Next step.** Continue.

</handoff>
HEREDOC
    echo "handoff:v1:claude:deadbeef:bulk:bats" > description.txt
    git add handoff.md description.txt
    git commit -q -m "bulk seed"
    local sha
    sha=$(git rev-parse HEAD)
    git remote add origin "$bare"
    # Seed a minimal main so ls-remote and refs list cleanly; the
    # binary never reads main itself, but having one is cheaper than
    # branching to handle the empty-repo case in every caller.
    git push -qf origin HEAD:refs/heads/main
    # Build a stdin script for `update-ref` on the bare repo: one
    # `create refs/heads/handoff/claude/<hex> <sha>` line per branch.
    local i=0
    {
      while (( i < count )); do
        local hex; printf -v hex '%08x' "$i"
        printf 'create refs/heads/handoff/claude/%s %s\n' "$hex" "$sha"
        i=$((i + 1))
      done
    } | git --git-dir="$bare" update-ref --stdin
  )
  rm -rf "$work"
}

# make_transport_repo <dir>
# Initialise a bare git repo at <dir>. The handoff binary no longer
# requires any schema pin or init step — push writes directly to
# `handoff/...` branches — so this helper is just a thin wrapper
# around `git init --bare`. Use the returned path as
# DOTCLAUDE_HANDOFF_REPO. Caller is responsible for cleanup.
make_transport_repo() {
  local dir="$1"
  git init -q --bare "$dir"
  echo "$dir"
}

# make_aged_handoff_branch <transport> <branch> <hostname> <cli> <days_ago>
# Push a stub handoff branch with a backdated commit and a metadata.json
# whose `hostname`/`cli` fields match the given values. Used by prune
# tests (and any future test that needs branches at a chosen age) to
# exercise filter/cleanup paths without waiting on a real clock.
make_aged_handoff_branch() {
  local transport="$1" branch="$2" host="$3" cli="$4" days_ago="$5"
  local when; when=$(date -u -d "$days_ago days ago" +"%Y-%m-%dT%H:%M:%S+0000")
  local tmp; tmp=$(mktemp -d)
  (
    cd "$tmp"
    git init -q
    git config user.email handoff@dotclaude.local
    git config user.name dotclaude-handoff
    git checkout -q -b "$branch"
    printf 'stub handoff body for %s\n' "$branch" > handoff.md
    printf '{"cli":"%s","hostname":"%s","short_id":"%s"}\n' \
      "$cli" "$host" "${branch##*/}" > metadata.json
    git add . >/dev/null
    GIT_COMMITTER_DATE="$when" GIT_AUTHOR_DATE="$when" \
      git commit -q -m "fixture" >/dev/null
    git push -q "$transport" "$branch" >/dev/null
  )
  rm -rf "$tmp"
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
