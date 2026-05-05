---
id: create-experiment
name: create-experiment
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [review, documentation]
maturity: validated
owner: "@kaiohenricunha"
created: 2026-04-29
updated: 2026-04-30
description: >
  Run a scoped, local-only experiment and save the report to docs/experiments/.
  Triggers on: "let's try", "compare A vs B", "prototype", "explore".
argument-hint: "[topic or hypothesis]"
tools: Read, Grep, Glob, Bash, Write
model: sonnet
---

Run a scoped, local-only experiment and produce a structured report saved to the project's `docs/experiments/` directory.

Trigger: when the user asks "let's try X", "I want to compare A vs B", "can we prototype Y", "explore Z before we commit", or invokes `/create-experiment` directly. Use this skill **before** `/spec` (which is for design docs, not exploratory probes) and **after** plain shell tinkering becomes too messy to track.

Arguments: `$ARGUMENTS` — a topic or hypothesis (e.g. "ripgrep vs grep on this repo", "switch from pnpm to bun", "does Postgres LISTEN/NOTIFY scale to N clients"). Required — if empty, ask the user what they want to explore.

## Purpose

`/create-experiment` is **not** a spec (no formal design), **not** an audit (it doesn't enumerate issues), **not** a fix (it doesn't ship anything). It is a **decision-grade probe**: refine a hypothesis, run it locally, capture results — including negative ones — and recommend a next move.

The output is a dated markdown file under `docs/experiments/` plus a sandbox directory containing the runnable artifacts. Both are left untracked for the user to review.

## Steps

### Step 0 — Refine the goal (interactive, blocking)

If `$ARGUMENTS` already covers hypothesis + observable success signal, echo the refined goal back as a paragraph + bulleted success criteria and **wait for user sign-off** before proceeding. Skip questions already answered in `$ARGUMENTS` or recent context.

Otherwise, ask up to 4 short questions:

1. **What are you trying to learn?** — one-sentence hypothesis.
2. **What does "it worked" look like?** — concrete, observable signal (a benchmark number, a working prototype, a config that boots, a passing test).
3. **What's out of scope?** — what should NOT be touched.
4. **Time-box** — sketch (≤30 min), half-day (≤4 hr), or full-day (≤8 hr).

Echo the refined goal back as a paragraph + bulleted success criteria. **Wait for explicit user sign-off before continuing.** Do not proceed to Step 1 until the user confirms.

### Step 1 — Plan the experiment

- Propose 1–3 approaches to try. Each is a distinct path to the same hypothesis.
- For each approach, sketch: what gets installed, what runs, what's measured.
- Pick the sandbox target:
  - **Default:** a fresh git worktree at `.claude/worktrees/experiment-<slug>/` branched from the latest `origin/main`. Run `git fetch origin main` first.
  - **Fallback:** `~/experiments/<slug>/` if there is no enclosing git repo.
- Show this plan to the user and get a final go-ahead before touching the system.

### Step 2 — Set up the environment

Execute setup commands in the sandbox. **Capture every command and its output** as the reproducibility ledger — redact any tokens or credentials before including output in the report. Examples:

- `git worktree add .claude/worktrees/experiment-<slug> -b experiment/<slug> origin/main`
- `npm i <pkg>` / `pnpm add <pkg>` / `bun add <pkg>`
- `python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
- `docker compose up -d`
- `cargo new <name> && cd <name>`

If a setup step fails, document the failure, attempt **one** recovery (e.g. install a missing system dep), and proceed only if it succeeds. Do not silently swallow errors.

### Step 3 — Execute the approaches

Approaches are independent by default — execute concurrently when possible (parallel tool calls or background jobs with per-approach log files). Fall back to serial execution only when one approach depends on another's artifact.

For each approach:

- Save code/config under `experiments/<slug>/<approach>/` inside the sandbox.
- Run the approach. For measurement commands and any failing command, capture full output — at minimum the last 10 lines.
- Evaluate against the success criteria from Step 0. Record the result as **PASS**, **PARTIAL**, or **FAIL**.
- If an approach surfaces a blocker that invalidates the hypothesis itself, stop and surface that to the user before continuing — they may want to refine the goal.

### Step 4 — Compare & recommend

Build a comparison table that maps each approach against the agreed success criteria. Pick a recommendation, **or** explicitly say "none of these — here's why and what to try next." A clean negative result is a complete experiment.

### Step 5 — Write the report

Generate a filename: `<topic-slug>-<YYYY-MM-DD>.md` in lowercase kebab-case (e.g. `ripgrep-vs-grep-2026-04-29.md`). Create `docs/experiments/` if it doesn't exist. Use this structure:

````markdown
# Experiment: <Topic> — <YYYY-MM-DD>

<One-sentence hypothesis.>

## Goal

<2–3 sentences. What we're learning and why this experiment was run now.>

## Success Criteria

- <observable signal 1>
- <observable signal 2>

## Environment Setup

Sandbox: `<absolute path chosen in Step 1>`

```bash
<exact commands run, in order>
```

<output snippets for any measurement or failing command — last 10 lines minimum>

## Approaches Tried

### Approach 1: <Name>

- **Idea:** <one line>
- **Code/config:** `<path-in-sandbox>`
- **Commands:**

  ```bash
  <commands>
  ```

- **Result:** PASS | PARTIAL | FAIL — <observed signal vs criterion>
- **Notes:** <gotchas, surprises, dead-ends>

<!-- Add sections for each approach tried; omit if only one approach was attempted -->

## Comparison

| Approach | Result | <Criterion 1> | <Criterion 2> | Effort |
| -------- | ------ | ------------- | ------------- | ------ |
| ...      | ...    | ...           | ...           | ...    |

## Recommendation

**<Adopt Approach N | Iterate further | Abandon>**

<2–3 sentences. Why this conclusion best matches the success criteria. Call out
assumptions or unresolved questions.>

## Next Step

- Promote to `/spec <topic>` to formalize the chosen approach, OR
- Run `/fix-with-evidence <topic>` to implement directly, OR
- Re-run `/create-experiment` with a refined hypothesis, OR
- Drop it — this document is the negative-result record.

## Sandbox Cleanup

```bash
git worktree remove .claude/worktrees/experiment-<slug>   # or
rm -rf ~/experiments/<slug>
```
````

### Step 6 — Report back

Reply with: doc path, one-sentence recommendation, and sandbox path. **Do not paste the full document into chat.**

## Rules

- All work runs **locally**. No production endpoints, no cloud writes, no real auth tokens, no shared infrastructure. If the experiment needs an external service, mock it or use a disposable test account.
- Environment setup is part of the experiment — every install/config/boot command must appear in the report. Reproducibility is the bar.
- Capture failed approaches too. Negative results are valuable signal and **must** be in the report.
- Do not commit the experiment doc or the sandbox. Leave both untracked for the user.
- Do not install global tools (`apt`, `brew`, `npm i -g`) without explicit user approval during Step 1.
- Tables and code blocks over prose. No filler.
- An experiment is **done when success criteria are evaluated** — not when "everything works." A clean failure is a finished experiment.
