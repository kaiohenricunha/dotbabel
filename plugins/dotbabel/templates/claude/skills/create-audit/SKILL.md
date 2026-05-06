---
id: create-audit
name: create-audit
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [review, documentation]
maturity: validated
description: >
  Create an evidence-based audit document and save it to docs/audits/.
  Triggers on: "audit", "review", "assessment".
argument-hint: "[subject]"
tools: Read, Grep, Glob, Bash, Write
model: opus
---

Create a structured audit document and save it to the project's `docs/audits/` directory.

Trigger: when the user asks for an audit, review, or assessment of any system, feature, data quality, process, or component. Also triggered directly via `/create-audit`.

Arguments: `$ARGUMENTS` — a description of what to audit (e.g. "data quality for user profiles", "API endpoint security", "deployment pipeline reliability").

## Steps

1. **Parse the audit subject** from `$ARGUMENTS`. If empty or vague, infer the subject from recent conversation context. If still unclear, ask the user what they want audited.

2. **Investigate the subject thoroughly.** Read relevant source files, configs, logs, test results, git history, and any external state (API responses, deployment status) needed to form an evidence-based assessment. Do not guess — verify.

3. **Generate the audit document** with this structure:

   ```markdown
   # <Audit Title> — <YYYY-MM-DD>

   <One-line summary of what was audited and why.>

   ## Scope

   What was included and excluded from this audit.

   ## Findings

   ### <Finding Category 1>

   | Item | Status | Details |
   | ---- | ------ | ------- |
   | ...  | ...    | ...     |

   <Narrative explanation of the findings with evidence (file paths, line numbers, metrics, command output).>

   ### <Finding Category 2>

   ...

   ## Issues

   | Severity | Issue | Location | Recommendation |
   | -------- | ----- | -------- | -------------- |
   | CRITICAL | ...   | ...      | ...            |
   | WARNING  | ...   | ...      | ...            |
   | INFO     | ...   | ...      | ...            |

   If no issues: "No issues found."

   ## Summary

   <2-3 sentence verdict. What's healthy, what needs attention, what's the recommended next action.>
   ```

4. **Generate a filename** in the format: `<topic-slug>-<YYYY-MM-DD>.md` (e.g. `data-quality-2026-04-05.md`, `api-security-2026-04-09.md`). Use lowercase kebab-case.

5. **Write the file** to `docs/audits/<filename>`. Create the `docs/audits/` directory if it doesn't exist.

6. **Report to the user**: show the file path and a brief summary of findings (critical/warning/info counts). Do not dump the full document into chat.

## Rules

- Every claim in the audit must be backed by evidence (a file read, command output, metric, or test result). No assumptions.
- Severity levels: **CRITICAL** = broken or actively harmful, **WARNING** = degraded or risky, **INFO** = improvement opportunity.
- Do not fix issues found. Report them. The user decides what to act on.
- Do not commit the audit file. Leave it as an untracked file for the user to review.
- Keep the document concise. Tables over prose where possible. No filler.
