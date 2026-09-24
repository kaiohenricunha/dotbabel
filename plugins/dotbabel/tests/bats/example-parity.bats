#!/usr/bin/env bats
# example-parity.bats — `examples/minimal-consumer/` really is scaffolder output.
#
# Three pull requests in a row shipped it stale: #400 left a `merge-pr.md` a
# full major version behind, and #401 left both `pre-pr.md` and the
# `pr-conductor` SKILL asserting a rule the same PR had just retracted. Each
# time a human reviewer caught it, because nothing else could.
#
# `docs/templates.md` already requires regenerating the example in the same PR,
# and `examples/minimal-consumer/README.md` says the tree must not be
# hand-edited — but `npm run dogfood` only runs the validators against it,
# which pass happily on stale prose. This test is the missing enforcement:
# it re-runs the scaffolder into a temp dir and diffs.
#
# Deliberately a bats case rather than an npm script. `package.json` is a
# governed file for attestation (`.dotbabel.json` -> attestation.governance_files),
# so adding a script there would make every pull request that adds a check
# unable to attest itself.

load helpers

INIT="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-init.mjs"
EXAMPLE="$REPO_ROOT/examples/minimal-consumer"

@test "example-parity: minimal-consumer matches fresh scaffolder output" {
  [ -d "$EXAMPLE" ]
  [ -f "$INIT" ]

  fresh="$BATS_TEST_TMPDIR/minimal-consumer"
  mkdir -p "$fresh"
  cd "$fresh"
  git init -q .
  run node "$INIT" --project-name minimal-consumer --project-type node
  [ "$status" -eq 0 ]
  rm -rf "$fresh/.git"

  # The scaffolder stamps the run date into every {{today}} placeholder, so a
  # byte diff reports a mismatch on every day after the example was last
  # regenerated — on main as much as on a branch. That made the gate fail for
  # a reason no contributor introduced, and the only "fix" was to regenerate
  # the example again, which resets the clock for one day. Compare with those
  # two fields normalized on BOTH sides, and assert the stamps are still real
  # dates below, so normalizing cannot hide a missing or garbage stamp.
  normalized="$BATS_TEST_TMPDIR/normalized"
  rm -rf "$normalized"
  mkdir -p "$normalized/example" "$normalized/fresh"
  cp -r "$EXAMPLE/." "$normalized/example/"
  cp -r "$fresh/." "$normalized/fresh/"
  find "$normalized" -type f -exec sed -i -E \
    's/("(generatedAt|lastValidated)": ")[0-9]{4}-[0-9]{2}-[0-9]{2}"/\1DATE"/g' {} +

  # README.md is hand-maintained and is explicitly NOT scaffolder output — the
  # regeneration recipe in it says so, and says to restore it afterwards.
  run diff -r -x README.md -x .git "$normalized/example" "$normalized/fresh"
  if [ "$status" -ne 0 ]; then
    printf 'examples/minimal-consumer is out of sync with the scaffolder.\n' >&2
    printf 'Regenerate it per examples/minimal-consumer/README.md, in this same PR.\n\n' >&2
    printf '%s\n' "$output" >&2
  fi
  [ "$status" -eq 0 ]

  # The normalization above is blind to the stamp's value, so check it here:
  # every date in the committed manifest must still be an ISO date.
  run grep -cE '"(generatedAt|lastValidated)": "[0-9]{4}-[0-9]{2}-[0-9]{2}"' \
    "$EXAMPLE/.claude/skills-manifest.json"
  [ "$status" -eq 0 ]
  [ "$output" -gt 0 ]
  run grep -q '{{today}}' "$EXAMPLE/.claude/skills-manifest.json"
  [ "$status" -ne 0 ]
}
