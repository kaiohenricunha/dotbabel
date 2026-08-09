#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/hooks/check-on-stop.sh
#
# The Stop-event counterpart to check-on-write.sh. Where that hook does
# per-file syntax checks after every edit, this one runs project-context
# checks ONCE per turn, when the build graph is supposed to be coherent.
#
# The single most important property under test is loop safety: this hook
# emits decision:"block", which makes Claude keep working. Two independent
# guards must hold — the stop_hook_active field, and a session state file
# that gives up after repeated identical failures.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/hooks/check-on-stop.sh"

setup() {
  [ -x "$HOOK" ] || chmod +x "$HOOK"
  isolate_path
  STATE_DIR=$(mktemp -d)
  export CHECK_ON_STOP_STATE_DIR="$STATE_DIR"
  REPO=$(mktemp -d)
  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email bats@example.test
  git -C "$REPO" config user.name bats
  printf 'seed\n' > "$REPO/README.md"
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m init
  # These checkers run build tooling, so the repo must be allowlisted — and
  # the allowlist lives OUTSIDE the repo, because an in-tree marker is one a
  # hostile repo can simply commit for itself.
  # Deliberately NOT inside $STATE_DIR — the recursion-guard test asserts the
  # state dir is empty, and a trust file there would count as state.
  TRUST_DIR=$(mktemp -d)
  TRUST_FILE="$TRUST_DIR/trusted"
  export CHECK_ON_STOP_TRUSTED_FILE="$TRUST_FILE"
  printf '%s\n' "$REPO" > "$TRUST_FILE"
}

teardown() {
  rm_stub_path
  if [ -n "${STATE_DIR:-}" ] && [ -d "$STATE_DIR" ]; then rm -rf "$STATE_DIR"; fi
  if [ -n "${TRUST_DIR:-}" ] && [ -d "$TRUST_DIR" ]; then rm -rf "$TRUST_DIR"; fi
  if [ -n "${REPO:-}" ] && [ -d "$REPO" ]; then rm -rf "$REPO"; fi
}

# Mark a language as "touched this turn" plus wire up its project marker.
seed_go() {
  printf 'module example.com/x\n\ngo 1.21\n' > "$REPO/go.mod"
  printf 'package main\n\nfunc main() {}\n' > "$REPO/main.go"
}

# ---------------- loop safety (write these first) ----------------

@test "stop_hook_active=true is a no-op — the recursion guard" {
  seed_go
  stub_checker go 1 "" "vet: main.go:3: something is wrong"
  feed_stop_json "$HOOK" true "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls go)" ]
}

@test "recursion guard fires before any state is written" {
  # stop_hook_active must be checked before the state file is touched,
  # otherwise a re-entry corrupts the give-up counter.
  seed_go
  stub_checker go 1 "" "vet failure"
  feed_stop_json "$HOOK" true "$REPO"
  [ "$status" -eq 0 ]
  run bash -c "ls -A '$STATE_DIR' 2>/dev/null | wc -l"
  [ "$output" -eq 0 ]
}

@test "repeated identical failure gives up after two blocks" {
  seed_go
  stub_checker go 1 "" "vet: main.go:3: same failure every time"

  feed_stop_json "$HOOK" false "$REPO" sess-loop
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision"'* ]]

  feed_stop_json "$HOOK" false "$REPO" sess-loop
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision"'* ]]

  # Third identical failure: the model clearly cannot fix it. Stop nagging.
  feed_stop_json "$HOOK" false "$REPO" sess-loop
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a passing run resets the give-up counter" {
  # Must exhaust the counter first and then re-emit the BYTE-IDENTICAL
  # failure: with a different message the signature changes and the run
  # would block regardless of any reset, so the test would prove nothing.
  seed_go
  stub_checker go 1 "" "same failure"
  feed_stop_json "$HOOK" false "$REPO" sess-reset
  [[ "$output" == *'"decision"'* ]]
  feed_stop_json "$HOOK" false "$REPO" sess-reset
  [[ "$output" == *'"decision"'* ]]

  stub_checker go 0
  feed_stop_json "$HOOK" false "$REPO" sess-reset
  [ "$status" -eq 0 ]
  [ -z "$output" ]

  # Counter cleared, so the identical failure blocks again instead of being
  # silenced by the exhausted count.
  stub_checker go 1 "" "same failure"
  feed_stop_json "$HOOK" false "$REPO" sess-reset
  [[ "$output" == *'"decision"'* ]]
}

