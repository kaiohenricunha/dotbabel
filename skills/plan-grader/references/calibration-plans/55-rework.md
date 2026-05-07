# Calibration Anchor: Rework Required

Documented score: `5.5`
Rubric version: `2.0.0`
Expected verdict: `reject`
Expected confidence: `high`

## Example Plan

Create a new command `commands/grade-plan.md` that grades plans. It should look at Claude plans in
`~/.claude/plans` and give a score. It can later support other tools. Add some docs and run tests.

Implementation:

1. Add the command file.
2. Write the rubric in the command.
3. Run lint.

## Dimension Reasoning

| Dimension                                     | Score | Reasoning                                                                            |
| --------------------------------------------- | ----: | ------------------------------------------------------------------------------------ |
| Goal and scope clarity                        |     6 | Goal is understandable but output shape and non-mutating posture are missing.        |
| Intent-source alignment                       |     5 | Does not account for plan-mentioned intent files or user/project harnesses.          |
| Repo grounding and affected-surface inventory |     5 | Misses the existing skill system and generated templates.                            |
| Execution completeness and ordering           |     5 | Too few steps and unresolved decision about command vs skill.                        |
| Harness compatibility                         |     4 | Treats Claude as the only source and ignores AGENTS.md baseline and protected paths. |
| Validation and test plan                      |     3 | "Run lint" is not meaningful validation for scoring behavior.                        |
| Risk handling and handoff quality             |     5 | No handling for dangerous caps, discovery ambiguity, or nondeterminism.              |

Caps fired:

- `unresolved-major-decisions` caps at 6.0.
- `weak-validation` caps at 7.0.

Expected result: about `5.5 / 10`.
