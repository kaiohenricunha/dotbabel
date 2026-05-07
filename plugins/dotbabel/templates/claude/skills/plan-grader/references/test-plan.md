# Plan-Grader Validation Checklist

This skill is content-only, so validation focuses on instruction quality, generated-template
integrity, and deterministic output shape.

## Repository Validation

Run after adding or changing the skill:

```bash
npm run build-plugin -- --check
node plugins/dotbabel/bin/dotbabel-index.mjs --check
node plugins/dotbabel/bin/dotbabel-show.mjs plan-grader --type skill
npx dotbabel-validate-skills
npx dotbabel-check-spec-coverage
npm run lint
npm run dogfood
```

The regenerated artifacts must be committed alongside source changes:

- `plugins/dotbabel/templates/claude/skills/plan-grader/**`
- `plugins/dotbabel/templates/claude/skills-manifest.json`
- `index/artifacts.json`
- `index/by-type.json`
- `index/by-facet.json`

## Behavioral Fixture Tests

Use these as smoke tests when invoking the skill manually or from agent harnesses.

1. Calibration anchors: re-grade every file under `references/calibration-plans/`. Each score must
   land within +/- 0.5 of the documented score and must report rubric version `2.0.0`.
2. Cross-agent fairness: grade the same logical plan expressed in Claude, Codex, Copilot, and Gemini
   native phrasing. Scores must fall within a +/- 0.5 band.
3. Blind self-grade: grade this skill's own implementation plan with `--blind`. Score must be at
   least 7.0 and must not mention source-agent bias.
4. Shape stability: run the grader twice on the same input. `caps_fired[]` and cited evidence paths
   must be identical. Numeric score may drift slightly.
5. JSON schema: `--json` output must include exactly:
   `rubric_version`, `score`, `verdict`, `confidence`, `dimensions`, `caps_fired`,
   `blocking_gaps`, `non_blocking`, `paste_back_prompt`.
6. Discovery edge cases:
   - transitive `@` imports stop at depth 2;
   - oversized plans refuse instead of truncating;
   - symlink inside project root is allowed;
   - symlink escaping project root is refused;
   - embedded image dependency is marked partially ungradable and is not OCRed.
7. Agent discovery:
   - Claude plan file from `plansDirectory` or `~/.claude/plans`;
   - Gemini plan file from `general.plan.directory` or `~/.gemini/tmp/**/plans/*.md`;
   - Copilot exported Markdown session;
   - Codex rollout JSONL with a clear plan block.
8. Intent-source effect: a plan that ignores `@roadmap.md` must score lower or fire
   `ignored-intent-file`.
9. Harness violation: a plan touching protected paths without Spec ID or No-spec rationale must fire
   a gate or harness cap.
10. Auto-reject: a plan that bypasses CI/release gates or risks data loss must return
    `verdict: reject`.
