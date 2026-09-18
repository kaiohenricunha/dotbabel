#!/usr/bin/env bats
# spec-skill-criteria.bats — P-A2 contract tests binding the authoring skills
# to the criteria workflow the rest of this spec built.
#
# The gap these close is concrete and was verified before writing them: the
# spec skill scaffolds a spec that this repository's OWN validator rejects.
# `skills/spec/SKILL.md` mentioned spec.json zero times, and a spec scaffolded
# its way fails `dotbabel-validate-specs` immediately with "missing spec.json".
# So every spec authored by the skill started life invalid, and the criteria
# machinery had nowhere to live.
#
# These are prose files an agent executes, so a test is the only thing that
# stops an instruction from being dropped in a later edit.
#
# `skip` is deliberately never used for a missing artifact — a skipped bats
# test reports `ok`, which would make this file green against no change at all.

load helpers

# Prose wraps at 80 columns, so a claim stated in one sentence is routinely
# split across lines and a line-based grep cannot see it. Flow the text first.
flowed() { tr '\n' ' ' < "$1" | tr -s ' '; }
export -f flowed

# near <file> <anchor> <needle> [window] — true when <needle> appears within
# <window> characters of ANY occurrence of <anchor> in the flowed text.
# Iterating every occurrence matters: anchoring on the first alone lets a rule
# deleted from its real location pass against an unrelated earlier mention.
near() {
  flowed "$1" | awk -v anchor="$2" -v needle="$3" -v win="${4:-260}" '{
    s = tolower($0); a = tolower(anchor); n = tolower(needle);
    p = 1;
    while ((i = index(substr(s, p), a)) > 0) {
      start = p + i - 1;
      if (index(substr(s, start, win), n) > 0) exit 0;
      p = start + 1;
    }
    exit 1;
  }'
}
export -f near

SPEC="$REPO_ROOT/skills/spec/SKILL.md"
TEMPLATES="$REPO_ROOT/skills/spec/references/cc-prompt-templates.md"
VALIDATE="$REPO_ROOT/skills/validate-spec/SKILL.md"

setup() {
  [ -f "$SPEC" ]
  [ -f "$TEMPLATES" ]
  [ -f "$VALIDATE" ]
}

@test "spec skill: the scaffold creates spec.json with an acceptance_criteria example" {
  # The scaffold tree must list spec.json. Without it the skill produces a
  # spec that dotbabel-validate-specs rejects on the first run — verified:
  # a spec scaffolded the old way fails with "missing spec.json".
  run grep -qE '^│?\s*[├└]──\s*spec\.json|^\s*spec\.json' "$SPEC"
  [ "$status" -eq 0 ]
  # And the skill must carry a concrete example, not just name the file: the
  # validator requires id, title, status, owners, linked_paths and
  # acceptance_commands, and an author given only a filename writes none of them.
  for field in '"id"' '"title"' '"status"' '"owners"' '"linked_paths"' '"acceptance_commands"' '"acceptance_criteria"'; do
    run grep -qF "$field" "$SPEC"
    [ "$status" -eq 0 ]
  done
  # The criteria example needs the shape the validator actually checks.
  for field in '"given"' '"when"' '"then"' '"tests"' '"argv"'; do
    run grep -qF "$field" "$SPEC"
    [ "$status" -eq 0 ]
  done
}