@test "signature tracks checker output, not just the language set" {
  # Partial progress must keep earning feedback. Same language, different
  # message => new signature => blocks again rather than giving up.
  seed_go
  stub_checker go 1 "" "10 errors remain"
  feed_stop_json "$HOOK" false "$REPO" sess-partial
  feed_stop_json "$HOOK" false "$REPO" sess-partial
  # Counter is now at MAX_BLOCKS for that signature.
  stub_checker go 1 "" "2 errors remain"
  feed_stop_json "$HOOK" false "$REPO" sess-partial
  [[ "$output" == *'"decision"'* ]]
  [[ "$output" == *"2 errors remain"* ]]
}

@test "a different failure signature blocks again rather than giving up" {
  seed_go
  stub_checker go 1 "" "failure A"
  feed_stop_json "$HOOK" false "$REPO" sess-sig
  feed_stop_json "$HOOK" false "$REPO" sess-sig
  # Two identical blocks would normally exhaust the counter...
  printf 'fn main() {}\n' > "$REPO/main.rs"
  printf '[package]\nname="x"\nversion="0.1.0"\n' > "$REPO/Cargo.toml"
  stub_checker cargo 1 "" "failure B"
  feed_stop_json "$HOOK" false "$REPO" sess-sig
  # ...but the signature changed, so this is new information: block.
  [[ "$output" == *'"decision"'* ]]
}

@test "sessions do not share give-up state" {
  seed_go
  stub_checker go 1 "" "same failure"
  feed_stop_json "$HOOK" false "$REPO" sess-A
  feed_stop_json "$HOOK" false "$REPO" sess-A
  feed_stop_json "$HOOK" false "$REPO" sess-A
  [ -z "$output" ]
  # A different session starts with a clean counter.
  feed_stop_json "$HOOK" false "$REPO" sess-B
  [[ "$output" == *'"decision"'* ]]
}

# ---------------- fail-open floor ----------------

@test "no-op when jq is missing" {
  local payload bare src
  payload=$(jq -n --arg c "$REPO" '{hook_event_name:"Stop",cwd:$c,stop_hook_active:false}')
  bare=$(mktemp -d)
  for b in bash cat; do src=$(command -v "$b"); ln -s "$src" "$bare/$b"; done
  run env PATH="$bare" "$bare/bash" -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  rm -rf "$bare"
}

@test "no-op on malformed JSON" {
  run bash -c "printf '%s' 'not json' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "BYPASS_CHECK_ON_STOP=1 short-circuits" {
  seed_go
  stub_checker go 1 "" "vet failure"
  local payload
  payload=$(jq -n --arg c "$REPO" '{hook_event_name:"Stop",cwd:$c,stop_hook_active:false}')
  run env BYPASS_CHECK_ON_STOP=1 bash -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls go)" ]
}

@test "no-op outside a git repo" {
  # Without git there is no way to know what changed this turn.
  local plain
  plain=$(mktemp -d)
  printf 'module example.com/x\n' > "$plain/go.mod"
  printf 'package main\n' > "$plain/main.go"
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$plain"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls go)" ]
  rm -rf "$plain"
}

@test "no-op when the working tree is clean" {
  # Nothing changed this turn — a conversational turn, not an edit turn.
  printf 'module example.com/x\n' > "$REPO/go.mod"
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m marker
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls go)" ]
}

@test "a repo not on the allowlist runs nothing" {
  seed_go
  : > "$TRUST_FILE"
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls go)" ]
}

