#!/usr/bin/env bats
# guard-criteria-evidence.bats — P-B4 tests for the PreToolUse hook that stops
# an agent hand-writing a criteria evidence marker.
#
# Why the hook exists: the merge gate believes a comment whose first line
# carries `<!-- dotbabel-criteria verified-sha=<sha> -->` from a trusted
# author. An agent with a `gh` tool call is a trusted author. Nothing in the
# gate can tell a marker the tool wrote from one an agent typed, so the
# distinction has to be enforced where the command is issued.
#
# Exit 2 blocks the tool call (Claude Code hook protocol); exit 0 allows it.

load helpers

HOOK="$REPO_ROOT/plugins/dotbabel/hooks/guard-criteria-evidence.sh"

# Feed the hook a PreToolUse payload for a Bash command.
run_hook() {
  printf '%s' "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":$1}}" | bash "$HOOK"
}

@test "guard-criteria-evidence: hook exists and is executable" {
  [ -f "$HOOK" ]
  [ -x "$HOOK" ]
}

@test "guard-criteria-evidence: denies a gh command that writes the dotbabel-criteria marker" {
  run run_hook '"gh pr comment 42 --body \"<!-- dotbabel-criteria verified-sha=abc -->\""'
  [ "$status" -eq 2 ]

  # The same marker through a body file, and through the API, must also block —
  # otherwise the guard only stops the most obvious spelling.
  run run_hook '"gh api repos/o/r/issues/42/comments -f body=\"<!-- dotbabel-criteria verified-sha=abc -->\""'
  [ "$status" -eq 2 ]
}

@test "guard-criteria-evidence: allows the dotbabel-criteria bin to post evidence" {
  # The bin is the sanctioned writer; blocking it would break the workflow the
  # guard exists to protect.
  run run_hook '"node plugins/dotbabel/bin/dotbabel-criteria.mjs verify --pr 42 --post"'
  [ "$status" -eq 0 ]

  run run_hook '"dotbabel criteria verify --pr 42 --post"'
  [ "$status" -eq 0 ]
}

@test "guard-criteria-evidence: allows unrelated gh and shell commands" {
  run run_hook '"gh pr comment 42 --body \"looks good to me\""'
  [ "$status" -eq 0 ]

  run run_hook '"git status --porcelain"'
  [ "$status" -eq 0 ]
}

@test "guard-criteria-evidence: ignores non-Bash tool calls" {
  run bash -c "printf '%s' '{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"x\"}}' | bash '$HOOK'"
  [ "$status" -eq 0 ]
}

@test "guard-criteria-evidence: honors the documented bypass variable" {
  run bash -c "BYPASS_CRITERIA_EVIDENCE_GUARD=1 printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"gh pr comment 1 --body \\\"<!-- dotbabel-criteria verified-sha=abc -->\\\"\"}}' | BYPASS_CRITERIA_EVIDENCE_GUARD=1 bash '$HOOK'"
  [ "$status" -eq 0 ]
}

@test "guard-criteria-evidence: is registered in the project settings and shipped as a template" {
  run grep -q 'guard-criteria-evidence.sh' "$REPO_ROOT/.claude/settings.json"
  [ "$status" -eq 0 ]
  [ -f "$REPO_ROOT/plugins/dotbabel/templates/claude/hooks/guard-criteria-evidence.sh" ]
  run grep -q 'guard-criteria-evidence.sh' "$REPO_ROOT/plugins/dotbabel/templates/claude/settings.json"
  [ "$status" -eq 0 ]
}
