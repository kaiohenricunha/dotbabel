#!/usr/bin/env bats
# P-D2: the opt-in pre-push hook (KD-11).
#
# The governing rule is that this hook NEVER TRAPS A PUSH. Only a real policy
# failure (quality exit 1) may block. Everything else — a missing tool, missing
# evidence, a slow check — prints a notice and gets out of the way, because a
# hook that can wedge someone's push gets deleted, and then it protects nothing.
#
# TEST-4: no test sleeps. The timeout case blocks a stub on a FIFO read, so the
# hook's own timeout is what ends it, and the test costs one second rather than
# however long a sleep would have guessed.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/templates/githooks/pre-push"

setup() {
  # NOT `skip` — the template is this unit's deliverable, not an optional
  # environment dependency. A skipped bats test reports `ok`, so skipping here
  # would make the whole file green while the hook did not exist.
  [ -f "$HOOK" ]
  chmod +x "$HOOK" 2>/dev/null || true
  REPO=$(make_tmp_git_repo)
  cd "$REPO" || return 1
  STUB_DIR=$(mktemp -d)
  export STUB_DIR
}

teardown() {
  cd / || true
  rm -rf "${REPO:-/nonexistent}" "${STUB_DIR:-/nonexistent}" "${FIFO_DIR:-/nonexistent}"
}

# Write a fake `dotbabel` that exits with a given code, and put it on PATH.
stub_dotbabel() {
  cat > "$STUB_DIR/dotbabel" <<EOF
#!/usr/bin/env bash
echo "stub dotbabel \$*" >&2
exit $1
EOF
  chmod +x "$STUB_DIR/dotbabel"
  PATH="$STUB_DIR:$PATH"
  export PATH
}

@test "pre-push: blocks the push when the fast profile exits 1" {
  stub_dotbabel 1
  run "$HOOK" origin "https://example.test/repo.git"
  # The one case that may block: the policy actually failed.
  [ "$status" -ne 0 ]
  [[ "$output" == *"quality"* ]] || [[ "$output" == *"blocked"* ]]
}

@test "pre-push: allows the push with a notice when the fast profile exits 2" {
  stub_dotbabel 2
  run "$HOOK" origin "https://example.test/repo.git"
  # Exit 2 is missing evidence or tooling, not a failed policy. Blocking here
  # would trap a push for a condition the author may be unable to fix.
  [ "$status" -eq 0 ]
  [[ "$output" == *"notice"* ]] || [[ "$output" == *"skip"* ]] || [[ "$output" == *"unavailable"* ]]
}

@test "pre-push: allows the push with a notice when the check exceeds DOTBABEL_PRE_PUSH_TIMEOUT" {
  FIFO_DIR=$(mktemp -d)
  export FIFO_DIR
  mkfifo "$FIFO_DIR/block"
  # The stub blocks forever on a FIFO nobody writes to, so the hook's timeout
  # is the only thing that can end it. No sleep, and the bound is the hook's.
  cat > "$STUB_DIR/dotbabel" <<EOF
#!/usr/bin/env bash
read -r _ < "$FIFO_DIR/block"
EOF
  chmod +x "$STUB_DIR/dotbabel"
  PATH="$STUB_DIR:$PATH"
  export PATH

  DOTBABEL_PRE_PUSH_TIMEOUT=1 run "$HOOK" origin "https://example.test/repo.git"
  [ "$status" -eq 0 ]
  [[ "$output" == *"timeout"* ]] || [[ "$output" == *"timed out"* ]]
}

@test "pre-push: skips the check when BYPASS_PRE_PUSH is 1" {
  # The stub would fail the push if it ran at all.
  stub_dotbabel 1
  BYPASS_PRE_PUSH=1 run "$HOOK" origin "https://example.test/repo.git"
  [ "$status" -eq 0 ]
}

@test "pre-push: allows the push with a notice when dotbabel is not installed" {
  # Hermetic PATH with no `dotbabel` anywhere on it.
  isolate_path
  run "$HOOK" origin "https://example.test/repo.git"
  [ "$status" -eq 0 ]
  rm_stub_path
}
