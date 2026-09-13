#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/hooks/guard-destructive-git.sh
#
# Every test exercises the hook via stdin JSON, not a real Bash tool call,
# so the suite is hermetic and doesn't depend on Claude Code being installed.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/hooks/guard-destructive-git.sh"

setup() {
  [ -x "$HOOK" ] || chmod +x "$HOOK"
}

# ---------------- block paths ----------------

@test "blocks git reset --hard" {
  feed_hook_json "$HOOK" "git reset --hard HEAD~1"
  [ "$status" -eq 2 ]
  [[ "$output" == *"BLOCKED"* ]]
  [[ "$output" == *"BYPASS_DESTRUCTIVE_GIT=1"* ]]
}

@test "blocks git push --force" {
  feed_hook_json "$HOOK" "git push origin main --force"
  [ "$status" -eq 2 ]
}

@test "blocks git push -f" {
  feed_hook_json "$HOOK" "git push origin main -f"
  [ "$status" -eq 2 ]
}

@test "blocks git push --force-with-lease" {
  feed_hook_json "$HOOK" "git push origin main --force-with-lease"
  [ "$status" -eq 2 ]
}

@test "blocks git clean -fd" {
  feed_hook_json "$HOOK" "git clean -fd"
  [ "$status" -eq 2 ]
}

@test "blocks git clean -fx" {
  feed_hook_json "$HOOK" "git clean -fx"
  [ "$status" -eq 2 ]
}

@test "blocks git checkout ." {
  feed_hook_json "$HOOK" "git checkout ."
  [ "$status" -eq 2 ]
}

@test "blocks git restore ." {
  feed_hook_json "$HOOK" "git restore ."
  [ "$status" -eq 2 ]
}

@test "blocks git checkout ./" {
  feed_hook_json "$HOOK" "git checkout ./"
  [ "$status" -eq 2 ]
}

@test "blocks git restore with an explicit end-of-options separator" {
  feed_hook_json "$HOOK" "git restore -- ."
  [ "$status" -eq 2 ]
}

@test "blocks a wholesale discard as the last token of a chained command" {
  # Not a regression for THIS repo -- the old pattern's `$` alternative already
  # covered a trailing dot. It is pinned because a downstream copy that dropped
  # the `$` (keeping only `\b`) silently failed open on exactly this shape, and
  # `\b` cannot match after a dot at end-of-string. Cheap insurance that the
  # alternation is never "simplified" back to a bare `\b`.
  feed_hook_json "$HOOK" "cd /tmp && git restore ."
  [ "$status" -eq 2 ]
}

@test "blocks git branch -D" {
  feed_hook_json "$HOOK" "git branch -D feature-branch"
  [ "$status" -eq 2 ]
}

@test "blocks git reset --hard with tab whitespace" {
  feed_hook_json "$HOOK" $'git\treset\t--hard'
  [ "$status" -eq 2 ]
}

@test "blocks chained: foo && git reset --hard" {
  feed_hook_json "$HOOK" "cd /tmp && git reset --hard HEAD~1"
  [ "$status" -eq 2 ]
}

# ---------------- allow paths ----------------

@test "allows restoring a single dotfile" {
  # The other half of the same bug: dot -> letter IS a word boundary, so the
  # old pattern blocked every single-file restore of a dotfile while letting
  # the wholesale form through. Restoring one named file is not destructive.
  feed_hook_json "$HOOK" "git restore .gitignore"
  [ "$status" -eq 0 ]
}

@test "allows restoring a dotfile with a compound extension" {
  feed_hook_json "$HOOK" "git restore .prettierrc.json"
  [ "$status" -eq 0 ]
}

@test "allows checking out a single dotfile" {
  feed_hook_json "$HOOK" "git checkout .env.example"
  [ "$status" -eq 0 ]
}

@test "allows restoring a path under a dotted directory" {
  feed_hook_json "$HOOK" "git restore .claude/settings.json"
  [ "$status" -eq 0 ]
}

@test "allows git status" {
  feed_hook_json "$HOOK" "git status"
  [ "$status" -eq 0 ]
}

@test "allows git reset --soft (harmless)" {
  feed_hook_json "$HOOK" "git reset --soft HEAD~1"
  [ "$status" -eq 0 ]
}

@test "allows git push origin main (no force)" {
  feed_hook_json "$HOOK" "git push origin main"
  [ "$status" -eq 0 ]
}

@test "allows non-Bash tool calls" {
  run bash -c 'printf "%s" "$1" | "$2"' _ \
    '{"tool_name":"Read","tool_input":{"path":"foo.txt"}}' \
    "$HOOK"
  [ "$status" -eq 0 ]
}