@test "spec skill: a spec scaffolded from the skill's own example validates" {
  # The outcome test, and the one that matters. Grepping the skill for field
  # NAMES proved only that words appear in prose — the first version of this
  # scaffold contained every required name and still produced a spec the
  # validator rejected three ways (empty acceptance_commands, missing
  # depends_on_specs, missing active_prs). Extract the skill's own JSON block,
  # fill its placeholders, and run the real validator against it.
  probe="$(mktemp -d)"
  mkdir -p "$probe/docs/specs/probe/spec" "$probe/docs/specs/probe/research"
  for f in 1-problem-motivation 2-scope 3-high-level-architecture \
           4-data-flow-components 5-interfaces-apis 6-implementation-plan \
           7-non-functional-requirements 8-risks-alternatives; do
    echo "# section" > "$probe/docs/specs/probe/spec/$f.md"
  done
  echo "# probe" > "$probe/docs/specs/probe/README.md"
  echo "# sources" > "$probe/docs/specs/probe/research/sources.md"

  python3 - "$SPEC" "$probe" <<'EOS'
import json, re, sys, pathlib
block = re.search(r'### spec\.json.*?```json\n(.*?)\n```', open(sys.argv[1]).read(), re.S).group(1)
for a, b in [("<spec-name>", "probe"), ("<Spec Title>", "Probe"), ("<owner>", "someone"),
             ("<path/this/spec/governs>", "src/"),
             ("<the command that proves this spec works>", "npm test"),
             ("<path/to/the.test.file>", "tests/probe.test.mjs"),
             ("<the precondition, in the system's own terms>", "a probe"),
             ("<the action taken>", "it runs"),
             ("<the observable outcome — one claim, not a list>", "it passes"),
             ("<the exact test name, copied verbatim from the test>", "probe passes")]:
    block = block.replace(a, b)
pathlib.Path(sys.argv[2], "docs/specs/probe/spec.json").write_text(json.dumps(json.loads(block), indent=2) + "\n")
EOS
  [ -f "$probe/docs/specs/probe/spec.json" ]
  git -C "$probe" init -q
  run node "$REPO_ROOT/plugins/dotbabel/bin/dotbabel-validate-specs.mjs" --repo-root "$probe"
  rm -rf "$probe"
  [ "$status" -eq 0 ]
}

@test "spec skill: new criteria start with status planned" {
  # IMPL-5: a criterion goes active only in the pull request that adds its
  # tests. A scaffold that seeded `active` would assert, from the very first
  # commit, that tests exist which do not.
  run grep -qE '"status"\s*:\s*"planned"' "$SPEC"
  [ "$status" -eq 0 ]
  run near "$SPEC" "planned" "active"
  [ "$status" -eq 0 ]
  # The scaffolded example must not seed a criterion as already active.
  run grep -qE '"id"\s*:\s*"AC-1".*"status"\s*:\s*"active"' "$SPEC"
  [ "$status" -ne 0 ]
}

@test "spec skill: the implementation prompt template pairs each TDD test name with a criterion id" {
  # A test name with no criterion id is a test nothing verifies against, and a
  # criterion with no test name is a claim nothing proves. The template has to
  # ask for both together or the pairing never happens.
  run grep -qE 'AC-[0-9N]' "$TEMPLATES"
  [ "$status" -eq 0 ]
  run near "$TEMPLATES" "TDD first" "AC-"
  [ "$status" -eq 0 ]
}

@test "validate-spec skill: Phase 1 reports a spec without acceptance_criteria as INFO" {
  # INFO, not an error: acceptance_criteria is optional in the schema, so a
  # spec predating it is not malformed. But it must be reported, or the
  # absence of machine-checkable criteria stays invisible in the audit.
  run near "$VALIDATE" "acceptance_criteria" "INFO"
  [ "$status" -eq 0 ]
  # It must not be escalated to a failure.
  run grep -qiE 'acceptance_criteria[^.]*(CRITICAL|must fail|is an error)' "$VALIDATE"
  [ "$status" -ne 0 ]
}

@test "validate-spec skill: Phase 4 runs dotbabel criteria verify for a spec with criteria" {
  # The acceptance_commands run in Phase 4 are the spec's executable ground
  # truth; criteria verification belongs in the same phase, or an audit can
  # report a spec as implemented while its criteria fail.
  run grep -qE 'dotbabel criteria verify' "$VALIDATE"
  [ "$status" -eq 0 ]
  phase4_line=$(grep -n '^### Phase 4' "$VALIDATE" | head -1 | cut -d: -f1)
  phase5_line=$(grep -n '^### Phase 5' "$VALIDATE" | head -1 | cut -d: -f1)
  verify_line=$(grep -n 'dotbabel criteria verify' "$VALIDATE" | head -1 | cut -d: -f1)
  [ -n "$phase4_line" ]
  [ -n "$verify_line" ]
  [ "$verify_line" -gt "$phase4_line" ]
  # It must sit inside Phase 4, not drift into a later phase.
  if [ -n "$phase5_line" ]; then [ "$verify_line" -lt "$phase5_line" ]; fi
}
