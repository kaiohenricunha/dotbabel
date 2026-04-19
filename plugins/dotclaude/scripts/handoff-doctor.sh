#!/usr/bin/env bash
# handoff-doctor.sh — preflight checks for the handoff git transport.
#
# Usage:
#   handoff-doctor.sh
#
# On success: prints `ok` to stdout, exits 0.
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
#   Rerun /handoff doctor to verify.
#
# Exit codes:
#   0  all checks pass
#   1  a check failed (normal, remediation printed)
#   2  usage error

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
  exit 0
fi

# `--via` was removed in v0.9.0 along with the gist transport. Reject any
# stray positional so the user gets a crisp pointer instead of silent acceptance.
if [[ $# -gt 0 ]]; then
  printf 'handoff-doctor: takes no arguments (gist transport removed in v0.9.0; the only remote transport is the private git repo named by DOTCLAUDE_HANDOFF_REPO).\n' >&2
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
    printf 'Rerun /handoff doctor to verify.\n'
  } >&2
  exit 1
}

soft_warn() {
  printf 'warn: %s\n' "$1" >&2
}

check_clock() {
  local year
  year="$(date -u +%Y)"
  if ! [[ "$year" =~ ^[0-9]{4}$ ]] || (( year < 2024 || year > 2100 )); then
    soft_warn "system clock reports year $year; git auth may fail with signature errors (timedatectl set-ntp true)"
  fi
}

if ! command -v git >/dev/null 2>&1; then
  fail "git-missing" \
    "git is not installed on PATH" \
    "install git via your package manager" \
    "" \
    "git is required — there is no alternative remote transport"
fi

repo="${DOTCLAUDE_HANDOFF_REPO:-}"
if [[ -z "$repo" ]]; then
  fail "handoff-repo-unset" \
    "DOTCLAUDE_HANDOFF_REPO is not set" \
    "create a private repo once: gh repo create handoff-store --private" \
    "export DOTCLAUDE_HANDOFF_REPO=git@github.com:<user>/handoff-store.git" \
    "any private git repo works (GitLab, Gitea, self-hosted) — the URL just needs to be ssh://, git@, https://, or a local path"
fi

if ! git ls-remote "$repo" HEAD >/dev/null 2>&1; then
  fail "handoff-repo-unreachable" \
    "git ls-remote on \$DOTCLAUDE_HANDOFF_REPO failed" \
    "verify SSH: ssh -T git@github.com" \
    "or switch to HTTPS + credential helper: git config --global credential.helper cache" \
    "confirm the repo exists and your account has push access"
fi

check_clock
printf 'ok\n'
exit 0
