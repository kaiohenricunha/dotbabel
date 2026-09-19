#!/usr/bin/env bats
# project-sync-parity.bats — this repository's committed cross-CLI fan-out
# (`.github/instructions/`, `.github/prompts/`, `.agents/`, `.cli/`) matches what
# `dotbabel project-sync` would write today.
#
# `dotbabel-check-project-sync` has existed for a long time and detects exactly
# this — but nothing ran it. `npm run dogfood` runs validators that pass happily
# on stale generated files, and no workflow calls it. So the drift accumulated
# silently: four instruction files went stale and a whole skill (`smoke-test`)
# was never fanned out, across several merged pull requests, until it was found
# by accident while regenerating for something else. Twice it was reverted from
# an unrelated diff to keep that diff scoped, which is a symptom rather than a fix.
#
# `--all`, not the default. By default the checker skips any CLI that is not on
# PATH, so on a machine with none installed (a CI runner, or a contributor's
# laptop) it would verify nothing and pass. With `--all` the answer does not
# depend on which agents happen to be installed.
#
# A bats case rather than an npm script on purpose: `package.json` is a governed
# file for attestation (`.dotbabel.json` -> attestation.governance_files), so
# adding a script there would make the very pull request that adds the check
# unable to attest itself.

load helpers

CHECK="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-check-project-sync.mjs"

@test "project-sync-parity: the committed fan-out matches what project-sync would write" {
  [ -f "$CHECK" ]
  run node "$CHECK" --repo "$REPO_ROOT" --all
  if [ "$status" -ne 0 ]; then
    printf 'project-sync drift. Regenerate with: node plugins/dotbabel/bin/dotbabel-project-sync.mjs --all\n\n' >&2
    printf '%s\n' "$output" | grep -E "stale|missing|drift" >&2 || true
  fi
  [ "$status" -eq 0 ]
}

@test "project-sync-parity: the checker reports a stale generated file, so the gate is not vacuous" {
  # Prove the check can fail. A parity test that has never been seen to fail
  # could be passing because the checker inspects nothing.
  work="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$work"
  git -C "$REPO_ROOT" ls-files -z | (cd "$REPO_ROOT" && xargs -0 -I{} cp --parents {} "$work" 2>/dev/null) || true
  target="$work/.github/instructions/review-pr.instructions.md"
  [ -f "$target" ]
  printf '\nstale drift injected by a test\n' >> "$target"
  run node "$CHECK" --repo "$work" --all
  [ "$status" -ne 0 ]
  [[ "$output" == *"stale"* ]]
}
