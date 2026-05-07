# Calibration Anchor: Excellent Plan

Documented score: `9.5`
Rubric version: `2.0.0`
Expected verdict: `approve`
Expected confidence: `high`

## Example Plan

Implement a content-only `plan-grader` skill under `skills/plan-grader/`. It accepts an explicit
plan path, quoted inline text, or `latest <agent> plan` discovery for Claude, Codex, Copilot, and
Gemini. The skill reads `AGENTS.md` as the cross-agent baseline, then layers `CLAUDE.md`,
`GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, and
`AGENTS.override.md` when present.

Affected source files:

- `skills/plan-grader/SKILL.md`
- `skills/plan-grader/CHANGELOG.md`
- `skills/plan-grader/references/rubric.md`
- `skills/plan-grader/references/context-resolution.md`
- `skills/plan-grader/references/plan-discovery.md`
- `skills/plan-grader/references/agent-formats.md`
- `skills/plan-grader/references/calibration-plans/*.md`

Generated artifacts:

- `plugins/dotbabel/templates/claude/skills/plan-grader/**`
- `plugins/dotbabel/templates/claude/skills-manifest.json`
- `index/artifacts.json`
- `index/by-type.json`
- `index/by-facet.json`

Implementation order:

1. Add source skill and references.
2. Add calibration anchors covering 9.5, 7.5, 5.5, and 3.5 bands.
3. Regenerate templates with `npm run build-plugin`.
4. Regenerate index with `node plugins/dotbabel/bin/dotbabel-index.mjs`.
5. Validate with `npm run build-plugin -- --check`, `node plugins/dotbabel/bin/dotbabel-index.mjs
--check`, `node plugins/dotbabel/bin/dotbabel-show.mjs plan-grader --type skill`,
   `npx dotbabel-validate-skills`, `npx dotbabel-check-spec-coverage`, `npm run lint`, and
   `npm run dogfood`.

PR body will include `## Spec ID` with `dotbabel-core` because generated protected template paths
are touched.

## Dimension Reasoning

| Dimension                                     | Score | Reasoning                                                                   |
| --------------------------------------------- | ----: | --------------------------------------------------------------------------- |
| Goal and scope clarity                        |    10 | Clear input contract, output contract, non-mutating posture, and non-goals. |
| Intent-source alignment                       |     9 | Explicitly handles mentioned intent files and harness files.                |
| Repo grounding and affected-surface inventory |    10 | Lists source and generated artifacts plus existing validation commands.     |
| Execution completeness and ordering           |     9 | Ordered steps are executable; no major unresolved decisions.                |
| Harness compatibility                         |    10 | Handles protected path Spec ID, generated artifacts, and harness layering.  |
| Validation and test plan                      |     9 | Concrete commands plus behavioral fixture expectations.                     |
| Risk handling and handoff quality             |     9 | Covers nondeterminism, discovery uncertainty, and gate violations.          |

Caps fired: none.

Expected result: `9.5 / 10`.
