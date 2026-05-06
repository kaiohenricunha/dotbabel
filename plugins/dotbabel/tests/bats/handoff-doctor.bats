#!/usr/bin/env bats
# Behavior tests for plugins/dotbabel/scripts/handoff-doctor.sh.
# Uses fake shims for `git` to simulate each failure state without
# touching real auth.
#
# v0.9.0 collapsed the doctor to a single code path — the script
# takes no arguments and only validates the git transport
# (DOTBABEL_HANDOFF_REPO).

load helpers

DOCTOR="$REPO_ROOT/plugins/dotbabel/scripts/handoff-doctor.sh"

setup() {
  [ -x "$DOCTOR" ] || chmod +x "$DOCTOR"
  SHIM_DIR="$(mktemp -d)"
  export SHIM_DIR
  # Cache the original PATH so teardown can restore /usr/bin even when
  # a test truncated PATH to SHIM_DIR to simulate a missing binary.
  ORIGINAL_PATH="$PATH"
  export ORIGINAL_PATH
}

teardown() {
  PATH="$ORIGINAL_PATH"
  export PATH
  [ -n "${SHIM_DIR:-}" ] && [ -d "$SHIM_DIR" ] && rm -rf "$SHIM_DIR"
}

# shim <name> <body> — write an executable shim and prepend SHIM_DIR to PATH.
shim() {
  local name="$1" body="$2"
  cat > "$SHIM_DIR/$name" <<EOF
#!/usr/bin/env bash
$body
EOF
  chmod +x "$SHIM_DIR/$name"
}

# Hermetic PATH — only contains SHIM_DIR plus the minimum for the script
# itself (awk, tr, date, grep). We inherit /usr/bin so those stay.
hermetic_path() {
  PATH="$SHIM_DIR:/usr/bin:/bin"
  export PATH
}

# Hermetic PATH with one specific binary excluded. Symlinks every utility
# the doctor script relies on (awk, tr, date, grep, etc.) into a fresh
# bin dir, skipping the excluded one. Lets us simulate "X missing" while
# still running the rest of the script.
hermetic_path_without() {
  local exclude="$1"
  local hermetic="$SHIM_DIR/hermetic-bin"
  mkdir -p "$hermetic"
  for util in awk tr date grep sed cat head tail cut mktemp rm bash env sh printf; do
    [[ "$util" == "$exclude" ]] && continue
    local src
    src="$(PATH=/usr/bin:/bin command -v "$util" || true)"
    [[ -n "$src" ]] && ln -sf "$src" "$hermetic/$util"
  done
  PATH="$SHIM_DIR:$hermetic"
  export PATH
}

# --- argv contract -------------------------------------------------------

@test "doctor: takes no arguments after v0.9.0; any positional exits 2" {
  # The script rejects positionals via `exit 2` (usage error in POSIX
  # convention; matches the shebang script's other usage-error paths).
  run "$DOCTOR" git-fallback
  [ "$status" -eq 2 ]
  [[ "$output" == *"removed in v0.9.0"* ]]

  run "$DOCTOR" github
  [ "$status" -eq 2 ]
  [[ "$output" == *"removed in v0.9.0"* ]]
}

@test "doctor: --help prints usage block and exits 0" {
  run "$DOCTOR" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage"* ]] || [[ "$output" == *"handoff-doctor"* ]]
}

# --- single transport (git) ---------------------------------------------

@test "doctor: git-missing when git is not on PATH" {
  hermetic_path_without git
  run "$DOCTOR"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: git-missing"* ]]
}

@test "doctor: prints an info line (exit 0) when env var is empty — auto-bootstrap is the recovery path" {
  shim git 'exit 0'
  hermetic_path
  unset DOTBABEL_HANDOFF_REPO
  run "$DOCTOR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"info: DOTBABEL_HANDOFF_REPO is not set"* ]]
  [[ "$output" == *"will offer to create"* ]]
}

@test "doctor: handoff-repo-unreachable when ls-remote fails" {
  shim git '
# Fail ls-remote; succeed everything else.
if [[ "$1" == "ls-remote" ]]; then
  exit 128
fi
exit 0
'
  hermetic_path
  DOTBABEL_HANDOFF_REPO=git@example.com:fake/repo.git
  export DOTBABEL_HANDOFF_REPO
  run "$DOCTOR"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: handoff-repo-unreachable"* ]]
}

@test "doctor: ok when git present and repo reachable" {
  shim git 'exit 0'
  hermetic_path
  DOTBABEL_HANDOFF_REPO=git@example.com:fake/repo.git
  export DOTBABEL_HANDOFF_REPO
  run "$DOCTOR"
  [ "$status" -eq 0 ]
  [ "$output" = "ok" ]
}
