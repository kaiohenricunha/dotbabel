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

# A match exits 0 and prints a PreToolUse "ask" decision, so Claude Code
# prompts the user. A plain allow exits 0 and prints nothing.
assert_asks() {
  [ "$status" -eq 0 ] || return 1
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecision')" = "ask" ] || return 1
  [ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PreToolUse" ]
}

assert_allows() {
  [ "$status" -eq 0 ] || return 1
  [ -z "$output" ]
}

# ---------------- copies ----------------
#
# The hook ships in four places and every case below runs against the
# canonical copy only, so a copy that drifts is never executed by this suite.
# A downstream copy once failed open exactly that way (see the pathspec
# comment in the hook). Pin the copies to the canonical file byte for byte.

@test "every shipped copy of the hook is byte-identical to the canonical file" {
  for copy in \
    .claude/hooks/guard-destructive-git.sh \
    plugins/dotbabel/templates/claude/hooks/guard-destructive-git.sh \
    examples/minimal-consumer/.claude/hooks/guard-destructive-git.sh; do
    run cmp "$HOOK" "$REPO_ROOT/$copy"
    [ "$status" -eq 0 ]
  done
}

# ---------------- ask paths ----------------

@test "asks before git reset --hard" {
  feed_hook_json "$HOOK" "git reset --hard HEAD~1"
  assert_asks
  [[ "$(printf '%s' "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason')" == *"approves"* ]]
}

@test "asks before git push --force" {
  feed_hook_json "$HOOK" "git push origin main --force"
  assert_asks
}

@test "asks before git push -f" {
  feed_hook_json "$HOOK" "git push origin main -f"
  assert_asks
}

@test "asks before git push --force-with-lease" {
  feed_hook_json "$HOOK" "git push origin main --force-with-lease"
  assert_asks
}

@test "asks before git clean -fd" {
  feed_hook_json "$HOOK" "git clean -fd"
  assert_asks
}

@test "asks before git clean -fx" {
  feed_hook_json "$HOOK" "git clean -fx"
  assert_asks
}

@test "asks before git checkout ." {
  feed_hook_json "$HOOK" "git checkout ."
  assert_asks
}

@test "asks before git restore ." {
  feed_hook_json "$HOOK" "git restore ."
  assert_asks
}

@test "asks before git checkout ./" {
  feed_hook_json "$HOOK" "git checkout ./"
  assert_asks
}

@test "asks before git restore with an explicit end-of-options separator" {
  feed_hook_json "$HOOK" "git restore -- ."
  assert_asks
}

@test "asks before a wholesale discard as the last token of a chained command" {
  # Not a regression for THIS repo -- the old pattern's `$` alternative already
  # covered a trailing dot. It is pinned because a downstream copy that dropped
  # the `$` (keeping only `\b`) silently failed open on exactly this shape, and
  # `\b` cannot match after a dot at end-of-string. Cheap insurance that the
  # alternation is never "simplified" back to a bare `\b`.
  feed_hook_json "$HOOK" "cd /tmp && git restore ."
  assert_asks
}

@test "asks before git branch -D" {
  feed_hook_json "$HOOK" "git branch -D feature-branch"
  assert_asks
}

@test "asks before git reset --hard with tab whitespace" {
  feed_hook_json "$HOOK" $'git\treset\t--hard'
  assert_asks
}

@test "asks before chained: foo && git reset --hard" {
  feed_hook_json "$HOOK" "cd /tmp && git reset --hard HEAD~1"
  assert_asks
}

# ---------------- allow paths ----------------

@test "allows restoring a single dotfile" {
  # The other half of the same bug: dot -> letter IS a word boundary, so the
  # old pattern blocked every single-file restore of a dotfile while letting
  # the wholesale form through. Restoring one named file is not destructive.
  feed_hook_json "$HOOK" "git restore .gitignore"
  assert_allows
}

@test "allows restoring a dotfile with a compound extension" {
  feed_hook_json "$HOOK" "git restore .prettierrc.json"
  assert_allows
}

@test "allows checking out a single dotfile" {
  feed_hook_json "$HOOK" "git checkout .env.example"
  assert_allows
}

@test "allows restoring a path under a dotted directory" {
  feed_hook_json "$HOOK" "git restore .claude/settings.json"
  assert_allows
}

@test "allows git status" {
  feed_hook_json "$HOOK" "git status"
  assert_allows
}

@test "allows git reset --soft (harmless)" {
  feed_hook_json "$HOOK" "git reset --soft HEAD~1"
  assert_allows
}

@test "allows git push origin main (no force)" {
  feed_hook_json "$HOOK" "git push origin main"
  assert_allows
}

@test "allows non-Bash tool calls" {
  run bash -c 'printf "%s" "$1" | "$2"' _ \
    '{"tool_name":"Read","tool_input":{"path":"foo.txt"}}' \
    "$HOOK"
  assert_allows
}

@test "allows literal 'git reset --hard' inside a quoted echo" {
  # The command itself is not a git invocation — it's an echo of text. The
  # hook should inspect the shell command, which starts with `echo`, not `git`.
  feed_hook_json "$HOOK" 'echo "git reset --hard is dangerous"'
  assert_allows
}

# ---------------- git global options and path forms ----------------
#
# git accepts global options between `git` and the verb, and can be called by
# path. A guard that only matched `git <verb>` let every one of these through.

@test "asks before git -C <dir> branch -D" {
  feed_hook_json "$HOOK" "git -C /tmp/repo branch -D feature-branch"
  assert_asks
}

@test "asks before git -C with a quoted path that contains spaces" {
  feed_hook_json "$HOOK" 'git -C "/tmp/my repo" reset --hard'
  assert_asks
}

@test "asks before git -c <key=value> push --force" {
  feed_hook_json "$HOOK" "git -c core.editor=true push origin main --force"
  assert_asks
}

@test "asks before git --no-pager reset --hard" {
  feed_hook_json "$HOOK" "git --no-pager reset --hard"
  assert_asks
}

@test "asks before git --git-dir=<path> --work-tree <path> clean -fd" {
  feed_hook_json "$HOOK" "git --git-dir=/tmp/repo/.git --work-tree /tmp/repo clean -fd"
  assert_asks
}

@test "asks before git called by an absolute path" {
  feed_hook_json "$HOOK" "/usr/bin/git reset --hard"
  assert_asks
}

@test "asks before git -C <dir> worktree remove --force" {
  feed_hook_json "$HOOK" "git -C /tmp/repo worktree remove --force wt"
  assert_asks
}

@test "asks before git --namespace <name> reset --hard" {
  feed_hook_json "$HOOK" "git --namespace ns reset --hard"
  assert_asks
}

@test "asks before git --config-env <key>=<var> push --force" {
  feed_hook_json "$HOOK" "git --config-env core.editor=EDITOR push origin main --force"
  assert_asks
}

@test "asks before git --super-prefix <path> clean -fd" {
  feed_hook_json "$HOOK" "git --super-prefix sub/ clean -fd"
  assert_asks
}

@test "asks before git --attr-source <tree> reset --hard" {
  feed_hook_json "$HOOK" "git --attr-source HEAD reset --hard"
  assert_asks
}

@test "asks before git -P branch -D" {
  feed_hook_json "$HOOK" "git -P branch -D feature-branch"
  assert_asks
}

@test "asks before git -c with a value that mixes bare and quoted text" {
  # The common `-c key='value with spaces'` spelling is one shell word that
  # switches quoting mid-token, so an option-value pattern must accept a run
  # of quoted and unquoted pieces, not one or the other.
  feed_hook_json "$HOOK" "git -c core.pager='less -R' reset --hard"
  assert_asks
  feed_hook_json "$HOOK" 'git -c core.pager="less -R" reset --hard'
  assert_asks
}

@test "asks before a destructive git call inside a subshell" {
  feed_hook_json "$HOOK" "(git reset --hard)"
  assert_asks
}

@test "asks before a destructive git call inside a command substitution" {
  feed_hook_json "$HOOK" 'echo "$(git clean -fdx)"'
  assert_asks
  feed_hook_json "$HOOK" 'echo `git branch -D feature-branch`'
  assert_asks
}

@test "asks before a destructive git call split by a backslash-newline" {
  feed_hook_json "$HOOK" $'git push origin main \\\n  --force'
  assert_asks
}

@test "allows git -C <dir> status" {
  feed_hook_json "$HOOK" "git -C /tmp/repo status"
  assert_allows
}

@test "allows git -C <dir> branch -d (safe delete)" {
  feed_hook_json "$HOOK" "git -C /tmp/repo branch -d merged-branch"
  assert_allows
}

@test "allows git -C <dir> log whose filter text names a destructive verb" {
  feed_hook_json "$HOOK" 'git -C /tmp/repo log --grep "reset --hard"'
  assert_allows
}

# ---------------- bypass ----------------

@test "BYPASS_DESTRUCTIVE_GIT=1 in the hook environment allows otherwise-blocked command" {
  payload=$(jq -n '{tool_name:"Bash", tool_input:{command:"git reset --hard"}}')
  run env BYPASS_DESTRUCTIVE_GIT=1 bash -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  assert_allows
}

@test "the ask decision is the only stdout, as one JSON object" {
  feed_hook_json "$HOOK" "git branch -D feature-branch"
  assert_asks
  [ "$(printf '%s\n' "$output" | wc -l)" -eq 1 ]
}

@test "the ask path exits 0, never the exit-2 hard block" {
  # Exit 2 denied the call outright, and the only way past it was a bypass
  # prefix that the auto-mode classifier refuses, so an approved call could
  # never run. Pin the exit code so the hard block cannot return.
  feed_hook_json "$HOOK" "git push origin main --force"
  [ "$status" -ne 2 ]
  assert_asks
}

# A user can still skip the prompt for one call by writing the prefix directly
# before that git call.

@test "a BYPASS_DESTRUCTIVE_GIT=1 prefix allows that one git call" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=1 git branch -D feature-branch"
  assert_allows
}

@test "a bypass prefix after a chain separator allows that git call" {
  feed_hook_json "$HOOK" "cd /tmp/repo && BYPASS_DESTRUCTIVE_GIT=1 git branch -D feature-branch"
  assert_allows
}

@test "a bypass prefix allows a git call with global options" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=1 git -C /tmp/repo branch -D feature-branch"
  assert_allows
}

@test "a bypass prefix among other variable assignments allows that git call" {
  feed_hook_json "$HOOK" "GIT_TRACE=0 BYPASS_DESTRUCTIVE_GIT=1 git reset --hard"
  assert_allows
}

@test "a bypass prefix split from its git call by a backslash-newline still applies" {
  feed_hook_json "$HOOK" $'BYPASS_DESTRUCTIVE_GIT=1 \\\n  git branch -D feature-branch'
  assert_allows
}

@test "a bypass prefix does not cover a second destructive git call" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=1 git branch -D feature-branch && git reset --hard"
  assert_asks
}

