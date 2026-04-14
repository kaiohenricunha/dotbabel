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
