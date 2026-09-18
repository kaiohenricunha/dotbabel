#!/usr/bin/env bats
# P-D3: the opt-in related-tests stage in check-on-stop.sh (KD-12).
#
# This stage RUNS THE REPOSITORY'S TEST SUITE at the end of a turn, which is
# strictly more dangerous than the static checks beside it: a test file is
# arbitrary code that the repository author chose. So it carries two locks,
# not one — an explicit opt-in (CHECK_ON_STOP_TESTS=1) AND the existing trust
# allowlist — and both are asserted here, because a lock that is only claimed
# in a comment is not a lock.
#
# It also emits decision:"block", so the give-up counter must still bound it.
#
# TEST-4: no test sleeps. The timeout case blocks a stub on a FIFO read.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/hooks/check-on-stop.sh"

# Resolved at file scope, BEFORE setup() calls isolate_path — that helper
# REPLACES PATH with a hermetic stub dir, so `mkfifo` is not findable by name
# inside a test body.
MKFIFO_BIN="$(command -v mkfifo || printf '/usr/bin/mkfifo')"

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
  TRUST_DIR=$(mktemp -d)
  TRUST_FILE="$TRUST_DIR/trusted"
  export CHECK_ON_STOP_TRUSTED_FILE="$TRUST_FILE"
  printf '%s\n' "$REPO" > "$TRUST_FILE"
}

teardown() {
  rm_stub_path
  for d in "${STATE_DIR:-}" "${TRUST_DIR:-}" "${REPO:-}" "${FIFO_DIR:-}"; do
    [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d"
  done
  return 0
}

# A changed JavaScript file in a node project, so the tests stage has something
# to scope to.
seed_js() {
  printf '{ "name": "x", "devDependencies": { "vitest": "^2" } }\n' > "$REPO/package.json"
  printf 'export const value = 1;\n' > "$REPO/index.js"
}

@test "check-on-stop: skips related tests unless CHECK_ON_STOP_TESTS is 1" {
  seed_js
  stub_checker npx 1 "" "FAIL index.test.js"
  # Opt-in absent: the stage must not run at all, so npx is never invoked.
  feed_stop_json "$HOOK" false "$REPO"
  run stub_calls npx
  [ -z "$output" ]
}

@test "check-on-stop: skips related tests in an untrusted repository" {
  seed_js
  stub_checker npx 1 "" "FAIL index.test.js"
  # Opt-in PRESENT but the repo is not on the allowlist. The opt-in must not
  # be able to buy its way past trust — otherwise any repo could ship a
  # .envrc or settings file that sets it and get its tests executed.
  : > "$TRUST_FILE"
  CHECK_ON_STOP_TESTS=1 feed_stop_json "$HOOK" false "$REPO"
  run stub_calls npx
  [ -z "$output" ]
}

@test "check-on-stop: runs vitest related for changed JavaScript files in a trusted repository" {
  seed_js
  # The INSTALLED binary, recorded so the argv can be asserted. The hook
  # resolves node_modules/.bin rather than npx, so the stub lives there.
  mkdir -p "$REPO/node_modules/.bin"
  cat > "$REPO/node_modules/.bin/vitest" <<EOS
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REPO/vitest-argv.log"
exit 0
EOS
  chmod +x "$REPO/node_modules/.bin/vitest"
  CHECK_ON_STOP_TESTS=1 feed_stop_json "$HOOK" false "$REPO"
  run cat "$REPO/vitest-argv.log"
  # The runner's OWN scoping, not the whole suite: `vitest related` is what
  # review-pr already uses for exactly this purpose.
  [[ "$output" == *"related"* ]]
  [[ "$output" == *"index.js"* ]]
}

@test "check-on-stop: never downloads a runner that is declared but not installed" {
  # Grepping package.json proves the runner is DECLARED, not INSTALLED. Bare
  # `npx` would fall back to DOWNLOADING it — silently, in a non-interactive
  # hook, at the end of every turn. P-C4 fixed this same bug class one PR ago
  # by resolving ./node_modules/.bin/ instead of trusting npx.
  seed_js   # declares vitest in package.json, but installs no node_modules
  stub_checker npx 0 "" ""
  CHECK_ON_STOP_TESTS=1 feed_stop_json "$HOOK" false "$REPO"
  run stub_calls npx
  [ -z "$output" ]
}

@test "check-on-stop: runs the locally installed runner when node_modules has it" {
  seed_js
  mkdir -p "$REPO/node_modules/.bin"
  cat > "$REPO/node_modules/.bin/vitest" <<'EOS'
#!/usr/bin/env bash
exit 0
EOS
  chmod +x "$REPO/node_modules/.bin/vitest"
  CHECK_ON_STOP_TESTS=1 feed_stop_json "$HOOK" false "$REPO"
  # Passing run: the local binary exists, so the stage runs and stays silent.
  [ "$status" -eq 0 ]
  [[ "$output" != *"block"* ]]
}

@test "check-on-stop: blocks at most 2 times for the same failing test signature" {
  seed_js
  # A failing INSTALLED runner — the hook no longer reaches npx.
  mkdir -p "$REPO/node_modules/.bin"
  cat > "$REPO/node_modules/.bin/vitest" <<'EOS'
#!/usr/bin/env bash
echo "FAIL index.test.js  expected 1 to be 2"
exit 1
EOS
  chmod +x "$REPO/node_modules/.bin/vitest"
  # Same failure three turns running. The give-up counter must stop blocking
  # on the third, or a model that cannot fix the test is trapped in a loop.
  CHECK_ON_STOP_TESTS=1 feed_stop_json "$HOOK" false "$REPO"
  [[ "$output" == *"block"* ]]
  CHECK_ON_STOP_TESTS=1 feed_stop_json "$HOOK" false "$REPO"
  [[ "$output" == *"block"* ]]
  CHECK_ON_STOP_TESTS=1 feed_stop_json "$HOOK" false "$REPO"
  [[ "$output" != *"block"* ]]
}

@test "check-on-stop: stops the tests stage after CHECK_ON_STOP_TIMEOUT seconds" {
  seed_js
  FIFO_DIR=$(mktemp -d)
  export FIFO_DIR
  "$MKFIFO_BIN" "$FIFO_DIR/block"
  # Blocks forever on a FIFO nobody writes to; only the hook's own timeout can
  # end it. A timed-out check is not a code defect, so it must not block.
  cat > "$STUB_BIN/npx" <<EOF
#!/usr/bin/env bash
read -r _ < "$FIFO_DIR/block"
EOF
  chmod +x "$STUB_BIN/npx"
  CHECK_ON_STOP_TESTS=1 CHECK_ON_STOP_TIMEOUT=1 feed_stop_json "$HOOK" false "$REPO"
  [ "$status" -eq 0 ]
  [[ "$output" != *"block"* ]]
}