@test "a bypass prefix on a non-git command does not allow a later git call" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=1 true; git reset --hard"
  assert_asks
}

@test "a bypass value other than 1 does not allow the git call" {
  feed_hook_json "$HOOK" "BYPASS_DESTRUCTIVE_GIT=0 git reset --hard"
  assert_asks
}

# ---------------- shipped settings ----------------
#
# The hook cannot see `gh pr merge` or a remote branch delete, so the shipped
# settings put both behind a permission prompt. An agent may run them only
# after the user approves, and nothing ships them pre-allowed.

@test "shipped settings ask before a merge or a remote branch delete" {
  for settings in \
    "$REPO_ROOT/plugins/dotbabel/templates/claude/settings.json" \
    "$REPO_ROOT/examples/minimal-consumer/.claude/settings.json"; do
    for rule in 'Bash(gh pr merge:*)' 'Bash(git push origin --delete:*)'; do
      run jq -e --arg r "$rule" '.permissions.ask | index($r)' "$settings"
      [ "$status" -eq 0 ] || {
        echo "missing ask rule $rule in $settings"
        return 1
      }
      run jq -e --arg r "$rule" '(.permissions.allow // []) | index($r) | not' "$settings"
      [ "$status" -eq 0 ] || {
        echo "shipped settings must not pre-allow $rule: $settings"
        return 1
      }
    done
  done
}
