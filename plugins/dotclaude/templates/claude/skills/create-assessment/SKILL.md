---
id: create-assessment
name: create-assessment
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [review, documentation]
maturity: validated
description: >
  Create a structured assessment document grading a target on a 0-10 scale with a weighted rubric, saved to docs/assessments/.
  Triggers on: "grade", "rate", "score", "evaluate", "assess".
argument-hint: "[target]"
tools: Read, Grep, Glob, Bash, Write
model: opus
---

Create a structured assessment document that grades a target on a 0-10 scale using a weighted rubric and save it to the project's `docs/assessments/` directory.

Trigger: when the user asks to grade, rate, score, evaluate, or assess a specific target — a package, a project/repo, a source file, an architecture decision, a pull request, or a document. Also triggered directly via `/create-assessment`. This skill is about **producing a numeric grade**, not listing issues — for issue-triage with severity levels use `/create-audit`.

Arguments: `$ARGUMENTS` — a description of what to assess (e.g. "the ingest pipeline package", "src/App.jsx", "the decision to self-host Fly Postgres", "PR #412", "docs/specs/local-dev.md"). The user may also append `using dimensions: <name> <weight>, <name> <weight>, ...` to override the default rubric.

## Steps

1. **Parse the target** from `$ARGUMENTS`. If empty or vague, infer from recent conversation. If still unclear, ask the user what to assess and which dimensions matter most.

2. **Classify the target** into exactly one type: `package` | `project` | `source-file` | `architecture-decision` | `pull-request` | `document` | `other`. State the classification explicitly in the output doc.

3. **Select the rubric.** If the user provided dimensions+weights in `$ARGUMENTS`, use those verbatim. Otherwise use the built-in rubric for the classified type (see Rubrics below). For `other`, pick the closest rubric and note the adaptation.

4. **Investigate each dimension.** Read relevant source files, configs, tests, CI logs, git history, external state (deployment status, dependency advisories, benchmarks) as needed. Every score must be backed by evidence: `file:line`, command output, metric, test result, or a specific historical event. Do not guess. If you cannot gather evidence for a dimension, score it 0 and explain why in the Evidence column.

5. **Score each dimension 0-10** against the grade bands below. Compute the overall grade as `Σ(weight × score)`, rounded to 1 decimal.

6. **Generate the assessment document** using the structure below.

7. **Generate a filename** in the format: `<target-slug>-<YYYY-MM-DD>.md`. Use lowercase kebab-case. If the target is a file path, slug is the basename without extension (`src/App.jsx` → `app-jsx`). If it's a PR, use `pr-<N>`. If it's a decision, use a short kebab phrase.

8. **Write the file** to `docs/assessments/<filename>`. Create the `docs/assessments/` directory if it doesn't exist.

9. **Report to the user**: show the file path, the overall grade and its band, and the top 1-2 highest-leverage improvements. Do not dump the full document into chat.

## Grade bands

| Grade    | Band      | Meaning                                      |
| -------- | --------- | -------------------------------------------- |
| 9.0-10.0 | Excellent | Ship/adopt without reservation               |
| 7.0-8.9  | Solid     | Production-ready; minor polish               |
| 5.0-6.9  | Passable  | Usable but has real gaps; fix before scaling |
| 3.0-4.9  | Weak      | Significant problems; rework advised         |
| 0.0-2.9  | Broken    | Do not ship/adopt                            |

## Rubrics by target type

Weights within each rubric sum to 1.00.

### package

| Dimension                                                          | Weight |
| ------------------------------------------------------------------ | -----: |
| Correctness (tests pass, matches spec)                             |   0.25 |
| API design & ergonomics                                            |   0.15 |
| Test coverage & quality                                            |   0.20 |
| Documentation (README, examples, API docs)                         |   0.10 |
| Maintenance signals (release cadence, open issues, responsiveness) |   0.10 |
| Security & dependency health                                       |   0.20 |

