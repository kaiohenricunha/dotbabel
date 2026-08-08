#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/hooks/check-on-write.sh
#
# Every test drives the hook via stdin JSON, exactly as Claude Code would, so
# the suite is hermetic and never needs Claude Code installed.
#
# Toolchains are STUBBED, not installed. The hook's contract is dispatch +
# exit-code translation + output plumbing; running the real ruff would test
# ruff. isolate_path() REPLACES PATH so a really-installed checker cannot
# shadow-win and make an "absent" test pass by accident.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/hooks/check-on-write.sh"

setup() {
  [ -x "$HOOK" ] || chmod +x "$HOOK"
  isolate_path
  WORK=$(mktemp -d)
}

teardown() {
  rm_stub_path
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
}

# ---------------- group 1: fail-open floor ----------------
#
# These define the safety contract: the hook must never break an unrelated
# repo, an unrelated tool call, or a machine missing a toolchain.

@test "no-op on unmatched extension" {
  printf 'hello\n' > "$WORK/notes.txt"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/notes.txt"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "no-op on a non-Edit/Write tool_name" {
  printf 'x\n' > "$WORK/a.py"
  stub_checker ruff 1 "" "a.py:1:1: E999 SyntaxError"
  feed_post_tooluse_json "$HOOK" Read "$WORK/a.py"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls ruff)" ]
}

@test "no-op when tool_input.file_path is absent" {
  run bash -c "printf '%s' '{\"tool_name\":\"Edit\",\"tool_input\":{}}' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "no-op on malformed JSON" {
  run bash -c "printf '%s' 'not json at all' | '$HOOK'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "no-op when jq is missing" {
  # Build the payload with the REAL jq before shadowing PATH.
  local payload nojq
  payload=$(jq -n --arg f "$WORK/a.py" '{tool_name:"Edit",tool_input:{file_path:$f}}')
  printf 'x\n' > "$WORK/a.py"
  # bash must stay reachable or the shebang itself fails; jq must not.
  nojq=$(mktemp -d)
  ln -s /bin/bash "$nojq/bash"
  run env PATH="$nojq" /bin/bash -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  rm -rf "$nojq"
}

@test "deleted file is a no-op and the checker is never invoked" {
  stub_checker ruff 1 "" "should not run"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/gone.py"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls ruff)" ]
}

@test "no-op when the toolchain is absent" {
  # /usr/bin/python3 exists on most machines, so isolate_path's /usr/bin is not
  # enough to make the toolchain genuinely absent. Build a PATH holding exactly
  # the utilities the hook itself depends on — and nothing else — so it can
  # still parse its input (i.e. this does not vacuously pass via the
  # jq-missing branch) but finds no Python checker.
  #
  # This list doubles as the hook's pinned runtime dependency set; `git` is
  # deliberately excluded because the hook guards it with command -v.
  local bare payload src
  bare=$(mktemp -d)
  for b in bash cat wc head grep jq timeout; do
    src=$(command -v "$b")
    ln -s "$src" "$bare/$b"
  done
  printf 'def f(\n' > "$WORK/broken.py"
  payload=$(jq -n --arg f "$WORK/broken.py" \
    '{tool_name:"Edit",tool_input:{file_path:$f}}')
  run env PATH="$bare" "$bare/bash" -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  rm -rf "$bare"
}

@test "toolchain shim that lies about being installed is suppressed" {
  # The rustup/pyenv failure mode: on PATH, exits non-zero, but the message is
  # about the toolchain, not the code. Must never reach the model.
  printf 'x\n' > "$WORK/a.py"
  stub_checker ruff 1 "" "error: 'ruff' is not installed for the toolchain '1.82.0'"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.py"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# ---------------- group 2: dispatch table ----------------

@test "dispatches .sh to shellcheck" {
  printf 'echo hi\n' > "$WORK/a.sh"
  stub_checker shellcheck 0
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.sh"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls shellcheck)" == *"$WORK/a.sh"* ]]
}

@test "dispatches .go to gofmt" {
  printf 'package main\n' > "$WORK/a.go"
  stub_checker gofmt 0
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.go"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls gofmt)" == *"$WORK/a.go"* ]]
}

@test "dispatches .py to ruff" {
  printf 'x = 1\n' > "$WORK/a.py"
  stub_checker ruff 0
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.py"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls ruff)" == *"$WORK/a.py"* ]]
}

@test "dispatches .mjs to node" {
  printf 'export const x = 1\n' > "$WORK/a.mjs"
  stub_checker node 0
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.mjs"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls node)" == *"$WORK/a.mjs"* ]]
}

