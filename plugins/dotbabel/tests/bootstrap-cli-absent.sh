#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_HOME="$(mktemp -d)"
SHIM_BIN="$TEST_HOME/bin"
mkdir -p "$SHIM_BIN"
trap 'rm -rf "$TEST_HOME"' EXIT

for cmd in basename cp date dirname ln mkdir mv readlink rm; do
  resolved="$(command -v "$cmd")"
  ln -s "$resolved" "$SHIM_BIN/$cmd"
done

BASH_BIN="$(command -v bash)"
HOME="$TEST_HOME" PATH="$SHIM_BIN" "$BASH_BIN" "$REPO_ROOT/bootstrap.sh" --quiet

if [[ ! -L "$TEST_HOME/.claude/CLAUDE.md" ]]; then
  echo "expected Claude symlink to be created" >&2
  exit 1
fi

for absent_link in \
  "$TEST_HOME/.github/copilot-instructions.md" \
  "$TEST_HOME/.codex/AGENTS.md" \
  "$TEST_HOME/.gemini/GEMINI.md"
do
  if [[ -e "$absent_link" ]] || [[ -L "$absent_link" ]]; then
    echo "expected absent CLI link not to be created: $absent_link" >&2
    exit 1
  fi
done

broken="$(find "$TEST_HOME" -type l ! -exec test -e {} \; -print)"
if [[ -n "$broken" ]]; then
  echo "broken symlinks found:" >&2
  echo "$broken" >&2
  exit 1
fi
