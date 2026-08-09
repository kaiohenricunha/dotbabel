#!/usr/bin/env bats
# End-to-end race coverage for dotbabel-local-attest.
#
# The unit tests in local-attest-runner.test.mjs simulate a moving HEAD with a
# stubbed `deps.run`. That proves the guard's logic but not that it fires in a
# real repository against real git — and the bug it protects against was only
# ever observed in the wild, when another agent session committed onto the
# branch during a 441-second test leg.
#
# A matrix leg is arbitrary shell, so a leg that runs `git commit` reproduces
# the race exactly: real git, real HEAD movement, real push target. Nothing
# about the code path under test is mocked; only `gh` is faked, because the
# alternative is talking to GitHub.
#
# The load-bearing assertion is the BARE REMOTE's head. If the guard fails,
# `git push` publishes a commit the matrix never ran, and the remote moves.

load helpers

BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-local-attest.mjs"

setup() {
  REPO="$(make_tmp_git_repo)"
  BARE="$REPO-bare.git"
  GH_LOG="$(mktemp)"
  export GH_LOG
  # Record every gh invocation; answer the handful the runner needs.
  with_fake_tool_bin gh '
    printf "%s\n" "$*" >> "$GH_LOG"
    case "$1 $2 $3" in
      "auth status "*)            exit 0 ;;
    esac
    case "$*" in
      "repo view --json nameWithOwner"*) echo "kaio/repo"; exit 0 ;;
      "pr view --json number"*)         echo "42"; exit 0 ;;
      # Report the repo tip so the START-of-run precondition passes.
      "pr view 42 --json headRefOid"*)  git rev-parse HEAD; exit 0 ;;
      "api user"*)                      echo "kaio"; exit 0 ;;
      *permission*)                     echo "ADMIN"; exit 0 ;;
      *comments\ --paginate*)           echo "[]"; exit 0 ;;
    esac
    exit 0
  ' >/dev/null
}

teardown() {
  [ -n "${REPO:-}" ] && rm -rf "$REPO" "$BARE" 2>/dev/null || true
  [ -n "${GH_LOG:-}" ] && rm -f "$GH_LOG" 2>/dev/null || true
}

# Write a config whose matrix is $1 (raw JS array body), and commit it —
# a real project tracks its config, and an untracked file would trip the
# start-of-run clean-tree precondition before the matrix ever ran.
write_config() {
  cat > "$REPO/.local-attest.config.mjs" <<EOF
export default { matrix: [ $1 ] };
EOF
  git -C "$REPO" add .local-attest.config.mjs
  git -C "$REPO" commit -q -m "chore: add local-attest config"
}

@test "local-attest: a leg that commits mid-matrix aborts and pushes nothing" {
  write_config '{ name: "racy", mode: "hard", command: "git commit -q --allow-empty -m concurrent" }'

  remote_before="$(git -C "$BARE" rev-parse main)"

  cd "$REPO"
  run node "$BIN" --pr 42

  # Assert the HARM first, so a regression reports "untested commit was
  # published" rather than the less informative "exit code was not 1".
  # Nothing the matrix did not run may reach the remote.
  [ "$(git -C "$BARE" rev-parse main)" = "$remote_before" ]

  # The commit really happened — this is a genuine race, not a simulated one.
  [ "$(git -C "$REPO" rev-parse HEAD)" != "$remote_before" ]

  [ "$status" -eq 1 ]
  [[ "$output" == *"HEAD moved"* ]]
}

@test "local-attest: aborting on a moved HEAD posts no comment and applies no label" {
  write_config '{ name: "racy", mode: "hard", command: "git commit -q --allow-empty -m concurrent" }'

  cd "$REPO"
  run node "$BIN" --pr 42
  [ "$status" -eq 1 ]

  run grep -E "api --method (POST|PATCH)" "$GH_LOG"
  [ "$status" -eq 1 ]
  run grep -E "pr edit 42 --add-label" "$GH_LOG"
  [ "$status" -eq 1 ]
}

@test "local-attest: aborting on a moved HEAD writes no audit-log entry" {
  write_config '{ name: "racy", mode: "hard", command: "git commit -q --allow-empty -m concurrent" }'

  cd "$REPO"
  run node "$BIN" --pr 42
  [ "$status" -eq 1 ]
  [ ! -f "$REPO/.local-attest-log.jsonl" ]
}

@test "local-attest: a leg that dirties the tree mid-matrix also aborts" {
  write_config '{ name: "dirty", mode: "hard", command: "echo changed >> README.md" }'

  remote_before="$(git -C "$BARE" rev-parse main)"

  cd "$REPO"
  run node "$BIN" --pr 42
  [ "$status" -eq 1 ]
  [[ "$output" == *"dirty"* ]]
  [ "$(git -C "$BARE" rev-parse main)" = "$remote_before" ]
}

@test "local-attest: an unraced run still attests, labels and pushes" {
  # Control: identical setup, a leg that leaves HEAD alone. Without this the
  # abort tests could pass for the wrong reason (e.g. the bin failing early).
  write_config '{ name: "quiet", mode: "hard", command: "true" }'

  # Give the local branch a commit to push so the push is observable.
  git -C "$REPO" commit -q --allow-empty -m "work to publish"
  local_head="$(git -C "$REPO" rev-parse HEAD)"

  cd "$REPO"
  run node "$BIN" --pr 42
  [ "$status" -eq 0 ]

  # Comment posted, label applied, branch pushed.
  run grep -E "api --method POST" "$GH_LOG"
  [ "$status" -eq 0 ]
  run grep -E "pr edit 42 --add-label" "$GH_LOG"
  [ "$status" -eq 0 ]
  [ "$(git -C "$BARE" rev-parse main)" = "$local_head" ]
}

@test "local-attest: --dry-run publishes nothing even when HEAD moves" {
  write_config '{ name: "racy", mode: "hard", command: "git commit -q --allow-empty -m concurrent" }'

  remote_before="$(git -C "$BARE" rev-parse main)"

  cd "$REPO"
  run node "$BIN" --pr 42 --dry-run
  [ "$status" -eq 0 ]
  [ "$(git -C "$BARE" rev-parse main)" = "$remote_before" ]
  run grep -E "api --method (POST|PATCH)" "$GH_LOG"
  [ "$status" -eq 1 ]
}
