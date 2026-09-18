#!/usr/bin/env bats
# smoke-test-skill.bats — P-E2 contract tests for the smoke-test skill and the
# release-conductor verify extension (KD-13, Flow 5).
#
# These artifacts are prose an agent executes, so nothing but a test like this
# stops an instruction from being quietly dropped in a later edit. The
# properties asserted here are the ones whose absence is invisible at run time:
# a skill that silently rolls back still looks like it verified, and a verify
# subcommand that omits smoke still prints a confident PASS.
#
# `skip` is deliberately not used for a missing artifact — a skipped bats test
# reports `ok`, so it would make this whole file green with no skill at all.

load helpers

# Markdown prose wraps at 80 columns, so a claim stated in ONE SENTENCE is
# routinely split across two lines. Line-based grep cannot see such a sentence
# at all, which makes a sentence-level assertion fail against correct prose (or
# worse, pass only because of where prettier happened to break the line).
# Collapse whitespace first and assert against the flowed text.
flowed() { tr '\n' ' ' < "$1" | tr -s ' '; }
export -f flowed

# near <file> <anchor> <needle> [window] — true when <needle> appears within
# <window> characters after <anchor> in the flowed text.
#
# Deliberately not a regex. A `[^.]*` "same sentence" proxy is wrong here
# because the prose cites `.claude/deploy-targets.json`, whose periods end the
# span before it reaches the needle; and the repo's `grep` is ugrep, which
# rejects bounded repeats like `.{0,60}` on UTF-8 input as too complex. An
# index window has neither problem and says what is actually meant: these two
# things are stated together, not merely both present somewhere in the file.
near() {
  flowed "$1" | awk -v anchor="$2" -v needle="$3" -v win="${4:-200}" '{
    s = tolower($0); a = tolower(anchor); n = tolower(needle);
    # EVERY occurrence, not just the first. Anchoring on the first match alone
    # decided the verdict by wherever the phrase happened to appear earliest:
    # a rule deleted from its real location could still pass against an
    # unrelated earlier mention, and adding a paragraph above could fail a
    # correct document. "some mention is near the needle" is what is meant.
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

SMOKE="$REPO_ROOT/skills/smoke-test/SKILL.md"
DEPLOY="$REPO_ROOT/skills/deploy-status/SKILL.md"
RELEASE="$REPO_ROOT/skills/release-conductor/SKILL.md"

# A setup() failure fails the test the same way an in-body `[ -f ... ]` does —
# still NOT `skip`, which would report `ok` for a missing artifact. This just
# removes the same three existence checks repeated at the top of every test.
setup() {
  [ -f "$SMOKE" ]
  [ -f "$DEPLOY" ]
  [ -f "$RELEASE" ]
}

@test "smoke-test: SKILL.md exists with matching id and name" {
  # id and name must agree: the manifest keys on one and the slash command
  # resolves the other, so a mismatch produces a skill that validates but
  # cannot be invoked by the name it advertises.
  run grep -qE '^id: smoke-test$' "$SMOKE"
  [ "$status" -eq 0 ]
  run grep -qE '^name: smoke-test$' "$SMOKE"
  [ "$status" -eq 0 ]
  run grep -qE '^type: skill$' "$SMOKE"
  [ "$status" -eq 0 ]
  # It runs repo-declared commands against production, so it must not be
  # reachable by model inference alone.
  run grep -qE '^disable-model-invocation: true$' "$SMOKE"
  [ "$status" -eq 0 ]
}

@test "smoke-test: resolves the deploy-ops helper the same way deploy-status does" {
  # Asserted across EVERY file that embeds the snippet, not just this one. The
  # previous version greped only $SMOKE while claiming parity with
  # deploy-status, so a release-conductor copy that dropped the `exit 2` branch
  # passed this suite — the exact instruction most likely to be dropped was the
  # one nothing guarded.
  #
  # Three parts: the bootstrapped $HOME copy, the in-repo fallback GUARDED by
  # its own existence test, and a diagnostic exit 2 when neither resolves.
  # Without the third, a missing helper is indistinguishable from a broken
  # deployment; without the guard on the second, an unverified in-tree script
  # gets executed.
  for file in "$SMOKE" "$DEPLOY" "$RELEASE"; do
    run grep -q '\$HOME/.claude/skills/deploy-status/scripts/deploy-ops.mjs' "$file"
    [ "$status" -eq 0 ]
    run grep -qE 'elif \[ -f "skills/deploy-status/scripts/deploy-ops\.mjs" \]' "$file"
    [ "$status" -eq 0 ]
    run grep -qE '^\s*exit 2$' "$file"
    [ "$status" -eq 0 ]
  done
  # And smoke-test must call the smoke subcommand, not status.
  run grep -qE 'node "\$DEPLOY_OPS" smoke' "$SMOKE"
  [ "$status" -eq 0 ]
}

@test "smoke-test: constrains the arguments it forwards to the helper" {
  # $ARGUMENTS is raw caller text spliced into a command that reaches
  # production, so the prose must name the surface it forwards rather than
  # passing whatever was typed.
  run near "$SMOKE" "ARGUMENTS" "--dry-run"
  [ "$status" -eq 0 ]
  run grep -qiE 'only .*(--dry-run|--json)|allowlist|drop anything else' "$SMOKE"
  [ "$status" -eq 0 ]
}

@test "smoke-test: recommends /rollback-prod on failure and never invokes it" {
  # The recommendation must be present...
  run grep -q '/rollback-prod' "$SMOKE"
  [ "$status" -eq 0 ]
  # ...and the prohibition must be explicit. KD-13 and the rule floor both
  # forbid a production change without direct instruction, so a skill that
  # merely omits the invocation is not enough — a later edit would add it back.
  run near "$SMOKE" "never invoke" "rollback-prod"
  [ "$status" -eq 0 ]
  # The skill must not contain a line that actually runs the rollback helper.
  run grep -nE '^[^#|]*node "\$DEPLOY_OPS" rollback' "$SMOKE"
  [ "$status" -ne 0 ]
}

@test "release-conductor: verify reports deploy status and smoke results when a deploy target exists" {
  # Flow 5 step 2: both commands run, and they run inside the verify
  # subcommand rather than somewhere earlier in the gating flow.
  verify_line=$(grep -n '^## `verify <tag>` subcommand' "$RELEASE" | head -1 | cut -d: -f1)
  [ -n "$verify_line" ]
  release_line=$(grep -n 'gh release view' "$RELEASE" | head -1 | cut -d: -f1)
  status_line=$(grep -nE 'deploy-ops\.mjs status|DEPLOY_OPS" status' "$RELEASE" | head -1 | cut -d: -f1)
  smoke_line=$(grep -nE 'deploy-ops\.mjs smoke|DEPLOY_OPS" smoke' "$RELEASE" | head -1 | cut -d: -f1)
  [ -n "$release_line" ]
  [ -n "$status_line" ]
  [ -n "$smoke_line" ]
  [ "$status_line" -gt "$verify_line" ]
  [ "$smoke_line" -gt "$verify_line" ]
  # Ordering is declared by Flow 5 and load-bearing, so it is asserted rather
  # than assumed. Registry checks first: a deploy verdict means little if the
  # artifact was never published. Then status BEFORE smoke: status establishes
  # which revision is live, and a smoke pass against a drifted revision is a
  # pass for the wrong artifact.
  [ "$status_line" -gt "$release_line" ]
  [ "$status_line" -lt "$smoke_line" ]
  # Flow 5 step 3 has TWO obligations — recommend AND stop. A bare grep for
  # the slash command is satisfied by any mention anywhere, including the
  # Rules bullet, so "and stop" would be invisible if deleted.
  run near "$RELEASE" "rollback-prod" "stop"
  [ "$status" -eq 0 ]
}

@test "release-conductor: lets the helper decide whether a deploy target exists" {
  # Flow 5 says "when a deploy target exists", not "when a config file
  # exists". deploy-ops.mjs auto-discovers from .vercel/project.json and
  # fly.toml, so gating on .claude/deploy-targets.json reports SKIPPED for a
  # Vercel or Fly repo that has a real, checkable target — the same dishonesty
  # the SKIPPED rule forbids, inverted.
  run grep -qE 'if \[ -f "\.claude/deploy-targets\.json" \]' "$RELEASE"
  [ "$status" -ne 0 ]
  # And an unresolvable target must read as SKIPPED, not FAIL.
  run near "$RELEASE" "exit 2" "SKIPPED"
  [ "$status" -eq 0 ]
}

@test "release-conductor: verify reports SKIPPED for smoke when no deploy target exists" {
  # Absent configuration must read as SKIPPED, not as a pass. A verify that
  # printed PASS for checks it never ran is the failure this whole unit exists
  # to prevent, and it is invisible in the output.
  run grep -qE 'SKIPPED' "$RELEASE"
  [ "$status" -eq 0 ]
  # The SKIPPED wording must be tied to the absence of a deploy target, in the
  # same sentence — a floating "SKIPPED" elsewhere in the document would
  # otherwise satisfy this while the rule it encodes went missing.
  run near "$RELEASE" "no deploy target" "SKIPPED"
  [ "$status" -eq 0 ]
}
