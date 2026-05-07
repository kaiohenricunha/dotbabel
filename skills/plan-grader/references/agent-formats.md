# Agent Formats

Use these templates for `paste_back_prompt`. Keep prompts concrete and scoped to the gaps found.

## Agent Detection

Detect the source agent from explicit user input first, then from file paths, transcript markers,
plan prose, or command names. If detection is uncertain, use the generic fallback.

When `--blind` is set, remove source-agent attribution before scoring. You may still use a supplied
agent name to format the paste-back prompt after the score is computed.

## Claude Code

Style: structured rationale, explicit plan edits, and clear implementation gates.

Template:

```text
Please revise the plan before implementation. Keep the current scope, but address these gaps:

1. <blocking gap>
2. <blocking gap>

Also add these validation details:
- <test or assertion>

Show the revised plan before coding.
```

## Codex

Style: imperative, AGENTS.md-like constraints, direct and test-focused.

Template:

```text
Revise the plan with these constraints:
- <blocking constraint>
- <blocking constraint>
- Add validation: <specific command/assertion>.
- Preserve repo harness rules from AGENTS.md and any path-specific overrides.

Return the updated plan only.
```

## Gemini CLI

Style: ordered steps and confirmation points.

Template:

```text
Update the plan in this order:
1. <step>
2. <step>
3. Add verification for <risk>.

Before execution, confirm:
- <confirmation>
- <confirmation>
```

## GitHub Copilot

Style: concise, actionable, minimal ceremony.

Template:

```text
Revise this plan to:
- <action>
- <action>
- Add a test for <case>.

Keep the plan non-mutating until approved.
```

## Generic Fallback

```text
Revise the plan to address these blocking gaps:
1. <gap>
2. <gap>

Add concrete validation commands and pass/fail assertions, then show the updated plan before
implementation.
```