@test "a missing allowlist file runs nothing" {
  seed_go
  rm -f "$TRUST_FILE"
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls go)" ]
}

@test "a repo cannot grant itself trust with an in-tree marker" {
  # The flaw that killed the first design: authorization read out of the
  # artifact being authorized is not authorization. A hostile repo committing
  # its own marker must gain nothing.
  seed_go
  : > "$TRUST_FILE"
  touch "$REPO/.dotbabel-check-on-stop"
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m "self-signed marker"
  printf 'package main\n\nfunc main() {}\n' > "$REPO/main2.go"
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls go)" ]
}

@test "allowlist matches exactly, not by prefix" {
  # A trusted /srv/app must not confer trust on /srv/app-untrusted.
  seed_go
  printf '%s\n' "${REPO}-untrusted" > "$TRUST_FILE"
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls go)" ]
}

@test "CHECK_ON_STOP_TRUST_ALL=1 overrides the allowlist" {
  seed_go
  : > "$TRUST_FILE"
  stub_checker go 0
  local payload
  payload=$(jq -n --arg c "$REPO" \
    '{session_id:"trust",hook_event_name:"Stop",cwd:$c,stop_hook_active:false}')
  run env CHECK_ON_STOP_TRUST_ALL=1 CHECK_ON_STOP_TRUSTED_FILE="$TRUST_FILE" \
    CHECK_ON_STOP_STATE_DIR="$STATE_DIR" \
    bash -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
  [ -n "$(stub_calls go)" ]
}

# ---------------- gating ----------------

@test "no check runs when only unrelated files changed" {
  printf 'module example.com/x\n' > "$REPO/go.mod"
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m marker
  printf '# docs\n' > "$REPO/NOTES.md"
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls go)" ]
}

@test "no check runs when the project marker is absent" {
  # .go files changed but there is no go.mod — not a Go module.
  printf 'package main\n' > "$REPO/main.go"
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls go)" ]
}

@test "no check runs when the toolchain is absent" {
  seed_go
  # deliberately no `go` stub
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "go: modified .go + go.mod + toolchain dispatches go vet" {
  seed_go
  stub_checker go 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls go)" == *"vet"* ]]
}

@test "rust: modified .rs + Cargo.toml dispatches cargo check" {
  printf '[package]\nname="x"\nversion="0.1.0"\n' > "$REPO/Cargo.toml"
  printf 'fn main() {}\n' > "$REPO/main.rs"
  stub_checker cargo 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls cargo)" == *"check"* ]]
}

@test "typescript: modified .ts + tsconfig.json dispatches tsc --noEmit" {
  printf '{}\n' > "$REPO/tsconfig.json"
  printf 'export const x: number = 1\n' > "$REPO/a.ts"
  stub_checker tsc 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls tsc)" == *"noEmit"* ]]
}

@test "typescript: .tsx also triggers the project typecheck" {
  printf '{}\n' > "$REPO/tsconfig.json"
  printf 'export const C = () => null\n' > "$REPO/a.tsx"
  stub_checker tsc 0
  feed_stop_json "$HOOK" false "$REPO"
  [ -n "$(stub_calls tsc)" ]
}

@test "java: modified .java + pom.xml dispatches mvn" {
  printf '<project/>\n' > "$REPO/pom.xml"
  printf 'class A {}\n' > "$REPO/A.java"
  stub_checker mvn 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -n "$(stub_calls mvn)" ]
}

@test "csharp: modified .cs + .csproj dispatches dotnet build" {
  printf '<Project/>\n' > "$REPO/app.csproj"
  printf 'class A {}\n' > "$REPO/A.cs"
  stub_checker dotnet 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls dotnet)" == *"build"* ]]
}

@test "two touched languages run both checks" {
  seed_go
  printf '[package]\nname="x"\nversion="0.1.0"\n' > "$REPO/Cargo.toml"
  printf 'fn main() {}\n' > "$REPO/main.rs"
  stub_checker go 0
  stub_checker cargo 0
  feed_stop_json "$HOOK" false "$REPO"
  [ -n "$(stub_calls go)" ]
  [ -n "$(stub_calls cargo)" ]
}

