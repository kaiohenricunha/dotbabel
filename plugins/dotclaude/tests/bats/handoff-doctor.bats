#!/usr/bin/env bats
# Behavior tests for plugins/dotclaude/scripts/handoff-doctor.sh.
# Uses fake shims for `gh`, `curl`, and `git` to simulate each failure
# state without touching real auth.

load helpers

DOCTOR="$REPO_ROOT/plugins/dotclaude/scripts/handoff-doctor.sh"

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

@test "doctor: usage error on missing transport" {
  run "$DOCTOR"
  [ "$status" -eq 2 ]
  [[ "$output" == *"usage"* ]]
}

@test "doctor: usage error on unknown transport" {
  run "$DOCTOR" bogus-transport
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown transport"* ]]
}

# --- github transport ---

@test "doctor github: gh-missing when gh is not on PATH" {
  hermetic_path_without gh
  # No gh shim — command -v gh returns false.
  run "$DOCTOR" github
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: gh-missing"* ]]
  [[ "$output" == *"install gh"* ]]
  [[ "$output" == *"--via gist-token"* ]]
  [[ "$output" == *"--via git-fallback"* ]]
}

@test "doctor github: gh-unauthenticated when gh auth status fails" {
  shim gh '
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  echo "not authenticated" >&2
  exit 1
fi
exit 0
'
  hermetic_path
  run "$DOCTOR" github
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: gh-unauthenticated"* ]]
  [[ "$output" == *"gh auth login -h github.com -s gist"* ]]
}

@test "doctor github: network-unreachable when gh api / fails" {
  shim gh '
case "$1" in
  auth)
    [[ "$2" == "status" ]] && exit 0
    ;;
  api)
    [[ "$2" == "/" ]] && exit 1
    ;;
esac
exit 0
'
  hermetic_path
  run "$DOCTOR" github
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: network-unreachable"* ]]
}

@test "doctor github: gist-scope-missing when token lacks gist scope" {
  shim gh '
case "$1" in
  auth)
    [[ "$2" == "status" ]] && exit 0
    ;;
  api)
    # gh api user -i — emit headers with X-Oauth-Scopes but no gist.
    if [[ "$2" == "user" && "$3" == "-i" ]]; then
      printf "X-Oauth-Scopes: read:org, repo\r\n"
      exit 0
    fi
    # gh api / — success
    [[ "$2" == "/" ]] && exit 0
    ;;
esac
exit 0
'
  hermetic_path
  run "$DOCTOR" github
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: gist-scope-missing"* ]]
  [[ "$output" == *"gh auth refresh -h github.com -s gist"* ]]
}

@test "doctor github: ok when all checks pass" {
  shim gh '
case "$1" in
  auth)
    [[ "$2" == "status" ]] && exit 0
    ;;
  api)
    if [[ "$2" == "user" && "$3" == "-i" ]]; then
      printf "X-Oauth-Scopes: gist, repo\r\n"
      exit 0
    fi
    [[ "$2" == "/" ]] && exit 0
    ;;
esac
exit 0
'
  hermetic_path
  run "$DOCTOR" github
  [ "$status" -eq 0 ]
  [ "$output" = "ok: github" ]
}

# --- gist-token transport ---

@test "doctor gist-token: curl-missing when curl is not on PATH" {
  hermetic_path_without curl
  run "$DOCTOR" gist-token
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: curl-missing"* ]]
}

@test "doctor gist-token: token-missing when env var is empty" {
  shim curl 'exit 0'
  hermetic_path
  unset DOTCLAUDE_GH_TOKEN
  run "$DOCTOR" gist-token
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: token-missing"* ]]
  [[ "$output" == *"DOTCLAUDE_GH_TOKEN"* ]]
}

@test "doctor gist-token: network-unreachable when curl returns HTTP 000" {
  shim curl '
for arg in "$@"; do
  if [[ "$arg" == "%{http_code}" ]]; then
    printf "000"
    exit 0
  fi
done
exit 0
'
  hermetic_path
  DOTCLAUDE_GH_TOKEN=faketoken
  export DOTCLAUDE_GH_TOKEN
  run "$DOCTOR" gist-token
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: network-unreachable"* ]]
}

@test "doctor gist-token: token-invalid when /user returns 401" {
  # Two curl invocations: /user (with -o /dev/null -w http_code) and HEAD (-I).
  # Shim returns 401 for the first call.
  shim curl '
# When -w is present, caller wants http_code only on stdout.
for arg in "$@"; do
  if [[ "$arg" == "%{http_code}" ]]; then
    printf "401"
    exit 0
  fi
done
# Otherwise (HEAD call), emit empty headers.
exit 0
'
  hermetic_path
  DOTCLAUDE_GH_TOKEN=faketoken
  export DOTCLAUDE_GH_TOKEN
  run "$DOCTOR" gist-token
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: token-invalid"* ]]
  [[ "$output" == *"HTTP 401"* ]]
}

@test "doctor gist-token: token-scope-missing when /user lacks gist scope" {
  shim curl '
for arg in "$@"; do
  if [[ "$arg" == "%{http_code}" ]]; then
    printf "200"
    exit 0
  fi
done
# HEAD response: scopes without gist.
printf "X-Oauth-Scopes: repo, read:org\r\n"
exit 0
'
  hermetic_path
  DOTCLAUDE_GH_TOKEN=faketoken
  export DOTCLAUDE_GH_TOKEN
  run "$DOCTOR" gist-token
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: token-scope-missing"* ]]
}

@test "doctor gist-token: ok when token valid with gist scope" {
  shim curl '
for arg in "$@"; do
  if [[ "$arg" == "%{http_code}" ]]; then
    printf "200"
    exit 0
  fi
done
printf "X-Oauth-Scopes: gist\r\n"
exit 0
'
  hermetic_path
  DOTCLAUDE_GH_TOKEN=faketoken
  export DOTCLAUDE_GH_TOKEN
  run "$DOCTOR" gist-token
  [ "$status" -eq 0 ]
  [ "$output" = "ok: gist-token" ]
}

# --- git-fallback transport ---

@test "doctor git-fallback: git-missing when git is not on PATH" {
  hermetic_path_without git
  run "$DOCTOR" git-fallback
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: git-missing"* ]]
}

@test "doctor git-fallback: handoff-repo-unset when env var is empty" {
  shim git 'exit 0'
  hermetic_path
  unset DOTCLAUDE_HANDOFF_REPO
  run "$DOCTOR" git-fallback
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: handoff-repo-unset"* ]]
  [[ "$output" == *"DOTCLAUDE_HANDOFF_REPO"* ]]
}

@test "doctor git-fallback: handoff-repo-unreachable when ls-remote fails" {
  shim git '
# Fail ls-remote; succeed everything else.
if [[ "$1" == "ls-remote" ]]; then
  exit 128
fi
exit 0
'
  hermetic_path
  DOTCLAUDE_HANDOFF_REPO=git@example.com:fake/repo.git
  export DOTCLAUDE_HANDOFF_REPO
  run "$DOCTOR" git-fallback
  [ "$status" -eq 1 ]
  [[ "$output" == *"Preflight failed: handoff-repo-unreachable"* ]]
}

@test "doctor git-fallback: ok when git and repo reachable" {
  shim git 'exit 0'
  hermetic_path
  DOTCLAUDE_HANDOFF_REPO=git@example.com:fake/repo.git
  export DOTCLAUDE_HANDOFF_REPO
  run "$DOCTOR" git-fallback
  [ "$status" -eq 0 ]
  [ "$output" = "ok: git-fallback" ]
}
