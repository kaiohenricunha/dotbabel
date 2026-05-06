#!/usr/bin/env bash
# sync.sh — pull/push convenience wrapper for dotbabel.
#
# Subcommands:
#   pull    fetch origin, rebase onto origin/main, re-run bootstrap.sh
#   push    secret-scan + stage + commit + push (aborts if secrets detected)
#   status  git status --short
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Regex catches the common literal-secret shapes we care about in dotbabel.
# High-entropy random strings still slip through; this is a last-ditch guard,
# not a full DLP system. We deliberately match on:
#   *_KEY / *_TOKEN / *_SECRET assignments with 20+ char values
#   AWS access keys (AKIA[0-9A-Z]{16})
#   Bearer / Authorization tokens with ≥20 char payloads
SECRET_RX='(^|[^A-Z_])(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|[A-Z_]*_?(API|ACCESS|AUTH|BEARER|PRIVATE)?_?(KEY|TOKEN|SECRET|PASSWORD))[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9+/=_-]{20,}["'"'"']?|AKIA[0-9A-Z]{16}|(?i)bearer[[:space:]]+[A-Za-z0-9._-]{20,}'

scan_secrets() {
  # Stage first so we can grep exactly what will be committed — including new
  # files. Revert staging on abort so the working tree stays clean for the user.
  local staged
  staged=$(git diff --cached --name-only --diff-filter=ACMR)
  if [ -z "$staged" ]; then
    return 0
  fi
  local hit=0
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    # Use grep -I so binary files are skipped silently. -P for perl-compatible
    # regex so our alternation with case-insensitive fragment works.
    if git show ":$file" 2>/dev/null | grep -IPq -- "$SECRET_RX" ; then
      echo "secret-scan: POSSIBLE SECRET in $file" >&2
      hit=1
    fi
  done <<< "$staged"
  if [ "$hit" != "0" ]; then
    echo "secret-scan: aborting push. Re-run after removing or whitelisting." >&2
    echo "secret-scan: to bypass (only with care), set HARNESS_SYNC_SKIP_SECRET_SCAN=1" >&2
    return 1
  fi
  return 0
}

cmd="${1:-pull}"
case "$cmd" in
  pull)
    git fetch origin
    git rebase origin/main
    ./bootstrap.sh
    ;;
  push)
    git add -A
    if git diff --cached --quiet; then
      echo "no changes to push"
      exit 0
    fi
    if [ "${HARNESS_SYNC_SKIP_SECRET_SCAN:-0}" != "1" ]; then
      if ! scan_secrets; then
        git reset HEAD -- . >/dev/null
        exit 1
      fi
    fi
    git commit -m "dotbabel: sync $(date +%Y-%m-%d)"
    git push
    ;;
  status)
    git status --short
    ;;
  *)
    echo "usage: $0 {pull|push|status}" >&2
    exit 64
    ;;
esac