@test "every CHECKERS extension dispatches to its checker" {
  # Table-driven so a new dispatch key cannot land without coverage.
  local -A expect=(
    [sh]=shellcheck [bash]=shellcheck
    [go]=gofmt
    [py]=ruff [pyi]=ruff
    [mjs]=node [cjs]=node
  )
  local ext
  for ext in "${!expect[@]}"; do
    stub_checker "${expect[$ext]}" 0
    printf 'x\n' > "$WORK/a.$ext"
    feed_post_tooluse_json "$HOOK" Edit "$WORK/a.$ext"
    [ "$status" -eq 0 ]
    [[ "$(stub_calls "${expect[$ext]}")" == *"$WORK/a.$ext"* ]]
  done
}

@test "dispatches .R to Rscript" {
  printf 'x <- 1\n' > "$WORK/a.R"
  stub_checker Rscript 0
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.R"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls Rscript)" == *"$WORK/a.R"* ]]
}

@test "deferred languages are a no-op: .rs .java .cs .ts .tsx .jsx and bare .js" {
  # These have no honest per-file check — see the Phase 2 Stop hook. Assert
  # they are silently skipped rather than half-checked.
  #
  # .ts is here rather than in the dispatch group because `node --check` does
  # not honor --experimental-transform-types (verified on Node 22.22.2) and
  # reports a syntax error on the valid `const x: number = 1`. Half-checking
  # TypeScript would fire on nearly every TS file in the repo.
  # C/C++ are here too: gcc -fsyntax-only runs the preprocessor, so an
  # absolute #include leaks file contents into the model transcript, and .h is
  # ambiguous enough that valid C++ headers parse as broken C.
  stub_checker gcc 1 "" "should not run"
  stub_checker g++ 1 "" "should not run"
  local ext
  for ext in rs java cs ts mts cts tsx jsx js c h cc cpp cxx hpp hh; do
    printf 'garbage(((\n' > "$WORK/a.$ext"
    feed_post_tooluse_json "$HOOK" Edit "$WORK/a.$ext"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
  done
  [ -z "$(stub_calls gcc)" ]
  [ -z "$(stub_calls g++)" ]
}

@test "regression: valid TypeScript is never reported as broken" {
  # The specific false positive that got .ts deferred. The stub must REPRODUCE
  # that failure and exit non-zero — a stub exiting 0 would let a re-added TS
  # checker dispatch and still pass, protecting nothing.
  stub_checker node 1 "" "SyntaxError: Missing initializer in const declaration"
  printf 'const x: number = 1\nexport {}\n' > "$WORK/valid.ts"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/valid.ts"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls node)" ]
}

@test "hook never modifies the file it checks" {
  # The load-bearing safety property: read-only by construction is what stops
  # a PostToolUse hook from re-triggering itself into a write loop.
  printf 'def f(\n' > "$WORK/broken.py"
  local before after
  before=$(cksum < "$WORK/broken.py")
  stub_checker ruff 1 "" "broken.py:1:7: E999 SyntaxError"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/broken.py"
  after=$(cksum < "$WORK/broken.py")
  [ "$before" = "$after" ]
}

@test "falls back to python3 when ruff is absent" {
  # The branch every non-Python-dev machine takes, and where the sys.path
  # hijack lived. No ruff stub, so the fallback is forced.
  printf 'def f(\n' > "$WORK/broken.py"
  stub_checker python3 1 "" "SyntaxError: unexpected EOF while parsing"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/broken.py"
  [ "$status" -eq 2 ]
  [[ "$(stub_calls python3)" == *"$WORK/broken.py"* ]]
}

@test "python3 fallback runs isolated so a repo-local ast.py cannot execute" {
  # Regression guard for the confirmed RCE: `python3 -c` prepends CWD to
  # sys.path, so a repo-local ast.py wins the import and its module-level
  # code runs. -I is what prevents that.
  PATH="/usr/bin:/bin"
  command -v python3 >/dev/null || skip "python3 not installed"
  printf 'import os\nopen(os.environ["COW_MARKER"],"w").write("x")\ndef parse(*a,**k): pass\n' \
    > "$WORK/ast.py"
  printf 'x = 1\n' > "$WORK/sample.py"
  local marker="$WORK/PWNED"
  ( cd "$WORK" && COW_MARKER="$marker" bash -c \
      "printf '%s' \"\$1\" | '$HOOK'" _ \
      "$(jq -n --arg f "$WORK/sample.py" '{tool_name:"Edit",tool_input:{file_path:$f}}')" )
  [ ! -e "$marker" ]
}

@test "gitignored files are skipped" {
  git -C "$WORK" init -q
  printf 'ignored/\n' > "$WORK/.gitignore"
  mkdir -p "$WORK/ignored"
  printf 'def f(\n' > "$WORK/ignored/a.py"
  stub_checker ruff 1 "" "a.py:1:1: E999"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/ignored/a.py"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls ruff)" ]
}

