#!/usr/bin/env bash
# Shared helpers for the bats suite. Source from every .bats file.
#
#   load helpers
#
# Provides:
#   REPO_ROOT             absolute path to the dotbabel checkout (export).
#   make_tmp_home         mktemp a hermetic $HOME for bootstrap tests.
#   rm_tmp_home           remove a hermetic $HOME, resilient to async writers.
#   make_tmp_git_repo     mktemp an initialized git repo with an origin remote.
#   with_fake_git_bin     prepend a shim dir to PATH providing a fake `git`.
#   with_fake_tool_bin    prepend a shim dir to PATH providing a fake <tool>.
#   make_many_codex_sessions     bulk-seed N codex sessions, no sleep.
#   make_many_transport_branches bulk-create N handoff/claude/<short> branches.
#   feed_hook_json        send a PreToolUse JSON payload to a hook script.
#   feed_post_tooluse_json  send a PostToolUse JSON payload to a hook script.
#   isolate_path          REPLACE PATH with a hermetic stub dir (not prepend).
#   stub_checker          write a fake checker binary into $STUB_BIN.
#   stub_calls            echo the argv a stub recorded, empty if never called.
#   rm_stub_path          remove the stub dir created by isolate_path.
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

# rm_tmp_home DIR
#
# Remove a hermetic $HOME created by make_tmp_home. A tool invoked under the
# temp $HOME (e.g. the GitHub CLI's background update check) can write into it —
# typically $HOME/.local — asynchronously and race the removal, leaving rm with
# "Directory not empty". Retry a few times, then fall back to best-effort so a
# cleanup race never fails an otherwise-passing test.
rm_tmp_home() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] || return 0
  for _ in 1 2 3 4 5; do
    chmod -R u+rwx "$dir" 2>/dev/null || true
    rm -rf "$dir" 2>/dev/null && return 0
    sleep 0.3
  done
  rm -rf "$dir" 2>/dev/null || true
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

**User prompts (full log, 1).**

1. bulk prompt

**Assistant turns (full, 1).**

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
# DOTBABEL_HANDOFF_REPO. Caller is responsible for cleanup.
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
    git config user.email handoff@dotbabel.local
    git config user.name dotbabel-handoff
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

# Feed a PostToolUse JSON payload to a hook script.
# Usage: feed_post_tooluse_json <path-to-hook> <tool-name> <file-path>
#
# The file path travels inside the JSON via --arg, so spaces, quotes and
# unicode round-trip safely — that is what makes the path-edge-case tests
# meaningful rather than testing the shell's quoting.
# Sets ${status}, ${output}, ${lines[@]} as bats' standard `run` would.
feed_post_tooluse_json() {
  local hook="$1"
  local tool="$2"
  local file="$3"
  local payload
  payload=$(jq -n --arg t "$tool" --arg f "$file" \
    '{tool_name:$t, hook_event_name:"PostToolUse",
      tool_input:{file_path:$f}, tool_response:{filePath:$f, success:true}}')
  run bash -c "printf '%s' \"\$1\" | '$hook'" _ "$payload"
}

# Replace PATH with a hermetic stub dir plus the minimal system dirs.
#
# Use this — NOT with_fake_tool_bin — whenever a test asserts "toolchain
# absent" behavior. Prepending is not enough: ruff/go/cargo/node/gcc are
# really installed on dev machines and would shadow-win, so the absent-path
# tests would pass by accident locally and behave differently in CI.
#
# Exports STUB_BIN (shim dir) and STUB_LOG (call log written by stub shims).
# Call from setup(); bats scopes each test to its own process, so the PATH
# mutation does not leak between tests.
isolate_path() {
  STUB_BIN=$(mktemp -d)
  export STUB_BIN
  STUB_LOG="$STUB_BIN/.calls"
  export STUB_LOG
  : > "$STUB_LOG"
  # Keep bats' own libexec reachable so the harness itself keeps working.
  local keep=""
  if [ -n "${BATS_LIBEXEC:-}" ]; then
    keep=":$BATS_LIBEXEC"
  fi
  PATH="$STUB_BIN:/usr/bin:/bin${keep}"
  export PATH
}

# stub_checker <name> <exit-code> [stdout-line] [stderr-line]
#
# Write a fake checker into $STUB_BIN that appends "<name>\t<argv>" to
# $STUB_LOG, optionally emits a line on stdout and/or stderr, then exits with
# <exit-code>. Requires isolate_path to have run first.
stub_checker() {
  local name="$1"
  local rc="$2"
  local out="${3:-}"
  local err="${4:-}"
  local shim="$STUB_BIN/$name"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf "%%s\\t%%s\\n" %q "$*" >> %q\n' "$name" "$STUB_LOG"
    if [ -n "$out" ]; then
      printf 'printf "%%s\\n" %q\n' "$out"
    fi
    if [ -n "$err" ]; then
      printf 'printf "%%s\\n" %q >&2\n' "$err"
    fi
    printf 'exit %s\n' "$rc"
  } > "$shim"
  chmod +x "$shim"
}

# stub_calls <name> — echo the log lines recorded for <name>; empty if the
# stub was never invoked. Use to assert both dispatch and non-dispatch.
stub_calls() {
  local name="$1"
  if [ ! -f "${STUB_LOG:-/nonexistent}" ]; then
    return 0
  fi
  grep -F "$(printf '%s\t' "$name")" "$STUB_LOG" 2>/dev/null || true
}

# Remove the stub dir created by isolate_path. Safe to call unconditionally.
rm_stub_path() {
  if [ -n "${STUB_BIN:-}" ] && [ -d "$STUB_BIN" ]; then
    rm -rf "$STUB_BIN"
  fi
  return 0
}
