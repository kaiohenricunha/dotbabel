#!/usr/bin/env bats
# pr-conductor.bats — contract tests binding skills/pr-conductor/SKILL.md to
# the code that backs it.
#
# The skill is prose; the pipeline order it describes is a frozen array in
# plugins/dotbabel/src/pr-gates.mjs (CONDUCTOR_PHASES). Prose and code drift
# apart silently unless something diffs them, which is what this file does.
#
# Assertions:
#   1. the skill exists with well-formed frontmatter
#   2. every artifact path named in the prose exists on disk
#   3. all six pipeline artifacts are named (nothing silently dropped)
#   4. prose step order === `dotbabel pr-stack phases` order
#   5. prose step count === phase count === 6
#   6. STOP invariant: the skill never merges
#   7. every `dotbabel pr-stack` subcommand in the prose is implemented
#   8. the CLI is registered in the dispatcher, bin dir, and package.json
#   9. the documented exit-code contract holds
#  10. the skill is declared in .claude/skills-manifest.json

load helpers

SKILL="$REPO_ROOT/skills/pr-conductor/SKILL.md"
BIN="$REPO_ROOT/plugins/dotbabel/bin/dotbabel-pr-stack.mjs"

# grep exits 0 on match (bad here), 1 on no match (good), 2 on error (bad).
# `run grep` + `[ "$status" -eq 1 ]` fails on both a match and a scan error.

@test "pr-conductor: SKILL.md exists with matching id and name" {
  [ -f "$SKILL" ]
  run grep -q '^id: pr-conductor$' "$SKILL"
  [ "$status" -eq 0 ]
  run grep -q '^name: pr-conductor$' "$SKILL"
  [ "$status" -eq 0 ]
  run grep -q '^type: skill$' "$SKILL"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: side-effectful skill disables model invocation" {
  run grep -q '^disable-model-invocation: true$' "$SKILL"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: every artifact path named in the prose exists on disk" {
  # Strip any :LINE suffix before testing existence.
  paths="$(grep -oE '(skills/[a-z0-9-]+/SKILL\.md|commands/[a-z0-9-]+\.md)' "$SKILL" | sort -u)"
  [ -n "$paths" ]
  for p in $paths; do
    [ -f "$REPO_ROOT/$p" ] || {
      echo "prose names a missing artifact: $p"
      return 1
    }
  done
}

@test "pr-conductor: prose names every artifact the module declares" {
  # Derived from the module, not hardcoded — a hardcoded list is a second copy
  # that drifts in lockstep with the code and out of reach of the prose.
  while read -r p; do
    run grep -qF "$p" "$SKILL"
    [ "$status" -eq 0 ] || {
      echo "prose does not name pipeline artifact: $p"
      return 1
    }
  done < <(node "$BIN" phases --json | jq -r '.result.phases[].artifact')
}

@test "pr-conductor: prose names every invocation the module declares" {
  while read -r inv; do
    run grep -qF "$inv" "$SKILL"
    [ "$status" -eq 0 ] || {
      echo "prose does not name pipeline invocation: $inv"
      return 1
    }
  done < <(node "$BIN" phases --json | jq -r '.result.phases[].invocation')
}

@test "pr-conductor: prose invokes every phase with the flags the module declares" {
  # The invocation grep above is a substring match, so it is blind to flags:
  # `/pre-pr` matches whether or not the prose passes `--conductor`. That flag
  # decides whether phase 1 runs a full security review or a secrets scan and
  # whether phase 4 defers the test plan, so drift here is silent behaviour
  # change. Require the flag on the same line as the invocation — the prose
  # writes `/review-pr <N> --conductor`, so the number sits in between and a
  # plain `grep -qF "<invocation> <flag>"` cannot work.
  while IFS=$'\t' read -r inv flag; do
    [ -n "$flag" ] || continue
    run grep -F "$inv" "$SKILL"
    [ "$status" -eq 0 ]
    echo "$output" | grep -qF -- "$flag" || {
      echo "prose invokes $inv without the declared flag $flag"
      return 1
    }
  done < <(node "$BIN" phases --json \
    | jq -r '.result.phases[] | .invocation as $i | (.conductorFlags // [])[]? | [$i, .] | @tsv')
}

@test "pr-conductor: the phase table rows match the module order" {
  # The `## Phases` table is a third copy of the ordered list. Pin it.
  module_artifacts="$(node "$BIN" phases --json | jq -r '.result.phases[].artifact')"
  table_artifacts="$(grep -oE '^\| [0-9]+ +\| `[a-z-]+` +\| `[^`]+`' "$SKILL" \
    | grep -oE '`[^`]+`$' | tr -d '`')"
  [ "$module_artifacts" = "$table_artifacts" ]
}

@test "pr-conductor: the lifecycle string matches the module order" {
  expected="$(node "$BIN" phases --json \
    | jq -r '[.result.phases[] | select(.id != "stop") | .id] | join(" → ")')"
  run grep -qF "$expected" "$SKILL"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: SKILL.md step order matches CONDUCTOR_PHASES" {
  module_ids="$(node "$BIN" phases --json | jq -r '.result.phases[].id')"
  prose_ids="$(grep -oE '^### [0-9]+\. `[a-z-]+`' "$SKILL" | grep -oE '`[a-z-]+`' | tr -d '`')"
  [ "$module_ids" = "$prose_ids" ]
}

@test "pr-conductor: prose step count equals module phase count equals 6" {
  [ "$(node "$BIN" phases --json | jq '.result.phases | length')" -eq 6 ]
  [ "$(grep -cE '^### [0-9]+\. `[a-z-]+`' "$SKILL")" -eq 6 ]
}

@test "pr-conductor: SKILL.md never invokes a merge" {
  run grep -n 'gh pr merge' "$SKILL"
  [ "$status" -eq 1 ]
}

@test "pr-conductor: SKILL.md declares the stop hand-off" {
  run grep -qF '/merge-pr' "$SKILL"
  [ "$status" -eq 0 ]
  run grep -q 'STOP' "$SKILL"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: every dotbabel pr-stack subcommand in the prose is implemented" {
  help="$(node "$BIN" --help)"
  subs="$(grep -oE 'dotbabel pr-stack [a-z-]+' "$SKILL" | awk '{print $3}' | sort -u)"
  [ -n "$subs" ]
  for s in $subs; do
    echo "$help" | grep -qE "^  $s " || {
      echo "prose uses an unimplemented subcommand: $s"
      return 1
    }
  done
}

@test "pr-conductor: pr-stack is registered in the dispatcher and bin map" {
  [ -f "$BIN" ]
  run grep -q '"pr-stack"' "$REPO_ROOT/plugins/dotbabel/bin/dotbabel.mjs"
  [ "$status" -eq 0 ]
  run jq -e '.bin["dotbabel-pr-stack"]' "$REPO_ROOT/package.json"
  [ "$status" -eq 0 ]
}

@test "pr-conductor: dotbabel pr-stack exits 64 on an unknown subcommand" {
  run node "$BIN" bogus
  [ "$status" -eq 64 ]
}

@test "pr-conductor: dotbabel pr-stack phases exits 0 with parseable JSON" {
  run node "$BIN" phases --json
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.ok == true' >/dev/null
}

@test "pr-conductor: skills-manifest.json declares pr-conductor" {
  run jq -e '.skills[] | select(.name == "pr-conductor")' "$REPO_ROOT/.claude/skills-manifest.json"
  [ "$status" -eq 0 ]
}
