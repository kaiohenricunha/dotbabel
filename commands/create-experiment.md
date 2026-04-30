---
id: create-experiment
name: create-experiment
type: command
version: 1.0.0
domain: [devex]
platform: [none]
task: [exploration, prototyping, documentation]
maturity: validated
owner: "@kaiohenricunha"
created: 2026-04-29
updated: 2026-04-29
description: >
  Run a scoped, local-only experiment to try things out before committing to a spec or roadmap, and save the report to docs/experiments/. Use when the user is exploring options, comparing libraries, validating assumptions, or prototyping an approach. Sits before /create-spec (which is heavier and design-oriented).
argument-hint: "[topic or hypothesis]"
model: sonnet
---

Run a scoped, local-only experiment and produce a structured report saved to the project's `docs/experiments/` directory.

Trigger: when the user asks "let's try X", "I want to compare A vs B", "can we prototype Y", "explore Z before we commit", or invokes `/create-experiment` directly. Use this skill **before** `/create-spec` (which is for design docs, not exploratory probes) and **after** plain shell tinkering becomes too messy to track.

Arguments: `$ARGUMENTS` — a topic or hypothesis (e.g. "ripgrep vs grep on this repo", "switch from pnpm to bun", "does Postgres LISTEN/NOTIFY scale to N clients"). Required — if empty, ask the user what they want to explore.

## Purpose

`/create-experiment` is **not** a spec (no formal design), **not** an audit (it doesn't enumerate issues), **not** a fix (it doesn't ship anything). It is a **decision-grade probe**: refine a hypothesis, run it locally, capture results — including negative ones — and recommend a next move.

The output is a dated markdown file under `docs/experiments/` plus a sandbox directory containing the runnable artifacts. Both are left untracked for the user to review.

## Phases

### Phase 0 — Refine the goal (interactive, blocking)

Before running anything, ask the user up to 5 short questions. Skip any already answered in `$ARGUMENTS` or recent context. Do not infer answers — ask.

1. **What are you trying to learn?** — one-sentence hypothesis.
2. **What does "it worked" look like?** — concrete, observable signal (a benchmark number, a working prototype, a config that boots, a passing test).
3. **What's out of scope?** — what should NOT be touched.
4. **Time-box** — sketch (≤30 min), half-day (≤4 hr), or full-day (≤8 hr).
5. **Environment** — repo / language / runtime, plus any external services that need stubbing or mocking.

Echo the refined goal back as a paragraph + bulleted success criteria. **Wait for explicit user sign-off before continuing.** Do not proceed to Phase 1 until the user confirms.

### Phase 1 — Plan the experiment

- Propose 1–3 approaches to try. Each is a distinct path to the same hypothesis.
- For each approach, sketch: what gets installed, what runs, what's measured.
- Pick the sandbox target:
  - **Default:** a fresh git worktree at `.claude/worktrees/experiment-<slug>/` branched from the latest `origin/main` (per the dotclaude *Worktree discipline* rule). Run `git fetch origin main` first.
  - **Fallback:** `~/experiments/<slug>/` if there is no enclosing git repo.
- Show this plan to the user and get a final go-ahead before touching the system.

### Phase 2 — Set up the environment

Execute setup commands in the sandbox. **Capture every command and its full output** — this is the reproducibility ledger and goes verbatim into the report. Examples:

- `git worktree add .claude/worktrees/experiment-<slug> -b experiment/<slug> origin/main`
- `npm i <pkg>` / `pnpm add <pkg>` / `bun add <pkg>`
- `python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
- `docker compose up -d`
- `cargo new <name> && cd <name>`

If a setup step fails, document the failure, attempt **one** recovery (e.g. install a missing system dep), and proceed only if it succeeds. Do not silently swallow errors.

### Phase 3 — Execute the approaches

For each approach:

- Save code/config under `experiments/<slug>/<approach>/` inside the sandbox.
- Run the approach. Capture stdout/stderr — keep at least the **last 10 lines** of every non-trivial command (per the dotclaude *Test Plan Verification* rule).
- Evaluate against the success criteria from Phase 0. Record the result as **PASS**, **PARTIAL**, or **FAIL**.
- If an approach surfaces a blocker that invalidates the hypothesis itself, stop and surface that to the user before continuing — they may want to refine the goal.

### Phase 4 — Compare & recommend

Build a comparison table that maps each approach against the agreed success criteria. Pick a recommendation, **or** explicitly say "none of these — here's why and what to try next." A clean negative result is a complete experiment.

### Phase 5 — Write the report

Generate a filename: `<topic-slug>-<YYYY-MM-DD>.md` in lowercase kebab-case (e.g. `ripgrep-vs-grep-2026-04-29.md`). Create `docs/experiments/` if it doesn't exist. Use this structure:

```markdown
# Experiment: <Topic> — <YYYY-MM-DD>

<One-sentence hypothesis.>

## Goal

<2–3 sentences. What we're learning and why this experiment was run now.>

## Success Criteria

- <observable signal 1>
- <observable signal 2>

## Environment Setup

Sandbox: `<absolute path to worktree or ~/experiments/<slug>/>`

```bash
<exact commands run, in order>
```

<key output snippets — last 10 lines per command if non-trivial>

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

### Approach 2: …

## Comparison

| Approach | Result | Effort | Risk | Criterion 1 | Criterion 2 |
| -------- | ------ | ------ | ---- | ----------- | ----------- |
| ...      | ...    | ...    | ...  | ...         | ...         |

## Recommendation

**<Adopt Approach N | Iterate further | Abandon>**

<2–3 sentences. Why this conclusion best matches the success criteria. Call out
assumptions or unresolved questions.>

## Next Step

- Promote to `/create-spec <topic>` to formalize the chosen approach, OR
- Run `/fix-with-evidence <topic>` to implement directly, OR
- Re-run `/create-experiment` with a refined hypothesis, OR
- Drop it — this document is the negative-result record.

## Sandbox Cleanup

```bash
git worktree remove .claude/worktrees/experiment-<slug>   # or
rm -rf ~/experiments/<slug>
```
```

### Phase 6 — Report back

Show the user: the doc path, the recommendation in one sentence, and the sandbox path so they can re-enter it. **Do not dump the full document into chat.**

## Rules

- Refine the goal **before** running anything. No code executes until success criteria are agreed and the user signs off.
- All work runs **locally**. No production endpoints, no cloud writes, no real auth tokens, no shared infrastructure. If the experiment needs an external service, mock it or use a disposable test account.
- Environment setup is part of the experiment — every install/config/boot command must appear in the report. Reproducibility is the bar.
- Capture failed approaches too. Negative results are valuable signal and **must** be in the report.
- Cite `file:line` for any code referenced. Paste the last 10 lines of any command output claimed.
- Default sandbox is a git worktree at `.claude/worktrees/experiment-<slug>/`. Fall back to `~/experiments/<slug>/` only when there is no enclosing git repo.
- Do not commit the experiment doc or the sandbox. Leave both untracked for the user.
- Do not install global tools (`apt`, `brew`, `npm i -g`) without explicit user approval during Phase 1.
- Tables and code blocks over prose. No filler.
- An experiment is **done when success criteria are evaluated** — not when "everything works." A clean failure is a finished experiment.
