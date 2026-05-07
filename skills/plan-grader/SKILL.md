---
id: plan-grader
name: plan-grader
type: skill
version: 2.0.0
domain: [devex]
platform: [none]
task: [review, documentation]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-07
updated: 2026-05-07
description: >
  Grade implementation plans on a 0-10 scale without mutating the workspace. Accepts plan files,
  quoted inline plans, or best-effort latest-plan discovery for Claude, Codex, Copilot, and Gemini.
argument-hint: '[--json] [--blind] <plan-path | file:<path> | text:"plan" | "plan" | latest <agent> plan>'
tools: Read, Grep, Glob, Bash
model: opus
---

Grade an implementation plan on a 0-10 scale using the plan-grader rubric. This skill is
content-only: inspect, score, explain, and produce a paste-back prompt. Do not edit files, run
formatters, commit changes, or implement the plan being graded.

Use when the user asks to grade, score, review, evaluate, improve, or calibrate a plan, especially
plans produced by Claude Code, Codex, GitHub Copilot, Gemini CLI, or similar agentic CLIs. Also
trigger directly via `/plan-grader`.

## Inputs

`$ARGUMENTS` may be any of:

- `<path>` or `file:<path>`: read the plan from a local Markdown/text file.
- `"..."` or `text:"..."`: grade the quoted inline plan text exactly as provided.
- `latest claude plan`, `latest codex plan`, `latest copilot plan`, or `latest gemini plan`:
  discover candidate plan/session files using `references/plan-discovery.md`.
- Optional `--json`: emit only the structured JSON object described below.
- Optional `--blind`: strip source-agent attribution before scoring. Keep explicit harness context
  that affects safety, validation, or repo fit.

If the input is ambiguous, ask for the plan path or paste. Do not guess a plan from unrelated chat.

## Reference Order

Before grading, read these references:

1. `references/rubric.md`
2. `references/context-resolution.md`
3. `references/plan-discovery.md` when discovery, imports, symlinks, oversized content, or
   transcript extraction are involved
4. `references/agent-formats.md` when the source agent is known or a paste-back prompt is needed
5. Relevant examples in `references/calibration-plans/`

## Workflow

1. Parse flags and input mode.
   - `--json` changes output format only.
   - `--blind` removes agent identity from the plan before scoring.
   - `file:` forces file mode.
   - `text:` forces inline text mode.
   - Top-level quoted text is inline plan text, not a path.

2. Resolve the plan text.
   - For file inputs, read the target file.
   - For inline text, use the supplied text verbatim.
   - For `latest <agent> plan`, follow `references/plan-discovery.md`.
   - If discovery returns multiple candidates, present the top three most recent candidate paths and
     ask the user to choose.
   - Refuse oversized inputs that cannot fit the context budget. Do not silently truncate.

3. Resolve intent sources.
   - Treat files mentioned by the plan as intent evidence, especially `@roadmap.md`,
     `@spec.md`, `file:docs/foo.md`, or explicit local paths.
   - Resolve transitive `@` imports to the depth documented in `references/plan-discovery.md`.
   - If a referenced intent file is unreadable, record the missing file and lower confidence.
   - If a readable intent file contradicts the plan, apply the relevant rubric cap.

4. Resolve harness context.
   - Read project-level `AGENTS.md` first as the cross-agent baseline when present.
   - Layer agent-specific project overrides: `CLAUDE.md`, `GEMINI.md`,
     `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, and
     `AGENTS.override.md`.
   - Consider user/global harness files only as preference context. They cannot weaken repo-local
     safety, validation, protected-path, release, or CI rules.
   - Detect whether the plan violates configured harnesses or protected gates.

5. Calibrate before scoring.
   - Read at least the two calibration anchors closest to the expected score band.
   - Use the anchors to normalize severity and avoid over-rewarding format polish.

6. Score the plan.
   - Score each rubric dimension from 0 to 10.
   - Compute the weighted score using rubric version `2.0.0`.
   - Apply caps, then auto-reject rules, then floor at 0, then round to one decimal.
   - Record `confidence` as `high`, `medium`, or `low`.

7. Produce output.
   - Default: concise human-readable report with score, verdict, dimension table, caps, blocking
     gaps, non-blocking polish, and a paste-back prompt.
   - `--json`: emit only valid JSON with exactly these top-level keys:
     `rubric_version`, `score`, `verdict`, `confidence`, `dimensions`, `caps_fired`,
     `blocking_gaps`, `non_blocking`, `paste_back_prompt`.

## Human Output Shape

```markdown
Plan grade: X.X / 10
Verdict: <approve | approve with minor changes | revise before execution | reject>
Confidence: <high | medium | low>

<One short paragraph explaining the main reason for the grade.>

| Dimension | Weight | Score | Reasoning              |
| --------- | -----: | ----: | ---------------------- |
| ...       |   0.XX |  N/10 | Evidence-backed reason |

Caps fired:

- <cap id or "None">

Blocking gaps:

1. <gap>

Non-blocking improvements:

- <improvement>

Paste-back prompt:
<agent-aware prompt from references/agent-formats.md>
```

## JSON Output Shape

```json
{
  "rubric_version": "2.0.0",
  "score": 8.4,
  "verdict": "approve with minor changes",
  "confidence": "high",
  "dimensions": [
    {
      "name": "Goal and scope clarity",
      "weight": 0.15,
      "score": 9,
      "reasoning": "The plan defines the output contract and non-goals.",
      "evidence": ["plan.md:12"]
    }
  ],
  "caps_fired": [],
  "blocking_gaps": [],
  "non_blocking": ["Add one explicit smoke test for malformed input."],
  "paste_back_prompt": "Revise the plan to add one malformed-input smoke test..."
}
```

## Rules

- Do not mutate files or implement the plan being graded.
- Do not score from vibes. Cite concrete evidence from the plan, intent files, harness files,
  repo paths, tests, CI, or explicit missing evidence.
- Mention when the grade is based on incomplete transcript extraction rather than a real plan file.
- Auto-reject dangerous caps even when the weighted score is high.
- Keep all weights from `references/rubric.md` exactly. Do not silently reweight.
- For `--blind`, do not penalize or reward the plan because it came from Claude, Codex, Copilot, or
  Gemini. Grade the content and repo fit.
- If a plan references images or diagrams, do not OCR them. Mark that portion partially ungradable.
- If a plan would touch protected paths, verify it includes the required Spec ID or No-spec
  rationale in the PR plan.
- Always include a paste-back prompt unless the user explicitly asks for only the numeric grade.