@test "a tracked file in the same repo is still checked" {
  # Negative twin: the ignore guard must not degrade into "skip every repo".
  git -C "$WORK" init -q
  printf 'ignored/\n' > "$WORK/.gitignore"
  printf 'def f(\n' > "$WORK/tracked.py"
  stub_checker ruff 1 "" "tracked.py:1:7: E999"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/tracked.py"
  [ "$status" -eq 2 ]
}

@test "files under \$HOME/.claude are skipped" {
  # Stops the hook checking the very tree it is symlinked into.
  mkdir -p "$WORK/home/.claude/hooks"
  printf 'def f(\n' > "$WORK/home/.claude/hooks/a.py"
  stub_checker ruff 1 "" "a.py:1:1: E999"
  local payload
  payload=$(jq -n --arg f "$WORK/home/.claude/hooks/a.py" \
    '{tool_name:"Edit",tool_input:{file_path:$f}}')
  run env HOME="$WORK/home" bash -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls ruff)" ]
}

@test "one noise line discards the entire output" {
  # Pins the "discard the ENTIRE output" policy, not just per-line filtering:
  # gcc aborts at the first missing include and the rest is downstream garbage.
  printf 'x = 1\n' > "$WORK/a.py"
  cat > "$STUB_BIN/ruff" <<'STUB'
#!/usr/bin/env bash
echo "a.py:1:1: E999 SyntaxError: looks like a real finding"
echo "ruff: command not found"
exit 1
STUB
  chmod +x "$STUB_BIN/ruff"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.py"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "extensionless and dotfiles are a no-op" {
  printf 'all:\n' > "$WORK/Makefile"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/Makefile"
  [ "$status" -eq 0 ]
  [ -z "$output" ]

  printf 'alias x=y\n' > "$WORK/.bashrc"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/.bashrc"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "double extension resolves on the last segment" {
  printf 'x = 1\n' > "$WORK/a.test.py"
  stub_checker ruff 0
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.test.py"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls ruff)" == *"$WORK/a.test.py"* ]]
}

@test "extension matching is case-insensitive" {
  printf 'x = 1\n' > "$WORK/A.PY"
  stub_checker ruff 0
  feed_post_tooluse_json "$HOOK" Edit "$WORK/A.PY"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls ruff)" == *"$WORK/A.PY"* ]]
}

@test "relative path is a no-op" {
  stub_checker ruff 0
  feed_post_tooluse_json "$HOOK" Edit "relative/a.py"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls ruff)" ]
}

@test "every denylisted path segment is skipped" {
  stub_checker ruff 1 "" "a.py:1:1: E999 SyntaxError"
  local p
  for p in node_modules vendor .git dist build target .venv __pycache__ .next .cache; do
    mkdir -p "$WORK/$p"
    printf 'def f(\n' > "$WORK/$p/a.py"
    feed_post_tooluse_json "$HOOK" Edit "$WORK/$p/a.py"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
  done
  [ -z "$(stub_calls ruff)" ]
}

@test "generated-file marker is skipped" {
  printf '// Code generated by protoc. DO NOT EDIT.\npackage main\n' > "$WORK/gen.go"
  stub_checker gofmt 1 "" "gen.go:2:1: expected declaration"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/gen.go"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls gofmt)" ]
}

# ---------------- group 3: output plumbing ----------------
#
# The contract that actually matters. Exit 2 + stderr is what surfaces the
# diagnostic to the model; stdout must stay clean.

