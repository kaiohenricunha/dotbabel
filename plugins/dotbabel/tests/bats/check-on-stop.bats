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

@test "e2e: a repo granted by project-init --trust is trusted by the hook" {
  # The only test that proves the WRITER and the CONSUMER agree on the string
  # format — everything else asserts one side in isolation. Built behind a
  # symlink, because that is where the two could most easily disagree.
  local real linkdir link
  real=$(mktemp -d)
  linkdir=$(mktemp -d)
  link="$linkdir/alias"
  ln -s "$real" "$link"

  git -C "$real" init -q
  git -C "$real" config user.email a@b.c
  git -C "$real" config user.name t
  printf 'module example.com/x\n\ngo 1.21\n' > "$real/go.mod"
  printf 'package main\n\nfunc main() {}\n' > "$real/main.go"
  git -C "$real" add -A && git -C "$real" commit -q -m init
  printf 'package main\n\nfunc main() { _ = 1 }\n' > "$real/main.go"

  # Empty the allowlist first, so only project-init can grant this trust.
  : > "$TRUST_FILE"
  [ -n "$REAL_NODE" ] || skip "node not found before PATH isolation"
  run env PATH="/usr/bin:/bin" CHECK_ON_STOP_TRUSTED_FILE="$TRUST_FILE" \
    "$REAL_NODE" "$REPO_ROOT/plugins/dotbabel/bin/dotbabel-project-init.mjs" \
      --repo "$link" --trust
  [ "$status" -eq 0 ]

  stub_checker go 1 "" "main.go:3: something is wrong"
  feed_stop_json "$HOOK" false "$link"
  [[ "$output" == *'"decision"'* ]]

  rm -rf "$real" "$linkdir"
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

# A stub that records the directory it ran in. The monorepo tests care about
# WHERE the check runs, which argv alone cannot show.
stub_cwd_recorder() {
  local name="$1" rc="${2:-0}"
  cat > "$STUB_BIN/$name" <<STUB
#!/usr/bin/env bash
printf '%s\t%s\n' "$name" "\$PWD" >> "$STUB_LOG"
exit $rc
STUB
  chmod +x "$STUB_BIN/$name"
}

@test "a repo reached through a symlink still runs its checks" {
  # Regression: `git rev-parse --show-toplevel` returns a PHYSICAL path, so the
  # containment test in find_project_root compared a resolved directory against
  # an unresolved $ROOT and never matched — the hook silently ran nothing.
  # Claude Code passes exactly such a path when a session works in a worktree.
  local real linkdir link
  real=$(mktemp -d)
  linkdir=$(mktemp -d)
  link="$linkdir/alias"
  ln -s "$real" "$link"

  git -C "$real" init -q
  git -C "$real" config user.email a@b.c
  git -C "$real" config user.name t
  printf 'module example.com/x\n\ngo 1.21\n' > "$real/go.mod"
  printf 'package main\n\nfunc main() {}\n' > "$real/main.go"
  git -C "$real" add -A && git -C "$real" commit -q -m init
  printf 'package main\n\nfunc main() { _ = 1 }\n' > "$real/main.go"

  printf '%s\n' "$real" > "$TRUST_FILE"
  stub_checker go 0
  feed_stop_json "$HOOK" false "$link"
  [ "$status" -eq 0 ]
  [ -n "$(stub_calls go)" ]

  rm -rf "$real" "$linkdir"
}

@test "monorepo: a marker in a subdirectory is found" {
  # The squadranks shape: go.mod lives at api/go.mod, not at the root. The
  # previous lookup only checked \$ROOT/go.mod, so nothing ever ran.
  mkdir -p "$REPO/api"
  printf 'module example.com/api\n\ngo 1.21\n' > "$REPO/api/go.mod"
  printf 'package main\n\nfunc main() {}\n' > "$REPO/api/main.go"
  stub_checker go 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls go)" == *"vet"* ]]
}

@test "monorepo: the check runs inside the sub-project, not the repo root" {
  mkdir -p "$REPO/api"
  printf 'module example.com/api\n\ngo 1.21\n' > "$REPO/api/go.mod"
  printf 'package main\n' > "$REPO/api/main.go"
  stub_cwd_recorder go 0
  feed_stop_json "$HOOK" false "$REPO"
  [[ "$(stub_calls go)" == *"$REPO/api"* ]]
}

