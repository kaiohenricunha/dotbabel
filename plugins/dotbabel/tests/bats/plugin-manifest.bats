#!/usr/bin/env bats
#
# The plugin and marketplace manifests are the repo's install surface: a user
# runs `/plugin marketplace add kaiohenricunha/dotbabel` and Claude Code reads
# these two files. Nothing checked them until now, and they were broken the
# whole time — every skills[] entry pointed at a SKILL.md file where the schema
# requires the containing directory, so the plugin was uninstallable while
# `npm run dogfood` reported green.
#
# `claude plugin validate` is the same check the community-marketplace review
# pipeline runs, so this is the authoritative gate rather than a reimplemented
# guess at the schema. Skipped when the CLI is absent (CI runners, contributor
# machines without Claude Code) — a skip is honest; a hand-rolled substitute
# that drifts from the real schema is not.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)"
}

@test "plugin manifest passes claude plugin validate" {
  command -v claude >/dev/null || skip "claude CLI not installed"
  run claude plugin validate "$REPO_ROOT/plugins/dotbabel"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Validation passed"* ]]
}

@test "marketplace manifest passes claude plugin validate" {
  command -v claude >/dev/null || skip "claude CLI not installed"
  run claude plugin validate "$REPO_ROOT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Validation passed"* ]]
}

@test "plugin manifest validates with zero warnings, not just zero errors" {
  # A warning here means a shipped command or skill is missing frontmatter,
  # which degrades how it appears to anyone who installs the plugin.
  command -v claude >/dev/null || skip "claude CLI not installed"
  run claude plugin validate "$REPO_ROOT/plugins/dotbabel"
  [[ "$output" != *"warning"* ]]
}

@test "skills entries are directories, never SKILL.md paths" {
  # The original bug, pinned independently of the CLI so it is caught even
  # where `claude` is unavailable.
  run node -e "
    const m = require('$REPO_ROOT/plugins/dotbabel/.claude-plugin/plugin.json');
    const bad = (m.skills || []).filter((s) => s.endsWith('SKILL.md'));
    if (bad.length) { console.error('file paths in skills[]: ' + bad.length); process.exit(1); }
  "
  [ "$status" -eq 0 ]
}

@test "plugin name and version track the package, not a pre-rename identity" {
  run node -e "
    const pkg = require('$REPO_ROOT/package.json');
    const m = require('$REPO_ROOT/plugins/dotbabel/.claude-plugin/plugin.json');
    if (m.name !== 'dotbabel') { console.error('name is ' + m.name); process.exit(1); }
    if (m.version !== pkg.version) {
      console.error('version ' + m.version + ' != package ' + pkg.version); process.exit(1);
    }
  "
  [ "$status" -eq 0 ]
}

@test "marketplace entry points at the plugin directory that actually exists" {
  run node -e "
    const mk = require('$REPO_ROOT/.claude-plugin/marketplace.json');
    const fs = require('fs');
    for (const p of mk.plugins) {
      const dir = '$REPO_ROOT/' + p.source.path;
      if (!fs.existsSync(dir + '/.claude-plugin/plugin.json')) {
        console.error('no plugin.json under ' + p.source.path); process.exit(1);
      }
    }
  "
  [ "$status" -eq 0 ]
}
