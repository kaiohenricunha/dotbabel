# Calibration Anchor: Solid But Incomplete Plan

Documented score: `7.5`
Rubric version: `2.0.0`
Expected verdict: `revise before execution`
Expected confidence: `high`

## Example Plan

Add a `plan-grader` skill that grades plans on a 0-10 scale. The skill should accept a file path or
quoted text and should output a human-readable score with blocking gaps. It will use a weighted
rubric and should read `AGENTS.md` plus agent-specific instruction files.

Implementation steps:

1. Create `skills/plan-grader/SKILL.md`.
2. Add `references/rubric.md`.
3. Add `references/plan-discovery.md`.
4. Run `npm run build-plugin`.
5. Run `npm run lint`.

The PR should mention the skill in the summary.

## Dimension Reasoning

| Dimension                                     | Score | Reasoning                                                                           |
| --------------------------------------------- | ----: | ----------------------------------------------------------------------------------- |
| Goal and scope clarity                        |     8 | Basic purpose and inputs are clear, but JSON output and confidence are unspecified. |
| Intent-source alignment                       |     7 | Mentions harness files but not plan-mentioned intent files such as `@roadmap.md`.   |
| Repo grounding and affected-surface inventory |     7 | Names real skill paths but omits generated index artifacts and manifest.            |
| Execution completeness and ordering           |     8 | Steps are coherent but missing changelog and calibration anchors.                   |
| Harness compatibility                         |     7 | Reads AGENTS.md but does not mention protected-path Spec ID requirements.           |
| Validation and test plan                      |     6 | Has basic commands but no pass/fail assertions or behavioral fixture tests.         |
| Risk handling and handoff quality             |     7 | Some risk awareness, but no nondeterminism or discovery-failure policy.             |

Caps fired:

- `weak-validation` may cap at 7.0 if treated as code-changing without meaningful assertions.

Expected result: about `7.5 / 10`, or `7.0 / 10` if the weak-validation cap is applied strictly.
