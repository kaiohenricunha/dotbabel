#!/usr/bin/env bash
# handoff-doctor.sh — preflight checks for the handoff remote transports.
#
# Usage:
#   handoff-doctor.sh <github|gist-token|git-fallback>
#
# On success: prints `ok: <transport>` to stdout, exits 0.
# On failure: prints a structured remediation block to stderr, exits non-zero.
#
# Block format (stable across versions; consumed by the skill prose):
#
#   Preflight failed: <reason>
#
#     What's wrong: <diagnosis>
#     How to fix:
#       1. <command>
#       2. <command>
#
#     Workaround: <alternative>
#
#   Rerun /handoff doctor --via <transport> to verify.
#
# Exit codes:
#   0  all checks pass
#   1  a check failed (normal, remediation printed)
#   2  usage error

set -euo pipefail

transport="${1:-}"
if [[ -z "$transport" ]]; then
  printf 'handoff-doctor: usage: handoff-doctor.sh <github|gist-token|git-fallback>\n' >&2
  exit 2
fi

fail() {
  # Args: reason, diagnosis, fix1, fix2, workaround
  local reason="$1" diagnosis="$2" fix1="$3" fix2="$4" workaround="$5"
  {
    printf 'Preflight failed: %s\n' "$reason"
    printf '\n'
    printf "  What's wrong: %s\n" "$diagnosis"
    printf '  How to fix:\n'
    printf '    1. %s\n' "$fix1"
    [[ -n "$fix2" ]] && printf '    2. %s\n' "$fix2"
    printf '\n'
    printf '  Workaround: %s\n' "$workaround"
    printf '\n'
    printf 'Rerun /handoff doctor --via %s to verify.\n' "$transport"
  } >&2
  exit 1
}

soft_warn() {
  printf 'warn: %s\n' "$1" >&2
}

ok() {
  printf 'ok: %s\n' "$transport"
  exit 0
}

check_clock() {
  local year
  year="$(date -u +%Y)"
  if ! [[ "$year" =~ ^[0-9]{4}$ ]] || (( year < 2024 || year > 2100 )); then
    soft_warn "system clock reports year $year; gist auth may fail with signature errors (timedatectl set-ntp true)"
  fi
}

doctor_github() {
  if ! command -v gh >/dev/null 2>&1; then
    fail "gh-missing" \
      "the gh CLI is not installed on PATH" \
      "install gh for your platform (brew / apt / winget / scoop — see references/prerequisites.md)" \
      "verify: command -v gh" \
      "--via gist-token (uses a PAT) or --via git-fallback (uses raw git)"
  fi

  if ! gh auth status -h github.com >/dev/null 2>&1; then
    fail "gh-unauthenticated" \
      "gh auth status reports no account for github.com" \
      "gh auth login -h github.com -s gist" \
      "pick HTTPS; complete the browser prompt" \
      "--via gist-token with DOTCLAUDE_GH_TOKEN=<PAT>"
  fi

  if ! gh api / >/dev/null 2>&1; then
    fail "network-unreachable" \
      "gh api / failed — no connectivity to api.github.com" \
      "check: curl -sS https://api.github.com/ -o /dev/null -w '%{http_code}\\n'" \
      "if corporate proxy: export HTTPS_PROXY and retry" \
      "/handoff file <cli> <uuid> writes a local markdown; pull with /handoff pull --from-file <path>"
  fi

  # The gist scope is required; without it, push/remote-list fail with a misleading 404.
  # Parse X-Oauth-Scopes header value (the value itself contains colons like "admin:public_key",
  # so we strip the header name prefix rather than splitting on ": ").
  local scopes
  scopes="$(gh api user -i 2>/dev/null \
    | tr -d '\r' \
    | awk 'tolower($1)=="x-oauth-scopes:"{sub(/^[^:]*: */,""); print tolower($0); exit}')" \
    || scopes=""
  if [[ "$scopes" != *"gist"* ]]; then
    fail "gist-scope-missing" \
      "the stored gh token lacks the 'gist' OAuth scope" \
      "gh auth refresh -h github.com -s gist" \
      "" \
      "--via gist-token with a PAT that has the gist scope"
  fi

  check_clock
  ok
}