@test "monorepo: two sub-projects of one language each get a check" {
  mkdir -p "$REPO/api" "$REPO/worker"
  printf 'module example.com/api\n\ngo 1.21\n' > "$REPO/api/go.mod"
  printf 'module example.com/worker\n\ngo 1.21\n' > "$REPO/worker/go.mod"
  printf 'package main\n' > "$REPO/api/main.go"
  printf 'package main\n' > "$REPO/worker/main.go"
  stub_cwd_recorder go 0
  feed_stop_json "$HOOK" false "$REPO"
  [[ "$(stub_calls go)" == *"$REPO/api"* ]]
  [[ "$(stub_calls go)" == *"$REPO/worker"* ]]
  [ "$(stub_calls go | wc -l)" -eq 2 ]
}

@test "monorepo: the nearest marker wins" {
  # A file under api/ must use api/go.mod even when the root has one too.
  printf 'module example.com/root\n\ngo 1.21\n' > "$REPO/go.mod"
  mkdir -p "$REPO/api"
  printf 'module example.com/api\n\ngo 1.21\n' > "$REPO/api/go.mod"
  printf 'package main\n' > "$REPO/api/main.go"
  stub_cwd_recorder go 0
  feed_stop_json "$HOOK" false "$REPO"
  [[ "$(stub_calls go)" == *"$REPO/api"* ]]
  [ "$(stub_calls go | wc -l)" -eq 1 ]
}

@test "monorepo: the report names which sub-project failed" {
  mkdir -p "$REPO/api"
  printf 'module example.com/api\n\ngo 1.21\n' > "$REPO/api/go.mod"
  printf 'package main\n' > "$REPO/api/main.go"
  stub_checker go 1 "" "main.go:3: something is wrong"
  feed_stop_json "$HOOK" false "$REPO"
  [[ "$output" == *"[go api]"* ]]
}

@test "a file with no marker anywhere above it runs nothing" {
  # Walking up must stop at the repo top rather than escaping the repo.
  printf 'package main\n' > "$REPO/orphan.go"
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls go)" ]
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

@test "a non-ASCII filename still triggers its check" {
  # core.quotePath defaults on, so without -z git emits `?? "caf\303\251.rs"`
  # and the trailing quote lands in the extension, matching no arm.
  printf '[package]\nname="x"\nversion="0.1.0"\n' > "$REPO/Cargo.toml"
  printf 'fn main() {}\n' > "$REPO/café.rs"
  stub_checker cargo 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -n "$(stub_calls cargo)" ]
}

@test "a non-ASCII directory component still triggers its check" {
  # One accented directory silently disabled checking for everything below it.
  printf '[package]\nname="x"\nversion="0.1.0"\n' > "$REPO/Cargo.toml"
  mkdir -p "$REPO/münchen"
  printf 'fn main() {}\n' > "$REPO/münchen/lib.rs"
  stub_checker cargo 0
  feed_stop_json "$HOOK" false "$REPO"
  [ -n "$(stub_calls cargo)" ]
}

@test "a file in a brand-new untracked directory triggers its check" {
  # The default --untracked-files=normal collapses these to `?? newdir/`,
  # whose basename is empty — so the turn that creates a package was the one
  # turn guaranteed not to be checked.
  seed_go
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m marker
  mkdir -p "$REPO/pkg/newthing"
  printf 'package newthing\n' > "$REPO/pkg/newthing/a.go"
  stub_checker go 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -n "$(stub_calls go)" ]
}

@test "status.showUntrackedFiles=no is overridden" {
  seed_go
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m marker
  git -C "$REPO" config status.showUntrackedFiles no
  printf 'package main\n' > "$REPO/brand_new.go"
  stub_checker go 0
  feed_stop_json "$HOOK" false "$REPO"
  [ -n "$(stub_calls go)" ]
}

@test "a renamed file triggers its check" {
  # Under -z a rename is two records: "R  <new>" then a bare "<old>". The
  # bare record carries no XY prefix and must not have three chars chopped.
  seed_go
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m marker
  git -C "$REPO" mv main.go renamed.go
  stub_checker go 0
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -n "$(stub_calls go)" ]
}

@test "a path with spaces triggers its check" {
  seed_go
  mkdir -p "$REPO/dir with spaces"
  printf 'package x\n' > "$REPO/dir with spaces/file name.go"
  stub_checker go 0
  feed_stop_json "$HOOK" false "$REPO"
  [ -n "$(stub_calls go)" ]
}

@test "still a no-op when nothing changed, under -z" {
  # SAW_CHANGE replaced the old `[ -z "$CHANGED" ]` test; pin it still holds.
  seed_go
  git -C "$REPO" add -A && git -C "$REPO" commit -q -m marker
  stub_checker go 1 "" "should not run"
  feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls go)" ]
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