### project

| Dimension                                   | Weight |
| ------------------------------------------- | -----: |
| Architecture clarity (boundaries, layering) |   0.20 |
| Code quality & consistency                  |   0.15 |
| Test coverage                               |   0.15 |
| CI/CD & automation                          |   0.10 |
| Documentation (CLAUDE.md, README, runbooks) |   0.10 |
| Security posture                            |   0.15 |
| Observability (logs, metrics, alerting)     |   0.15 |

### source-file

| Dimension                  | Weight |
| -------------------------- | -----: |
| Correctness                |   0.30 |
| Readability                |   0.20 |
| Testability                |   0.15 |
| Coupling & cohesion        |   0.15 |
| Performance considerations |   0.10 |
| Security                   |   0.10 |

### architecture-decision

| Dimension                           | Weight |
| ----------------------------------- | -----: |
| Problem framing                     |   0.20 |
| Solution fit                        |   0.25 |
| Alternatives considered             |   0.15 |
| Trade-offs made explicit            |   0.15 |
| Reversibility / migration path      |   0.15 |
| Operational impact (cost, ops load) |   0.10 |

### pull-request

| Dimension                            | Weight |
| ------------------------------------ | -----: |
| Scope focus (one thing, well-scoped) |   0.15 |
| Diff clarity                         |   0.15 |
| Test coverage of the change          |   0.25 |
| Risk & rollback plan                 |   0.20 |
| PR body quality (context, test plan) |   0.10 |
| CI signal                            |   0.15 |

### document

| Dimension                                    | Weight |
| -------------------------------------------- | -----: |
| Clarity                                      |   0.25 |
| Completeness                                 |   0.25 |
| Evidence / citations                         |   0.15 |
| Actionability                                |   0.20 |
| Maintenance hooks (owner, dates, versioning) |   0.15 |

## Document structure

```markdown
# <Target Title> — Assessment — <YYYY-MM-DD>

<One-line summary of what was assessed and why.>

**Target type:** <type>
**Overall grade: X.X / 10 — <Band>**

## Scope

What was included and excluded from this assessment, and which rubric was applied (built-in for `<type>`, or a user-provided custom rubric).

## Rubric & scores

| Dimension   |   Weight | Score | Weighted | Evidence               |
| ----------- | -------: | ----: | -------: | ---------------------- |
| ...         |     0.XX |  N/10 |     N.NN | <file:line, metric, …> |
| **Overall** | **1.00** |     — |  **X.X** | —                      |

## Dimension detail

### <Dimension 1> — N/10

Observations with evidence. End with a short "**To raise this score:**" line listing concrete changes that would move the score up.

### <Dimension 2> — N/10

...

## Highest-leverage improvements

Ranked by estimated grade lift. Each item lists the action, the affected dimension(s), and the estimated lift.

1. <Action> — <dimension(s)> — estimated lift: +X.X
2. <Action> — <dimension(s)> — estimated lift: +X.X

## Summary

<2-3 sentence verdict: overall grade in band context, the one dimension dragging the most, and the single recommended next action.>
```

## Rules

- Every score must be backed by evidence in the Evidence column. No gut-feel numbers. If no evidence can be produced, score 0 and say so.
- Use the built-in rubric weights exactly unless the user overrode them at invocation. Do not silently reweight.
- Classify target type before scoring. State the type in the output doc.
- Do not fix issues found. Report them in the Highest-leverage improvements section.
- Do not commit the assessment file. Leave it untracked for the user to review.
- Keep the document concise. Tables over prose where possible. No filler.
- Round the overall grade to 1 decimal. Round weighted-column values to 2 decimals.
- Never invent a target or expand scope beyond what was requested. If scope is unclear, ask.
- If the user asks for a re-assessment of a previously graded target, read the prior file in `docs/assessments/` and include a short "Delta vs <previous date>" line under the overall grade.