doctor_gist_token() {
  if ! command -v curl >/dev/null 2>&1; then
    fail "curl-missing" \
      "curl is not installed on PATH" \
      "install curl via your package manager" \
      "" \
      "--via github (uses gh CLI) or --via git-fallback (uses raw git)"
  fi

  if [[ -z "${DOTCLAUDE_GH_TOKEN:-}" ]]; then
    fail "token-missing" \
      "DOTCLAUDE_GH_TOKEN is not set in the environment" \
      "create a PAT at https://github.com/settings/tokens/new with the 'gist' scope" \
      "export DOTCLAUDE_GH_TOKEN=<pasted-pat> (add to your shell rc for persistence)" \
      "--via github if you have the gh CLI installed"
  fi

  # Validate token + scope via GET /user.
  local code scopes
  code="$(curl -sS -o /dev/null -w '%{http_code}' \
    -H "Authorization: token $DOTCLAUDE_GH_TOKEN" \
    https://api.github.com/user 2>/dev/null || printf '000')"
  if [[ "$code" == "000" ]]; then
    fail "network-unreachable" \
      "curl could not connect to api.github.com (HTTP 000)" \
      "check: curl -sS https://api.github.com/ -o /dev/null -w '%{http_code}\\n'" \
      "if corporate proxy: export HTTPS_PROXY and retry" \
      "--via git-fallback if the API is temporarily unreachable"
  fi
  if [[ "$code" != "200" ]]; then
    fail "token-invalid" \
      "GET /user returned HTTP $code — token is invalid or revoked" \
      "verify the token at https://github.com/settings/tokens" \
      "export DOTCLAUDE_GH_TOKEN=<new-pat>" \
      "--via github to use gh auth login instead"
  fi
  scopes="$(curl -sS -I \
    -H "Authorization: token $DOTCLAUDE_GH_TOKEN" \
    https://api.github.com/user 2>/dev/null \
    | tr -d '\r' \
    | awk 'tolower($1)=="x-oauth-scopes:"{sub(/^[^:]*: */,""); print tolower($0); exit}')" \
    || scopes=""
  if [[ "$scopes" != *"gist"* ]]; then
    fail "token-scope-missing" \
      "the PAT does not include the 'gist' scope (current: ${scopes:-none})" \
      "regenerate the PAT with only the 'gist' scope at https://github.com/settings/tokens/new" \
      "export DOTCLAUDE_GH_TOKEN=<new-pat>" \
      "--via github if the gh CLI is available"
  fi

  check_clock
  ok
}

doctor_git_fallback() {
  if ! command -v git >/dev/null 2>&1; then
    fail "git-missing" \
      "git is not installed on PATH" \
      "install git via your package manager" \
      "" \
      "--via github (uses gh CLI) or --via gist-token (uses curl + PAT)"
  fi

  local repo="${DOTCLAUDE_HANDOFF_REPO:-}"
  if [[ -z "$repo" ]]; then
    fail "handoff-repo-unset" \
      "DOTCLAUDE_HANDOFF_REPO is not set" \
      "create a private repo once: gh repo create handoff-store --private --confirm" \
      "export DOTCLAUDE_HANDOFF_REPO=git@github.com:<user>/handoff-store.git" \
      "--via github is simpler if you have gh"
  fi

  if ! git ls-remote "$repo" HEAD >/dev/null 2>&1; then
    fail "handoff-repo-unreachable" \
      "git ls-remote on \$DOTCLAUDE_HANDOFF_REPO failed" \
      "verify SSH: ssh -T git@github.com" \
      "or switch to HTTPS + credential helper: git config --global credential.helper cache" \
      "--via github or --via gist-token if the repo is temporarily unreachable"
  fi

  check_clock
  ok
}

case "$transport" in
  github) doctor_github ;;
  gist-token) doctor_gist_token ;;
  git-fallback) doctor_git_fallback ;;
  *)
    printf 'handoff-doctor: unknown transport: %s (expected github|gist-token|git-fallback)\n' "$transport" >&2
    exit 2
    ;;
esac
