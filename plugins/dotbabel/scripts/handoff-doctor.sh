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
  printf 'handoff-doctor: takes no arguments (gist transport removed in v0.9.0; the only remote transport is the private git repo named by DOTBABEL_HANDOFF_REPO).\n' >&2
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

# Canonical DOTBABEL_HANDOFF_REPO with legacy DOTCLAUDE_HANDOFF_REPO fallback.
# Emits a one-shot deprecation warning if only the legacy var is set
# (compat shim removed in 3.0.0).
if [[ -z "${DOTBABEL_HANDOFF_REPO:-}" && -n "${DOTCLAUDE_HANDOFF_REPO:-}" ]]; then
  printf 'warning: DOTCLAUDE_HANDOFF_REPO is deprecated; use DOTBABEL_HANDOFF_REPO (removal in 3.0.0)\n' >&2
fi
repo="${DOTBABEL_HANDOFF_REPO:-${DOTCLAUDE_HANDOFF_REPO:-}}"
if [[ -z "$repo" ]]; then
  # Not a hard failure: the binary auto-bootstraps on `push` when stdin is
  # a TTY and `gh` is authenticated. Surface that so running `doctor`
  # before the first push doesn't read as alarming.
  printf 'info: DOTBABEL_HANDOFF_REPO is not set — first `dotbabel handoff push` will offer to create a private repo interactively.\n'
  check_clock
  printf 'ok (unconfigured)\n'
  exit 0
fi

if ! git ls-remote "$repo" HEAD >/dev/null 2>&1; then
  # Derive the host from the repo URL so the SSH probe suggestion
  # points at the right server (works for ssh://, git@, https://; falls
  # back to "<host>" when the URL is local or unparseable).
  host="$(printf '%s' "$repo" | sed -nE 's#^(ssh://|git@|https?://)?([^/:]+).*#\2#p')"
  [[ -z "$host" ]] && host="<host>"
  fail "handoff-repo-unreachable" \
    "git ls-remote on \$DOTBABEL_HANDOFF_REPO failed" \
    "verify SSH auth to your provider (e.g. ssh -T git@$host)" \
    "or switch to HTTPS + credential helper: git config --global credential.helper cache" \
    "confirm the repo exists and your account has push access"
fi

check_clock
printf 'ok\n'
exit 0
