#!/usr/bin/env bats
# security-audit-skill.bats — contract tests for the security-audit wrapper
# skill and its vendored upstream copy (cloudflare/security-audit-skill).
#
# The wrapper is prose an agent executes. Its job is to remap upstream paths
# that break when the upstream files sit one folder deeper, so these tests pin
# the mapping sentences and the layout rules that keep a second skill from
# being registered.
#
# `skip` is deliberately not used for a missing artifact — a skipped bats test
# reports `ok`, so it would make this whole file green with no skill at all.

load helpers

flowed() { tr '\n' ' ' < "$1" | tr -s ' '; }

# near <file> <anchor> <needle> [window] — true when <needle> appears within
# <window> characters after some occurrence of <anchor> in the flowed text.
near() {
  flowed "$1" | awk -v anchor="$2" -v needle="$3" -v win="${4:-200}" '{
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

SKILL_DIR="$REPO_ROOT/skills/security-audit"
SKILL="$SKILL_DIR/SKILL.md"
TEMPLATE_DIR="$REPO_ROOT/plugins/dotbabel/templates/claude/skills/security-audit"

setup() {
  [ -f "$SKILL" ]
  [ -f "$SKILL_DIR/references/UPSTREAM.json" ]
  [ -f "$SKILL_DIR/references/upstream/UPSTREAM-SKILL.md" ]
}

@test "security-audit: SKILL.md has matching id and name" {
  run grep -qE '^id: security-audit$' "$SKILL"
  [ "$status" -eq 0 ]
  run grep -qE '^name: security-audit$' "$SKILL"
  [ "$status" -eq 0 ]
}

@test "security-audit: no nested SKILL.md in the source or the template copy" {
  # Hosts that scan skill folders recursively would register the upstream
  # file as a second `security-audit` skill.
  run find "$SKILL_DIR/references" "$TEMPLATE_DIR/references" -name SKILL.md
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "security-audit: the template copy ships the upstream files and the pin" {
  [ -f "$TEMPLATE_DIR/references/upstream/UPSTREAM-SKILL.md" ]
  [ -f "$TEMPLATE_DIR/references/upstream/validate-findings.cjs" ]
  [ -f "$TEMPLATE_DIR/references/upstream/LICENSE" ]
  [ -f "$TEMPLATE_DIR/references/UPSTREAM.json" ]
  [ -f "$TEMPLATE_DIR/scripts/findings-to-sarif.mjs" ]
}

@test "security-audit: tells the agent to read UPSTREAM-SKILL.md first" {
  near "$SKILL" "Read \`references/upstream/UPSTREAM-SKILL.md\`" "then follow it" 80
}

@test "security-audit: maps <skill-dir> and bare SKILL.md to the upstream folder" {
  near "$SKILL" "<skill-dir>" "absolute path of \`references/upstream/\`" 80
  near "$SKILL" "A bare \`SKILL.md\`" "references/upstream/UPSTREAM-SKILL.md" 120
}

@test "security-audit: refuses full audit mode on a host without isolated sub-agents" {
  near "$SKILL" "no isolated parallel sub-agents" "do not run full audit mode" 80
}

@test "security-audit: forbids hand edits to the upstream copy" {
  near "$SKILL" "Do not edit files in \`references/upstream/\`" "sync-security-audit.mjs" 120
}

@test "security-audit: ships the artifact promoter and documents how to run it" {
  # Without this, a run cannot retain evidence produced by target-controlled
  # code, and every such lead stays needs_validation with a promotion blocker.
  [ -f "$SKILL_DIR/scripts/promote-artifact/promote-artifact.go" ]
  [ -f "$SKILL_DIR/scripts/promote-artifact/promote-artifact_test.go" ]
  [ -f "$TEMPLATE_DIR/scripts/promote-artifact/promote-artifact.go" ]
  # A go.mod anywhere in this repo makes `dotbabel quality` discover a Go
  # component (quality/adapters/go.mjs keys on go.mod), so there must be none.
  run find "$SKILL_DIR/scripts" "$TEMPLATE_DIR/scripts" -name go.mod
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  near "$SKILL" "promote-artifact.go" "--scratch" 200
  near "$SKILL" "When it is not" "no parent-side artifact promotion available" 400
}

@test "security-review: routes whole-repository audits to security-audit" {
  near "$REPO_ROOT/skills/security-review/SKILL.md" "whole-repository" "\`security-audit\` skill" 160
}
