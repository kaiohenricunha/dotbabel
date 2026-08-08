#!/usr/bin/env bats
# Contract tests for skills/release-conductor/SKILL.md.
#
# The skill derives LAST_TAG from the LOCAL tag list and diffs against
# origin/main. Without a preceding fetch, a stale clone silently produces the
# wrong release window — wrong bump, wrong landed-PR list, wrong commit-type
# check — and the gate still reports READY. Nothing blocks, so the failure is
# invisible unless something pins the ordering. That is what these tests do.

load helpers

SKILL="$REPO_ROOT/skills/release-conductor/SKILL.md"

@test "release-conductor: SKILL.md exists" {
  [ -f "$SKILL" ]
}

@test "release-conductor: fetches tags before reading them" {
  run grep -qE 'git fetch .*--tags' "$SKILL"
  [ "$status" -eq 0 ]
}

@test "release-conductor: the tag fetch precedes every git tag --list" {
  fetch_line="$(grep -nE 'git fetch .*--tags' "$SKILL" | head -1 | cut -d: -f1)"
  [ -n "$fetch_line" ]

  # Every local tag read must come after the fetch, or it reads stale data.
  while read -r n; do
    [ "$n" -gt "$fetch_line" ] || {
      echo "git tag --list at line $n precedes the fetch at line $fetch_line"
      return 1
    }
  done < <(grep -nE 'git tag --list' "$SKILL" | cut -d: -f1)
}

@test "release-conductor: fetch refreshes origin/main as well as tags" {
  # Steps 1 and 5 diff against origin/main; a stale remote ref is the same
  # class of bug as a stale tag.
  run grep -qE 'git fetch origin main .*--tags' "$SKILL"
  [ "$status" -eq 0 ]
}

@test "release-conductor: every LAST_TAG assignment is guarded against empty" {
  assigns="$(grep -cE '^ *LAST_TAG=\$\(git tag --list' "$SKILL")"
  guards="$(grep -cE '^ *\[ -n "\$LAST_TAG" \]' "$SKILL")"
  [ "$assigns" -gt 0 ]
  [ "$assigns" -eq "$guards" ]
}

@test "release-conductor: still refuses to publish or reimplement release-please" {
  run grep -qE 'Never publish to npm directly' "$SKILL"
  [ "$status" -eq 0 ]
  run grep -qE 'Never reimplement release-please' "$SKILL"
  [ "$status" -eq 0 ]
  # The skill stops at the merge; it must never invoke npm publish itself.
  run grep -nE '^\s*npm publish' "$SKILL"
  [ "$status" -eq 1 ]
}

@test "release-conductor: still requires explicit verbal approval before merging" {
  run grep -qE 'Require explicit verbal approval' "$SKILL"
  [ "$status" -eq 0 ]
}
