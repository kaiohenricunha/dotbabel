#!/usr/bin/env bash
# Regenerate the cross-CLI invocation baseline fixture.
#
# Captures stdout from the four pin-stable Phase 2.5 invocations under direct
# bash, sectioned by row marker, and writes the result to
# plugins/dotbabel/tests/fixtures/cross-cli-invocation-baseline.txt.
#
# This is the single source of truth that the cross-cli-invocation workflow
# diffs every shell invocation context against. Regenerate after any
# intentional change to <handoff> / --summary output (e.g., template tweak,
# new attribute on the opening tag) and commit the regenerated baseline in
# the same PR.
#
# Usage:
#   regenerate-baseline.sh                # writes baseline.txt next to fixtures/
#   regenerate-baseline.sh --check        # exit 1 if current baseline drifts
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
fixture_dir="$(cd "$here/.." && pwd)"
repo_root="$(cd "$fixture_dir/../../../.." && pwd)"
baseline_path="$fixture_dir/cross-cli-invocation-baseline.txt"
seed_script="$here/seed.sh"
bin="$repo_root/plugins/dotbabel/bin/dotbabel-handoff.mjs"

mode="${1:-write}"
case "$mode" in
  ""|write|--check) ;;
  *) echo "usage: $0 [--check]" >&2; exit 64 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

eval "$(bash "$seed_script" "$work")"

# Force the same env every run so the baseline never picks up host noise.
# DOTBABEL_HANDOFF_REPO must point somewhere that does not exist, so any
# accidental remote-transport codepath surfaces as an immediate failure
# instead of silently mutating output.
export HOME="$work"
export XDG_CONFIG_HOME="$work"
export DOTBABEL_HANDOFF_REPO="$work/nonexistent-handoff-repo"
export DOTBABEL_QUIET=1
export TZ=UTC
unset DOTBABEL_HANDOFF_DEBUG || true

# Scrub host-CLI detection env vars (see dotbabel-handoff.mjs:detectHost).
# Without this, local regeneration inside Claude Code / Codex / Copilot picks
# up the host's marker, sets target=<host>, and emits the host-flavored "Next
# step" hint — producing a baseline that does not match the host-agnostic
# output CI produces. Symmetric scrubbing happens in the workflow's capture
# step so both producers always agree.
unset CLAUDECODE CLAUDE_CODE_SSE_PORT
while IFS='=' read -r _name _; do
  case "$_name" in
    CODEX_*|COPILOT_*|GITHUB_COPILOT_*) unset "$_name" ;;
  esac
done < <(env)

# Row format: <section-marker>\t<bin-args>
# Section markers double as awk extraction keys in the workflow.
rows=(
  "claude-pull	pull ${CLAUDE_SHORT}"
  "copilot-pull	pull ${COPILOT_SHORT}"
  "copilot-pull-summary	pull ${COPILOT_SHORT} --summary"
  "codex-pull	pull ${CODEX_SHORT}"
)

generated=$(mktemp)
{
  for entry in "${rows[@]}"; do
    marker="${entry%%	*}"
    args="${entry#*	}"
    printf '=== %s ===\n' "$marker"
    # shellcheck disable=SC2086
    node "$bin" $args 2>/dev/null
    printf '=== /%s ===\n' "$marker"
  done
} > "$generated"

if [ "$mode" = "--check" ]; then
  if ! diff -q "$baseline_path" "$generated" >/dev/null 2>&1; then
    echo "baseline drift detected. Run:" >&2
    echo "  bash $here/regenerate-baseline.sh" >&2
    echo "and commit the updated baseline in the same PR." >&2
    diff "$baseline_path" "$generated" >&2 || true
    exit 1
  fi
  echo "✓ baseline up-to-date"
else
  mv "$generated" "$baseline_path"
  echo "✓ regenerated $baseline_path"
fi
