#!/usr/bin/env bats
# Regression tests for #329 — plugins/dotbabel/scripts/handoff-resolve.sh must
# resolve sessions when a CLI's session root, or a directory under it, is a
# symlink. Redirecting CLI state to another volume is routine
# (~/.codex/sessions -> /mnt/storage/cli-state/codex/sessions).
#
# Before the fix, `[[ -d "$root" ]]` passed (test -d dereferences) while
# `find "$root"` in its default -P mode matched the root as -type l, so every
# query shape returned nothing. `handoff list` was unaffected because the Node
# walker calls readdirSync(root), and opendir(3) resolves the path's symlinks —
# which is what made the bug easy to miss.
#
# These tests also pin the two hazards `-L` introduces: a symlink loop must not
# kill the script through pipefail, and a dangling symlink must be skipped.

bats_require_minimum_version 1.5.0

load helpers

RESOLVE="$REPO_ROOT/plugins/dotbabel/scripts/handoff-resolve.sh"

CODEX_UUID="eeee5555-5555-5555-5555-555555555555"
CLAUDE_UUID="aaaa1111-1111-1111-1111-111111111111"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
}

teardown() {
  rm -rf "$TEST_HOME"
}

# Seed a gemini tree; there is no make_gemini_session_tree helper.
seed_gemini() {
  mkdir -p "$TEST_HOME/.gemini/tmp/demo/chats"
  printf '{"sessionId":"9999aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","projectHash":"h","startTime":"2026-04-18T10:30:00.000Z","kind":"main"}\n' \
    > "$TEST_HOME/.gemini/tmp/demo/chats/session-2026-04-18T10-30-9999aaaa.jsonl"
}

# -- symlinked session root ----------------------------------------------

@test "resolve codex latest through a symlinked session root" {
  make_codex_session_tree "$TEST_HOME" "$CODEX_UUID"
  link_session_root "$TEST_HOME" codex

  run --separate-stderr "$RESOLVE" codex latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CODEX_UUID.jsonl" ]]
}

@test "resolve codex full uuid through a symlinked session root" {
  make_codex_session_tree "$TEST_HOME" "$CODEX_UUID"
  link_session_root "$TEST_HOME" codex

  run --separate-stderr "$RESOLVE" codex "$CODEX_UUID"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CODEX_UUID.jsonl" ]]
}

@test "resolve codex short uuid through a symlinked session root" {
  make_codex_session_tree "$TEST_HOME" "$CODEX_UUID"
  link_session_root "$TEST_HOME" codex

  run --separate-stderr "$RESOLVE" codex "${CODEX_UUID:0:8}"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CODEX_UUID.jsonl" ]]
}

@test "resolved path keeps the symlink prefix, not the realpath" {
  # dotbabel-handoff.mjs:cliFromPath tags a resolved file by substring match on
  # "/.codex/sessions/". A path rewritten to its realpath would fall through to
  # the "claude" default and mis-attribute the session, so the resolver must
  # print under the canonical prefix the caller asked for.
  make_codex_session_tree "$TEST_HOME" "$CODEX_UUID"
  link_session_root "$TEST_HOME" codex

  run --separate-stderr "$RESOLVE" codex latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"/.codex/sessions/"* ]]
  [[ "$output" != *"/real-codex/"* ]]
}

@test "resolve claude latest through a symlinked session root" {
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  link_session_root "$TEST_HOME" claude

  run --separate-stderr "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CLAUDE_UUID.jsonl" ]]
}

@test "resolve claude full uuid through a symlinked session root" {
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  link_session_root "$TEST_HOME" claude

  run --separate-stderr "$RESOLVE" claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CLAUDE_UUID.jsonl" ]]
}

@test "resolve claude customTitle alias through a symlinked session root" {
  # The alias path fails for a different reason than the UUID path: the
  # `grep -rl` prefilter DOES follow a symlink named on its command line, so it
  # finds the title, but the resolver then re-finds the file by session id and
  # comes up empty — yielding a bare "no session matches" rather than a hit.
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  set_claude_custom_title \
    "$TEST_HOME/.claude/projects/-home-user-projects-demo0/$CLAUDE_UUID.jsonl" \
    "$CLAUDE_UUID" "my-feature"
  link_session_root "$TEST_HOME" claude

  run --separate-stderr "$RESOLVE" claude "my-feature"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CLAUDE_UUID.jsonl" ]]
  [[ "$stderr" == *"matched-field=customTitle"* ]]
}

@test "resolve copilot latest through a symlinked session root" {
  make_copilot_session_tree "$TEST_HOME"
  link_session_root "$TEST_HOME" copilot

  run --separate-stderr "$RESOLVE" copilot latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"events.jsonl" ]]
}

@test "resolve gemini latest through a symlinked session root" {
  seed_gemini
  link_session_root "$TEST_HOME" gemini

  run --separate-stderr "$RESOLVE" gemini latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"/chats/session-"*".jsonl" ]]
}

@test "resolve any latest spans symlinked and real roots" {
  make_codex_session_tree "$TEST_HOME" "$CODEX_UUID"
  link_session_root "$TEST_HOME" codex
  seed_gemini   # left as a real directory
  # Make the codex rollout newest so `any latest` must reach through the link.
  touch "$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T00-00-00-${CODEX_UUID}.jsonl"

  run --separate-stderr "$RESOLVE" any latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CODEX_UUID.jsonl" ]]
}

@test "resolve follows a symlinked project directory nested inside a root" {
  # The root itself is real; a single project directory is redirected.
  make_claude_session_tree "$TEST_HOME" "$CLAUDE_UUID"
  mv "$TEST_HOME/.claude/projects/-home-user-projects-demo0" "$TEST_HOME/elsewhere"
  ln -s "$TEST_HOME/elsewhere" "$TEST_HOME/.claude/projects/-home-user-projects-demo0"

  run --separate-stderr "$RESOLVE" claude "$CLAUDE_UUID"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CLAUDE_UUID.jsonl" ]]
}

# -- hazards introduced by -L --------------------------------------------

@test "a symlink loop under a session root does not kill the resolver" {
  # `find -L` prints "File system loop detected" and exits 1. stderr is
  # discarded, and `set -euo pipefail` would turn that exit into a bare exit 1
  # with no message — neither the documented 0 nor the documented 2.
  make_codex_session_tree "$TEST_HOME" "$CODEX_UUID"
  ln -s "$TEST_HOME/.codex/sessions" "$TEST_HOME/.codex/sessions/2026/loop"

  run --separate-stderr "$RESOLVE" codex latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CODEX_UUID.jsonl" ]]
}

@test "a symlink loop with no resolvable session still exits 2 with a message" {
  mkdir -p "$TEST_HOME/.codex/sessions/2026"
  ln -s "$TEST_HOME/.codex/sessions" "$TEST_HOME/.codex/sessions/2026/loop"

  run --separate-stderr "$RESOLVE" codex latest
  [ "$status" -eq 2 ]
  [[ "$stderr" == *"no codex sessions found"* ]]
}

@test "a dangling symlink under a session root is skipped" {
  make_codex_session_tree "$TEST_HOME" "$CODEX_UUID"
  ln -s "$TEST_HOME/gone" "$TEST_HOME/.codex/sessions/2026/04/18/rollout-dangling.jsonl"
  ln -s "$TEST_HOME/gone-dir" "$TEST_HOME/.codex/sessions/2026/dangling"

  run --separate-stderr "$RESOLVE" codex latest
  [ "$status" -eq 0 ]
  [[ "$output" == *"$CODEX_UUID.jsonl" ]]
}
