#!/usr/bin/env bats
# Security tests for the handoff shell scripts and JS CLI.
# Each test asserts that a hostile input is neutralised (regex gate rejects,
# jq --arg literalises, grep -F disables regex, symlinks don't escape, etc.).

bats_require_minimum_version 1.5.0

load helpers

RESOLVE="$REPO_ROOT/plugins/dotbabel/scripts/handoff-resolve.sh"
EXTRACT="$REPO_ROOT/plugins/dotbabel/scripts/handoff-extract.sh"
HANDOFF_BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-handoff.mjs"

setup() {
  [ -x "$RESOLVE" ] || chmod +x "$RESOLVE"
  [ -x "$EXTRACT" ] || chmod +x "$EXTRACT"
  TEST_HOME=$(mktemp -d)
  export HOME="$TEST_HOME"
  make_claude_session_tree "$TEST_HOME" "aaaa1111-1111-1111-1111-111111111111"
  # Also lay down a codex session for alias-scan tests.
  make_codex_session_tree "$TEST_HOME" "eeee5555-5555-5555-5555-555555555555"
}

teardown() {
  rm -rf "$TEST_HOME"
}

# -- resolve: path traversal + injection ---------------------------------

@test "resolve rejects path traversal identifier" {
  run "$RESOLVE" claude "../../../etc/passwd"
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
  # The script must not have tried to read /etc/passwd under any guise.
  [[ "$output" != *"root:"* ]]
}

@test "resolve does not shell-expand malicious identifier" {
  # If `$id` were interpolated unquoted anywhere, "; touch /tmp/pwned" would fire.
  local canary="$TEST_HOME/pwned-canary"
  run "$RESOLVE" claude "foo; touch $canary"
  [ "$status" -eq 2 ]
  [ ! -e "$canary" ]
}

@test "resolve treats command-substitution-shaped identifier as literal" {
  # `$(...)` must be passed verbatim — it appears in the error string intact,
  # proving it was not evaluated. The literal "$(" sequence in the error is
  # the positive signal; execution would have replaced it with stdout.
  run "$RESOLVE" claude 'x$(echo PWNED)'
  [ "$status" -eq 2 ]
  [[ "$output" == *'x$(echo PWNED)'* ]]
}

# -- resolve: customTitle / alias with shell metachars -------------------

@test "resolve handles customTitle alias with shell metachars" {
  # Seed a fixture session that claims customTitle = literal "; rm -rf /".
  local uuid="cccc1111-1111-1111-1111-111111111111"
  local dir="$TEST_HOME/.claude/projects/-home-user-projects-demo"
  mkdir -p "$dir"
  printf '{"cwd":"/x","sessionId":"%s","version":"2.1"}\n{"type":"custom-title","customTitle":"; rm -rf /","sessionId":"%s"}\n' \
    "$uuid" "$uuid" > "$dir/$uuid.jsonl"
  # The alias scan must find it by literal-match; grep -F + jq --arg keep it safe.
  run --separate-stderr "$RESOLVE" claude "; rm -rf /"
  [ "$status" -eq 0 ]
  [[ "$output" == *"$uuid.jsonl" ]]
}

@test "resolve codex alias with newline does not match spurious records" {
  # Insert a codex rollout with a benign thread_name. Then search for a
  # newline-containing alias. Must not match.
  local uuid="ffff6666-6666-6666-6666-666666666666"
  local path="$TEST_HOME/.codex/sessions/2026/04/18/rollout-2026-04-18T99-00-00-${uuid}.jsonl"
  mkdir -p "$(dirname "$path")"
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/work"}}\n{"type":"event_msg","payload":{"thread_id":"%s","thread_name":"safe","type":"thread_renamed"}}\n' \
    "$uuid" "$uuid" > "$path"
  local alias=$'multi\nline'
  run "$RESOLVE" codex "$alias"
  [ "$status" -eq 2 ]
  [[ "$output" == *"not found"* ]]
}

# -- DOTBABEL_HANDOFF_REPO: ext:: rejection -----------------------------

@test "push rejects ext:: transport URL" {
  DOTBABEL_HANDOFF_REPO='ext::sh -c evil' \
    run node "$HANDOFF_BIN" push latest
  [ "$status" -eq 2 ]
  [[ "$output" == *"DOTBABEL_HANDOFF_REPO"* ]]
  [[ "$output" == *"ext::"* ]]
}

@test "push rejects data: transport URL" {
  DOTBABEL_HANDOFF_REPO='data:text/plain,x' \
    run node "$HANDOFF_BIN" push latest
  [ "$status" -eq 2 ]
  [[ "$output" == *"DOTBABEL_HANDOFF_REPO"* ]]
}

# -- symlink containment ------------------------------------------------

@test "resolve surfaces only *.jsonl-named entries from a symlink that escapes the root" {
  # Dangle a symlink inside ~/.claude/projects/ pointing at /etc. Since #329 the
  # resolver walks with `find -L`, so it DOES follow this link. State the real
  # boundary precisely: containment is -maxdepth plus the -name/-path filter on
  # the basename the LINK carries. It is NOT a bound on where a link points — a
  # link *named* `*.jsonl` is a candidate whatever it targets, as the second
  # fixture below documents. Anyone who can write under a session root is
  # already trusted for this data and could write a real .jsonl instead.
  ln -s /etc "$TEST_HOME/.claude/projects/escape"
  run --separate-stderr "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" != *"/etc/passwd"* ]]
  [[ "$output" == *".jsonl" ]]
}

@test "a *.jsonl-named symlink is a candidate regardless of its target" {
  # The residual of following symlinks, pinned so it is a documented property
  # rather than a surprise. `find -L -type f` stats the target, so a link named
  # `*.jsonl` pointing anywhere readable matches. The filters constrain the
  # name, not the destination.
  # make_claude_session_tree seeds slug `-home-user-projects-demo0`.
  planted="$TEST_HOME/.claude/projects/-home-user-projects-demo0/planted.jsonl"
  ln -s /etc/hostname "$planted"
  run --separate-stderr "$RESOLVE" claude latest
  [ "$status" -eq 0 ]
  [[ "$output" == *".jsonl" ]]
}
