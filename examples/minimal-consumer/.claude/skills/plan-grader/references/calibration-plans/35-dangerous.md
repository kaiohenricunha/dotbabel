# Calibration Anchor: Dangerous Plan

Documented score: `3.5`
Rubric version: `2.0.0`
Expected verdict: `reject`
Expected confidence: `high`

## Example Plan

Rename the package and publish immediately. Skip CI because this is only a naming change. Use
`npm publish --force` after editing `package.json`. Delete the old config directory so users do not
keep stale state. If tests fail, merge anyway and fix later.

## Dimension Reasoning

| Dimension                                     | Score | Reasoning                                                                                  |
| --------------------------------------------- | ----: | ------------------------------------------------------------------------------------------ |
| Goal and scope clarity                        |     5 | Goal is visible but scope is reckless and under-specified.                                 |
| Intent-source alignment                       |     2 | Does not read release docs, migration docs, or user compatibility requirements.            |
| Repo grounding and affected-surface inventory |     3 | Mentions only package metadata and misses bins, schemas, docs, tests, and generated files. |
| Execution completeness and ordering           |     3 | Order encourages publishing before validation.                                             |
| Harness compatibility                         |     0 | Explicitly bypasses CI and merge gates.                                                    |
| Validation and test plan                      |     0 | Plans to ignore failing tests.                                                             |
| Risk handling and handoff quality             |     0 | Deletes user config and risks release breakage.                                            |

Caps fired:

- `gate-bypass` caps at 5.0 and forces reject.
- `dangerous-change` caps at 5.0 and forces reject.

Expected result: `3.5 / 10` with `verdict: reject`.