# ---------------- output contract ----------------

@test "all checks passing is silent" {
  seed_go
  stub_checker go 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "a failing check emits valid single-line JSON with decision=block" {
  seed_go
  stub_checker go 1 "" "vet: main.go:3: unreachable code"
  # A distinct session id per invocation: three calls on one session would
  # exhaust the give-up counter and the third would (correctly) go silent.
  local p1 p2 p3
  p1=$(jq -n --arg c "$REPO" '{session_id:"j1",hook_event_name:"Stop",cwd:$c,stop_hook_active:false}')
  p2=$(jq -n --arg c "$REPO" '{session_id:"j2",hook_event_name:"Stop",cwd:$c,stop_hook_active:false}')
  p3=$(jq -n --arg c "$REPO" '{session_id:"j3",hook_event_name:"Stop",cwd:$c,stop_hook_active:false}')

  run bash -c "printf '%s' \"\$1\" | '$HOOK' 2>/dev/null" _ "$p1"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 1 ]

  run bash -c "printf '%s' \"\$1\" | '$HOOK' 2>/dev/null | jq -r '.decision'" _ "$p2"
  [ "$output" = "block" ]

  run bash -c "printf '%s' \"\$1\" | '$HOOK' 2>/dev/null | jq -r '.reason'" _ "$p3"
  [[ "$output" == *"unreachable code"* ]]
}

@test "guidance also goes to stderr, not only stdout JSON" {
  # Claude Code's Stop delivery reads `stderr || stdout` for the model-visible
  # body, so the guidance has to be on stderr too.
  seed_go
  stub_checker go 1 "" "vet: main.go:3: unreachable code"
  local payload
  payload=$(jq -n --arg c "$REPO" \
    '{session_id:"s2",hook_event_name:"Stop",cwd:$c,stop_hook_active:false}')
  run bash -c "printf '%s' \"\$1\" | '$HOOK' 1>/dev/null" _ "$payload"
  [[ "$output" == *"unreachable code"* ]]
}

@test "stdout stays empty when nothing failed" {
  # A stray stdout line would be parsed as the hook's JSON payload.
  seed_go
  stub_checker go 0
  local payload
  payload=$(jq -n --arg c "$REPO" \
    '{session_id:"s3",hook_event_name:"Stop",cwd:$c,stop_hook_active:false}')
  run bash -c "printf '%s' \"\$1\" | '$HOOK' 2>/dev/null" _ "$payload"
  [ -z "$output" ]
}

@test "toolchain noise is suppressed rather than reported as a defect" {
  seed_go
  stub_checker go 1 "" "error: 'go' is not installed for the toolchain '1.21'"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "long check output is truncated" {
  seed_go
  cat > "$STUB_BIN/go" <<'STUB'
#!/usr/bin/env bash
i=1
while [ "$i" -le 3000 ]; do echo "main.go:$i:1: problem $i"; i=$((i + 1)); done
exit 1
STUB
  chmod +x "$STUB_BIN/go"
  feed_stop_json "$HOOK" false "$REPO"
  [[ "$output" == *"truncated"* ]]
  [ "${#output}" -lt 8000 ]
}

@test "a hanging check is killed by the internal timeout" {
  seed_go
  cat > "$STUB_BIN/go" <<'STUB'
#!/usr/bin/env bash
sleep 300
STUB
  chmod +x "$STUB_BIN/go"
  local start elapsed
  start=$SECONDS
  CHECK_ON_STOP_TIMEOUT=3 feed_stop_json "$HOOK" false "$REPO"
  elapsed=$((SECONDS - start))
  [ "$elapsed" -lt 20 ]
  # A timeout kill is not a code defect: without the rc 124/137 branch the
  # hook would emit "exited 124 with no output" as a block. Assert silence,
  # and that no give-up state was burned on it.
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -f "$STATE_DIR/bats-session.state" ]
}