@test "allows literal 'git reset --hard' inside a quoted echo" {
  # The command itself is not a git invocation — it's an echo of text. The
  # hook should inspect the shell command, which starts with `echo`, not `git`.
  feed_hook_json "$HOOK" 'echo "git reset --hard is dangerous"'
  [ "$status" -eq 0 ]
}

# ---------------- git global options and path forms ----------------
#
# git accepts global options between `git` and the verb, and can be called by
# path. A guard that only matched `git <verb>` let every one of these through.

@test "blocks git -C <dir> branch -D" {
  feed_hook_json "$HOOK" "git -C /tmp/repo branch -D feature-branch"
  [ "$status" -eq 2 ]
}

@test "blocks git -C with a quoted path that contains spaces" {
  feed_hook_json "$HOOK" 'git -C "/tmp/my repo" reset --hard'
  [ "$status" -eq 2 ]
}

@test "blocks git -c <key=value> push --force" {
  feed_hook_json "$HOOK" "git -c core.editor=true push origin main --force"
  [ "$status" -eq 2 ]
}

@test "blocks git --no-pager reset --hard" {
  feed_hook_json "$HOOK" "git --no-pager reset --hard"
  [ "$status" -eq 2 ]
}

@test "blocks git --git-dir=<path> --work-tree <path> clean -fd" {
  feed_hook_json "$HOOK" "git --git-dir=/tmp/repo/.git --work-tree /tmp/repo clean -fd"
  [ "$status" -eq 2 ]
}

@test "blocks git called by an absolute path" {
  feed_hook_json "$HOOK" "/usr/bin/git reset --hard"
  [ "$status" -eq 2 ]
}

@test "blocks git -C <dir> worktree remove --force" {
  feed_hook_json "$HOOK" "git -C /tmp/repo worktree remove --force wt"
  [ "$status" -eq 2 ]
}

@test "allows git -C <dir> status" {
  feed_hook_json "$HOOK" "git -C /tmp/repo status"
  [ "$status" -eq 0 ]
}

@test "allows git -C <dir> branch -d (safe delete)" {
  feed_hook_json "$HOOK" "git -C /tmp/repo branch -d merged-branch"
  [ "$status" -eq 0 ]
}

@test "allows git -C <dir> log whose filter text names a destructive verb" {
  feed_hook_json "$HOOK" 'git -C /tmp/repo log --grep "reset --hard"'
  [ "$status" -eq 0 ]
}

# ---------------- bypass ----------------

@test "BYPASS_DESTRUCTIVE_GIT=1 in the hook environment allows otherwise-blocked command" {
  payload=$(jq -n '{tool_name:"Bash", tool_input:{command:"git reset --hard"}}')
  run env BYPASS_DESTRUCTIVE_GIT=1 bash -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
}

@test "block message names the per-call prefix form" {
  feed_hook_json "$HOOK" "git branch -D feature-branch"
  [ "$status" -eq 2 ]
  [[ "$output" == *"BYPASS_DESTRUCTIVE_GIT=1 git"* ]]
}

# An agent's tool call cannot set the hook's own environment, so the bypass the
# block message documents must work as a prefix on the one confirmed git call.

@test "a BYPASS_DESTRUCTIVE_GIT=1 prefix allows that one git call" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=1 git branch -D feature-branch"
  [ "$status" -eq 0 ]
}

@test "a bypass prefix after a chain separator allows that git call" {
  feed_hook_json "$HOOK" "cd /tmp/repo && BYPASS_DESTRUCTIVE_GIT=1 git branch -D feature-branch"
  [ "$status" -eq 0 ]
}

@test "a bypass prefix allows a git call with global options" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=1 git -C /tmp/repo branch -D feature-branch"
  [ "$status" -eq 0 ]
}

@test "a bypass prefix among other variable assignments allows that git call" {
  feed_hook_json "$HOOK" "GIT_TRACE=0 BYPASS_DESTRUCTIVE_GIT=1 git reset --hard"
  [ "$status" -eq 0 ]
}

@test "a bypass prefix does not cover a second destructive git call" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=1 git branch -D feature-branch && git reset --hard"
  [ "$status" -eq 2 ]
}

@test "a bypass prefix on a non-git command does not allow a later git call" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=1 true; git reset --hard"
  [ "$status" -eq 2 ]
}

@test "a bypass value other than 1 does not allow the git call" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=0 git reset --hard"
  [ "$status" -eq 2 ]
}
