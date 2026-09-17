# Plan-Grader Rubric

Rubric version: `2.0.0`

Use this rubric to grade implementation plans on a 0-10 scale. The score is evidence-based:
cite plan lines, intent files, harness files, repo paths, validation commands, or missing evidence.

## Confidence

Assign one confidence value:

- `high`: grading a real plan file or quoted inline text supplied by the user.
- `medium`: grading a clear plan block extracted from session, rollout, or exported transcript data.
- `low`: grading a heuristic extraction where no clear plan block was found.

Confidence affects how strongly to phrase conclusions, not the math. Low confidence should usually
produce a paste-back prompt asking for the original plan file or exact quoted plan.

## Dimensions

Weights sum to 1.00.

| Dimension                                     | Weight | What To Evaluate                                                                                                                             |
| --------------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal and scope clarity                        |   0.15 | The plan states the intended outcome, output contract, non-goals, assumptions, and decision points.                                          |
| Intent-source alignment                       |   0.15 | The plan reads and honors mentioned specs, roadmap files, issue text, PR feedback, user instructions, and linked context.                    |
| Repo grounding and affected-surface inventory |   0.20 | The plan identifies real files, generated artifacts, tests, ownership boundaries, and existing abstractions.                                 |
| Execution completeness and ordering           |   0.15 | The plan is executable in a coherent order, includes regeneration steps, and avoids unresolved major choices.                                |
| Harness compatibility                         |   0.10 | The plan respects AGENTS.md, agent-specific overrides, protected paths, PR conventions, CI, release gates, and local workflow rules.         |
| Validation and test plan                      |   0.15 | The plan specifies meaningful automated and manual verification with concrete pass/fail assertions.                                          |
| Risk handling and handoff quality             |   0.10 | The plan identifies data-loss, security, migration, release, nondeterminism, rollback, and follow-up risks, then hands off actionable fixes. |

Risk handling is weighted at 0.10 because plan reviews are often most valuable when they catch
failure modes before implementation. Harness compatibility was reduced from 0.15 to 0.10 because
serious harness failures are already covered by caps and auto-reject rules; the dimension still
captures ordinary compatibility quality without double-counting catastrophic violations.

## Dimension Scoring Bands

| Score | Meaning                                                                      |
| ----: | ---------------------------------------------------------------------------- |
|  9-10 | Strong, specific, evidence-backed, and ready to execute.                     |
|   7-8 | Directionally sound with bounded gaps or minor missing assertions.           |
|   5-6 | Salvageable but missing important surfaces, decisions, or validation detail. |
|   3-4 | Weak, vague, or risky enough that execution would likely waste time.         |
|   0-2 | Broken, incoherent, unsafe, or not meaningfully a plan.                      |

## Score Calculation

1. Score every dimension 0-10.
2. Compute `weighted = sum(weight * dimension_score)`.
3. Apply caps by taking the minimum of `weighted` and every fired cap.
4. Apply auto-reject rules.
5. Apply floor at 0.
6. Round the score to one decimal.

## Verdicts

Auto-reject caps force `verdict: reject` regardless of numeric score.

|    Score | Verdict                    |
| -------: | -------------------------- |
| 9.0-10.0 | approve                    |
|  8.0-8.9 | approve with minor changes |
|  6.0-7.9 | revise before execution    |
|  0.0-5.9 | reject                     |

## Caps

| Cap ID                     | Max Score | Auto-Reject | Trigger                                                                                                 |
| -------------------------- | --------: | ----------- | ------------------------------------------------------------------------------------------------------- |
| not-repo-grounded          |       7.0 | no          | Plan does not inspect or reference the actual repository where it will run.                             |
| unresolved-major-decisions |       6.0 | no          | Plan cannot be executed without making major product, architecture, or delivery choices.                |
| weak-validation            |       7.0 | no          | Code-changing plan omits meaningful tests, validation commands, or pass/fail assertions.                |
| ignored-intent-file        |       8.0 | no          | Plan mentions an intent source but does not read or incorporate it.                                     |
| contradicts-intent         |       6.0 | no          | Plan conflicts with a readable roadmap, spec, issue, PR feedback, or user instruction.                  |
| project-harness-violation  |       6.0 | no          | Plan violates project-level AGENTS.md, CLAUDE.md, GEMINI.md, Copilot instructions, or equivalent rules. |
| user-harness-violation     |       7.0 | no          | Plan conflicts with user/global harness rules that affect safety or workflow expectations.              |
| gate-bypass                |       5.0 | yes         | Plan bypasses protected-path, Spec ID, CI, release, review, or publish gates.                           |
| dangerous-change           |       5.0 | yes         | Plan is likely to cause data loss, security breakage, credential exposure, or release breakage.         |
| vague-proposal             |       4.0 | no          | Plan is too vague to execute or mostly restates the goal.                                               |

The two dangerous caps intentionally force reject instead of only lowering the score. A plan that
can break releases, bypass gates, expose secrets, or destroy data should not receive an "approve"
verdict because it is polished elsewhere.

## Rubric Versioning

- Major version: weights, caps, auto-reject behavior, verdict thresholds, or JSON contract changes.
- Minor version: dimension wording, examples, confidence wording, or paste-back prompt improvements
  that do not change scoring math.
- Patch version: typos, clarifications, formatting, or additional non-normative examples.

Calibration-anchor tests must pin the rubric version they were calibrated against. If the rubric
major version changes, recalibrate anchors before shipping the change.
