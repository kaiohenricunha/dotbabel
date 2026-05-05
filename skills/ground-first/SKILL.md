---
id: ground-first
name: ground-first
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [debugging, review]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-04-17
description: >
  Produce a code-grounded analysis before any edit is proposed.
  Triggers on: "analyze", "understand behavior", "how does this work".
argument-hint: "[subject]"
tools: Read, Grep, Glob, Bash
model: opus
---

Produce a code-grounded analysis of a subject before any edits are proposed.

Trigger: when the user asks for a fix, change, or investigation on non-trivial code and has not yet confirmed you understand current behavior. Also triggered directly via `/ground-first`.

Arguments: `$ARGUMENTS` — a description of what to analyze (e.g. "auth token refresh race condition", "why ingest job retries forever", "issue #140").

## Steps

1. **Parse the subject** from `$ARGUMENTS`. If empty or vague, infer from recent conversation. If still unclear, ask the user what they want analyzed.

2. **Locate the relevant code.** Use these tools, in this order:
   - `Glob` to find candidate files by name pattern
   - `Grep` to find candidate files by symbol/string
   - `Read` every candidate file that survives the first two steps. Read the actual file — do not infer from its name.

3. **Produce the analysis** in this format:

   ```markdown
   ## Subject

   <one-line restatement of the subject>

   ## Current behavior

   - <claim>. `path/to/file.go:42`
   - <claim>. `path/to/other.ts:120–140`

   ## Relevant entry points

   - `path/to/handler.go:15` — `HandleIngest()`
   - `path/to/config.yaml:8` — `retries: 3`

   ## What I do not yet know

   - <specific unknown, e.g. "whether the retry limit is overridden at runtime">
   - <specific unknown>

   ## Proposed next steps (not yet actioned)

   1. <step>
   2. <step>
   ```

4. **STOP.** Do not call `Edit`, `Write`, or any other mutation tool. Wait for the user to confirm the analysis matches reality or to correct it.

## Rules

- Every claim must cite a `file:line` or `file:line–line` reference from a file you actually read in this session.
- If you cannot find a file that supports a claim, list the claim under "What I do not yet know" instead of asserting it.
- Do not propose edits. Do not run tests. Do not make changes. This command is read-only by design.
- Keep the analysis under ~30 lines. Cite more, narrate less.
- If the subject turns out to be trivial (e.g., a typo fix), say so and hand control back — don't pad.
