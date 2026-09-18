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

# Registration names a PATH, and a path that does not resolve is not a guard:
# the hook command simply fails to exec (127), which is not the protocol's
# blocking exit 2. This shipped registered-but-absent once, so assert the file
# behind every registration actually exists.
@test "guard-criteria-evidence: every registered hook path resolves to a real file" {
  while IFS= read -r registered; do
    [ -n "$registered" ] || continue
    [ -f "$REPO_ROOT/$registered" ]
  done < <(grep -oE '[^"]*guard-criteria-evidence\.sh' "$REPO_ROOT/.claude/settings.json" | sed 's|^.*\$CLAUDE_PROJECT_DIR/||')
}

# A copy that drifts is never executed by this suite, so pin them byte for byte
# — the sibling suite does the same after a downstream copy once failed open.
@test "guard-criteria-evidence: every shipped copy is byte-identical to the canonical file" {
  for copy in \
    .claude/hooks/guard-criteria-evidence.sh \
    plugins/dotbabel/templates/claude/hooks/guard-criteria-evidence.sh; do
    run cmp "$HOOK" "$REPO_ROOT/$copy"
    [ "$status" -eq 0 ]
  done
}

# --------- adversarial: the allowlist must not be self-serving ---------
#
# Two earlier revisions shipped an allow-rule the attacker controlled. First the
# bare token `dotbabel-criteria` matched inside the marker itself; then, once
# that was narrowed to an invocation shape, merely MENTIONING the bin anywhere
# in the line still whitelisted the whole call. These cases pin both shut.

@test "guard-criteria-evidence: a marker is not whitelisted by mentioning the bin in the same command" {
  run run_hook '"gh pr comment 1 --body \"<!-- dotbabel-criteria verified-sha=abc --> verified via dotbabel-criteria.mjs run\""'
  [ "$status" -eq 2 ]
}

@test "guard-criteria-evidence: chaining a real invocation does not whitelist a hand-written marker" {
  run run_hook '"node plugins/dotbabel/bin/dotbabel-criteria.mjs list --pr 1 && gh pr comment 1 --body \"<!-- dotbabel-criteria verified-sha=abc -->\""'
  [ "$status" -eq 2 ]

  run run_hook '"dotbabel criteria list --pr 1; gh api repos/o/r/issues/1/comments -f body=\"<!-- dotbabel-criteria verified-sha=abc -->\""'
  [ "$status" -eq 2 ]
}

@test "guard-criteria-evidence: blocks a marker carried in a --body-file" {
  marker_file="$BATS_TEST_TMPDIR/evidence.md"
  printf '<!-- dotbabel-criteria verified-sha=abc -->\nall good\n' > "$marker_file"

  run run_hook "\"gh pr comment 1 --body-file $marker_file\""
  [ "$status" -eq 2 ]

  run run_hook "\"gh api repos/o/r/issues/1/comments -F body=@$marker_file\""
  [ "$status" -eq 2 ]
}

@test "guard-criteria-evidence: a body file without the marker still posts" {
  plain_file="$BATS_TEST_TMPDIR/plain.md"
  printf 'looks good to me\n' > "$plain_file"

  run run_hook "\"gh pr comment 1 --body-file $plain_file\""
  [ "$status" -eq 0 ]
}

@test "guard-criteria-evidence: refuses rather than failing open when jq is unavailable" {
  # An empty PATH removes jq — and cat and grep with it, which is the point:
  # the fallback must reach its verdict with bash builtins alone, or it fails
  # open on exactly the case it exists to catch. bash is invoked by absolute
  # path because an empty PATH cannot find bash either.
  empty="$BATS_TEST_TMPDIR/empty-path"
  mkdir -p "$empty"
  payload="$BATS_TEST_TMPDIR/marker.json"
  printf '{"tool_name":"Bash","tool_input":{"command":"gh pr comment 1 --body X"}}' \
    | sed 's/X/<!-- dotbabel-criteria verified-sha=abc -->/' > "$payload"

  run bash -c "PATH='$empty' /bin/bash '$HOOK' < '$payload'"
  [ "$status" -eq 2 ]

  # An unrelated call still works without jq, so the guard is not a blanket block.
  plain="$BATS_TEST_TMPDIR/plain.json"
  printf '{"tool_name":"Bash","tool_input":{"command":"git status"}}' > "$plain"
  run bash -c "PATH='$empty' /bin/bash '$HOOK' < '$plain'"
  [ "$status" -eq 0 ]
}

@test "guard-criteria-evidence: the command-prefix bypass does not work, as documented" {
  # The prefix is applied by the shell the Bash tool spawns AFTER hooks run, so
  # it never reaches this hook's environment. An earlier revision documented it
  # as a working per-call escape hatch and the suite hid that by setting the
  # variable on the hook process instead.
  run bash -c "printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"BYPASS_CRITERIA_EVIDENCE_GUARD=1 gh pr comment 1 --body \\\"<!-- dotbabel-criteria verified-sha=abc -->\\\"\"}}' | env -u BYPASS_CRITERIA_EVIDENCE_GUARD bash '$HOOK'"
  [ "$status" -eq 2 ]
}


# --- P-G1: the guard covers the local-attest marker family too --------------
#
# The merge gate now skips the full test suite AND the quality profile on the
# strength of a local-attest comment. That makes a forged one strictly worse
# than a forged criteria marker: the first removes verification, the second
# only misreports it. The guard covered exactly one family until this change.
#
# The markers are assembled from parts here for a reason that is itself the
# point: a file containing either literal cannot be written by an agent whose
# Bash calls this hook. $SP keeps them non-contiguous in this source file.

SP=' '

@test "guard-criteria-evidence: denies a gh command that writes the local-attest marker" {
  marker="local-attest${SP}verified-sha="
  run run_hook "\"gh pr comment 42 --body \\\"<!-- ${marker}abc1234 -->\\\"\""
  [ "$status" -eq 2 ]
  [[ "$output" == *"BLOCKED"* ]]
}

@test "guard-criteria-evidence: denies the local-attest payload line" {
  # A marker with no payload is refused by the gate as ATTESTATION_INVALID, so
  # guarding only the marker would leave the shape that actually works open.
  run run_hook "\"gh pr comment 42 --body \\\"<!-- local-attest-payload eyJhIjoxfQ -->\\\"\""
  [ "$status" -eq 2 ]
}

@test "guard-criteria-evidence: denies a local-attest marker delivered via --body-file" {
  marker="local-attest${SP}verified-sha="
  printf '<!-- %sabc1234 -->\n' "$marker" > "$BATS_TEST_TMPDIR/forged.md"
  run run_hook "\"gh pr comment 42 --body-file $BATS_TEST_TMPDIR/forged.md\""
  [ "$status" -eq 2 ]
  [[ "$output" == *"forged.md"* ]]
}

@test "guard-criteria-evidence: allows the sanctioned local-attest writer" {
  # The real producer never carries either marker in its own command text.
  run run_hook '"dotbabel local-attest --pr 42"'
  [ "$status" -eq 0 ]
}

@test "guard-criteria-evidence: both marker families are guarded, not just one" {
  # The regression this pins: extending the gate's authority to a second
  # marker family without extending the write-side guard left the stronger
  # authorization path as the only unguarded one.
  crit="dotbabel-criteria${SP}verified-sha="
  attest="local-attest${SP}verified-sha="
  for m in "$crit" "$attest"; do
    run run_hook "\"gh pr comment 42 --body \\\"<!-- ${m}abc -->\\\"\""
    [ "$status" -eq 2 ]
  done
}
