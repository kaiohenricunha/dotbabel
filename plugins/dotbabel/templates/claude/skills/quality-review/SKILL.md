---
# dotbabel:generated projection=sha256:9fcd814e48c9839a25b35af08ede142f1452b0932b889061d92f3c20315812f1 source=skills/quality-review/SKILL.md — do not edit directly
allowed-tools: Read Grep Bash
argument-hint: "[fast|pr|deep] [base-ref]"
description: |
  Check changed code against the resolved dotbabel quality policy, then review semantic risks that tools cannot judge. Triggers on: "quality review", "quality check", "review code quality".
name: quality-review
---

# Quality review

Use this workflow for changed-code quality checks. Do not use it as a substitute for a focused security audit.

## Workflow

1. Run `dotbabel quality explain` before a policy-sensitive change. Use `--rule <id>` for one rule.
2. Run `dotbabel quality detect`. Resolve an ambiguous tool choice through `.dotbabel.json`; do not guess.
3. Run `dotbabel quality check --profile <profile> --base <base>`. Use `fast` during edits and `pr` before a pull request.
4. Review the changed code for the semantic rules listed by `quality explain`.
5. Report failures, warnings, unavailable capabilities, improvements, and policy-file changes.

Do not claim that an unsupported or unavailable result passed. Do not install a missing tool.

## Review duties

- Simplify control flow before you split code for a metric.
- Add behavioral tests for success, failure, and boundary behavior.
- Reject coverage padding and tests that only repeat implementation details.
- Review new suppressions for a narrow scope and an engineering reason.
- Review concurrency ownership, cancellation, error handling, unsafe types, assertions, and speculative abstractions.
- Prefer a legacy improvement over unrelated repository cleanup.

Read [references/policy.md](references/policy.md) when a baseline, exception, or unavailable result affects the verdict.
Read [references/languages.md](references/languages.md) for language-specific semantic review.
Read [references/ci.md](references/ci.md) when you configure CI or local attestation.
