---
id: create-inspection
name: create-inspection
type: command
version: 1.0.0
domain: [devex]
platform: [none]
task: [debugging, documentation]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-04-17
description: >
  Investigate a specific problem and surface viable fix paths with trade-offs, saved to docs/inspections/. Use when the user needs to understand *how* to fix something before committing to an approach. Sits between /create-audit (find problems) and /fix-with-evidence (implement the fix).
argument-hint: "[problem or subject]"
model: sonnet
---

Investigate a specific problem and produce a structured fix-path document saved to the project's `docs/inspections/` directory.

Trigger: when the user asks "how should I fix X", "what are my options for Y", "investigate Z before I touch it", or triggers directly via `/create-inspection`. Also useful before running `/fix-with-evidence` to pre-evaluate approaches.

Arguments: `$ARGUMENTS` — a description of the problem or subject to inspect (e.g. "auth token refresh race condition", "N+1 queries in /api/dashboard", "flaky E2E login test"). Required — if empty, ask the user.

## Purpose

`/create-inspection` is **not** an audit (it doesn't enumerate all issues) and **not** a fix (it doesn't implement anything). Its output is a **decision document**: here is what is broken, here are the viable paths to fix it, here is a recommended approach with rationale.

## Steps

1. **Parse the subject** from `$ARGUMENTS`. If empty or vague, ask the user to describe the symptom or problem.

2. **Locate the problem in the codebase.** Use `Grep`, `Glob`, and `Read` to find the relevant files, functions, configs, and tests. Do not guess — verify every claim with a `file:line` citation.

3. **Diagnose root cause.** Read enough code to understand _why_ the problem occurs, not just _where_. If there are tests, run them to observe the failure. If the issue is behavioural (performance, flakiness), read logs or run diagnostic commands.

4. **Generate at least 2 fix options.** For each option:
   - Describe the approach concisely
   - List the files/components touched
   - State the trade-offs (complexity, blast radius, test surface, reversibility)
   - Estimate effort: `low` (< 1 hr), `medium` (1–4 hrs), `high` (> 4 hrs)
   - Assess risk: `low`, `medium`, `high`

5. **Pick a recommended option** and explain why it best balances correctness, risk, and effort. If options are genuinely tied, say so and flag the deciding factor for the user.

6. **Generate the inspection document** with this structure:

   ```markdown
   # Inspection: <Subject> — <YYYY-MM-DD>

   <One-sentence description of the problem and its impact.>

   ## Root Cause

   <Evidence-backed explanation of why the problem occurs. Include file:line citations.>

   ## Scope

   Files and components relevant to this problem.

   | File / Component | Role in the problem |
   | ---------------- | ------------------- |
   | ...              | ...                 |

   ## Fix Options

   ### Option 1: <Name>

   **Approach:** <description>
   **Files touched:** <list>
   **Effort:** low | medium | high
   **Risk:** low | medium | high
   **Trade-offs:** <pros and cons>

   ### Option 2: <Name>

   ...

   ## Recommendation

   **Use Option N: <Name>**

   <2-3 sentences explaining why this option is best for the current situation.
   Call out any assumptions (e.g. "assumes test coverage exists for the path").>

   ## Next Step

   Run `/fix-with-evidence <subject>` using the recommended option,
   or proceed manually using the approach above.
   ```

7. **Generate a filename** in the format: `<topic-slug>-<YYYY-MM-DD>.md` (e.g. `auth-refresh-race-2026-04-14.md`). Use lowercase kebab-case.

8. **Write the file** to `docs/inspections/<filename>`. Create the `docs/inspections/` directory if it doesn't exist.

9. **Report to the user**: show the file path, the root cause in one sentence, and the recommended option. Do not dump the full document into chat.

## Rules

- Every root-cause claim must be backed by a `file:line` citation or command output. No assumptions.
- Always provide at least 2 distinct fix options. Single-option "inspections" are just instructions.
- Never implement a fix. Surface options and recommend. The user decides.
- Do not commit the inspection file. Leave it untracked for the user to review.
- If the problem cannot be localized (e.g. no repro, insufficient context), state that clearly and list what additional information is needed rather than producing a speculative document.
- Keep the document concise. Tables over prose where possible. No filler.