@test "silent pass on a clean file" {
  printf 'x = 1\n' > "$WORK/clean.py"
  stub_checker ruff 0
  feed_post_tooluse_json "$HOOK" Edit "$WORK/clean.py"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "error on a broken file exits 2 and reports the diagnostic" {
  printf 'def f(\n' > "$WORK/broken.py"
  stub_checker ruff 1 "" "broken.py:1:7: E999 SyntaxError: unexpected EOF"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/broken.py"
  [ "$status" -eq 2 ]
  [[ "$output" == *"E999"* ]]
}

@test "diagnostic goes to stderr, not stdout" {
  printf 'def f(\n' > "$WORK/broken.py"
  stub_checker ruff 1 "" "broken.py:1:7: E999 SyntaxError"
  local payload
  payload=$(jq -n --arg f "$WORK/broken.py" \
    '{tool_name:"Edit",tool_input:{file_path:$f}}')

  # stdout only — must be empty (the first `{`-prefixed line rule means stray
  # stdout would corrupt any future JSON output mode).
  run bash -c "printf '%s' \"\$1\" | '$HOOK' 2>/dev/null" _ "$payload"
  [ -z "$output" ]

  # stderr only — must carry the diagnostic.
  run bash -c "printf '%s' \"\$1\" | '$HOOK' 1>/dev/null" _ "$payload"
  [[ "$output" == *"E999"* ]]
}

@test "style-only findings stay silent" {
  # The chosen failure policy: hard errors report, style does not. A checker
  # that exits 0 while printing advisory text must produce nothing.
  printf 'import os\n' > "$WORK/style.py"
  stub_checker ruff 0 "style.py:1:1: F401 unused import"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/style.py"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "non-zero exit with empty output still produces a message" {
  # Silent failure is worse than noise — the model must learn something ran.
  printf 'x\n' > "$WORK/a.py"
  stub_checker ruff 1
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.py"
  [ "$status" -eq 2 ]
  [ -n "$output" ]
}

@test "long checker output is truncated" {
  printf 'x\n' > "$WORK/a.py"
  cat > "$STUB_BIN/ruff" <<'STUB'
#!/usr/bin/env bash
i=1
while [ "$i" -le 5000 ]; do
  echo "a.py:$i:1: E999 SyntaxError number $i"
  i=$((i + 1))
done
exit 1
STUB
  chmod +x "$STUB_BIN/ruff"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.py"
  [ "$status" -eq 2 ]
  [ "${#lines[@]}" -lt 100 ]
  [[ "$output" == *"truncated"* ]]
}

# ---------------- group 4: paths and guards ----------------

@test "path with spaces round-trips to the checker intact" {
  mkdir -p "$WORK/dir with spaces"
  local f="$WORK/dir with spaces/clean file.py"
  printf 'x = 1\n' > "$f"
  stub_checker ruff 0
  feed_post_tooluse_json "$HOOK" Edit "$f"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls ruff)" == *"$f"* ]]
}

@test "path with a single quote round-trips to the checker intact" {
  local f="$WORK/don't.py"
  printf 'x = 1\n' > "$f"
  stub_checker ruff 0
  feed_post_tooluse_json "$HOOK" Edit "$f"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls ruff)" == *"don't.py"* ]]
}

@test "path with unicode round-trips to the checker intact" {
  local f="$WORK/héllo-ünïcode.py"
  printf 'x = 1\n' > "$f"
  stub_checker ruff 0
  feed_post_tooluse_json "$HOOK" Edit "$f"
  [ "$status" -eq 0 ]
  [[ "$(stub_calls ruff)" == *"héllo-ünïcode.py"* ]]
}

@test "BYPASS_CHECK_ON_WRITE=1 short-circuits" {
  printf 'def f(\n' > "$WORK/broken.py"
  stub_checker ruff 1 "" "broken.py:1:7: E999 SyntaxError"
  local payload
  payload=$(jq -n --arg f "$WORK/broken.py" \
    '{tool_name:"Edit",tool_input:{file_path:$f}}')
  run env BYPASS_CHECK_ON_WRITE=1 bash -c "printf '%s' \"\$1\" | '$HOOK'" _ "$payload"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ -z "$(stub_calls ruff)" ]
}

@test "a hanging checker is killed by the internal timeout" {
  printf 'x\n' > "$WORK/a.py"
  cat > "$STUB_BIN/ruff" <<'STUB'
#!/usr/bin/env bash
sleep 30
STUB
  chmod +x "$STUB_BIN/ruff"
  local start elapsed
  start=$SECONDS
  feed_post_tooluse_json "$HOOK" Edit "$WORK/a.py"
  elapsed=$((SECONDS - start))
  [ "$elapsed" -lt 15 ]
}

@test "oversized files are skipped" {
  # 1MB+ of source is generated by definition.
  head -c 1100000 /dev/zero | tr '\0' 'x' > "$WORK/huge.py"
  stub_checker ruff 1 "" "huge.py:1:1: E999"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/huge.py"
  [ "$status" -eq 0 ]
  [ -z "$(stub_calls ruff)" ]
}

# ---------------- one real end-to-end ----------------

@test "e2e: a shebang-less .sh file is not reported as broken" {
  # SC2148 ("cannot determine the shell dialect") is error-severity, so a bare
  # -S error would flag every sourced fragment that legitimately has no
  # shebang. Regression guard for that false positive.
  PATH="/usr/bin:/bin"
  command -v shellcheck >/dev/null || skip "shellcheck not installed"
  printf 'greet() {\n  echo hi\n}\n' > "$WORK/lib.sh"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/lib.sh"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "e2e: real shellcheck output reaches stderr with exit 2" {
  # The single non-stubbed test. Everything above proves plumbing; this proves
  # the wiring works against a genuine checker.
  PATH="/usr/bin:/bin"
  command -v shellcheck >/dev/null || skip "shellcheck not installed"
  printf '#!/usr/bin/env bash\nif [ -z "$x" ; then echo hi; fi\n' > "$WORK/real.sh"
  feed_post_tooluse_json "$HOOK" Edit "$WORK/real.sh"
  [ "$status" -eq 2 ]
  [ -n "$output" ]
}
