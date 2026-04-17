---
id: validate-spec
name: validate-spec
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [review, testing]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-04-17
description: >
  Audit an already-implemented spec against the codebase. Walks each constraint
  (ARCH-N, PERF-N, KD-N, etc.) and acceptance criterion, grounds findings in
  file:line evidence, runs the spec.json acceptance_commands, and writes a
  single audit doc to docs/audits/. Use whenever the user asks to "validate a
  spec", "audit a spec", "check if spec is implemented", "verify the spec is
  done", "is this spec really done", or otherwise wants closure on spec-driven
  work. Read-only against the spec — produces an audit, never modifies the
  spec itself.
argument-hint: "[spec-id] [--no-run]"
effort: max
model: sonnet
---

# Validate Spec — Implementation Audit

Audit an implemented `/spec`-format spec against the codebase. Walk every tagged
constraint, ground each one in file:line evidence, execute the acceptance
commands, and emit a single audit document. The spec itself is never modified —
the audit doc is the only artifact this skill writes.

This skill is the closing-the-loop partner for `/spec`. `/spec` builds the
specification; `validate-spec` proves whether it actually got built.

## Arguments

- `$0` — spec id (the directory name under `docs/specs/`). If not provided, list candidate spec ids found under `docs/specs/` and ask the user.
- `--no-run` — skip Phase 4 (acceptance command execution). Useful for fast structural+evidence audits when tests are slow or require external services.

## Workflow Overview

Five phases, each gated. Do not skip ahead. If a phase fails fatally (e.g. spec
not found, wrong format), stop with a clear message — partial audits mislead.

The reasoning behind the structure: a spec is a set of _claims_ (constraints,
acceptance criteria, key decisions). An audit checks each claim against
_evidence_ (code, tests, runtime behavior). If you skip phases, you're guessing,
not auditing.

---

### Phase 1 — Locate & Validate Format

1. **Resolve spec id.** Use `$0` if given. Otherwise list directories under `docs/specs/` (search the project root walking up from cwd) and ask the user which one to validate.

2. **Locate the spec directory.** Look for `docs/specs/<spec-id>/` starting from cwd, walking up to find the project root (the directory containing `docs/specs/`).

3. **Confirm the multi-file `/spec` layout.** Required files:
   - `spec.json`
   - `README.md`
   - `spec/1-problem-motivation.md`
   - `spec/2-scope.md`
   - `spec/3-high-level-architecture.md`
   - `spec/4-data-flow-components.md`
   - `spec/5-interfaces-apis.md`
   - `spec/6-implementation-plan.md`
   - `spec/7-non-functional-requirements.md`
   - `spec/8-risks-alternatives.md`
   - `research/sources.md`

   If any are missing, **abort** with:

   > This skill validates only the structured `/spec` format (8 sections + spec.json). The directory `<path>` is missing: `<list>`. For ad-hoc or single-file specs, run `/create-audit` with the spec file as input instead.

4. **Read everything into context.** `spec.json`, `README.md`, all 8 section files, `research/sources.md`, and `current-state/analysis.md` if present (brownfield).

---

### Phase 2 — Structural & Metadata Audit

Verify the spec itself is well-formed before going code-hunting. Findings here
are **INFO** unless they break downstream phases.

1. **`spec.json` schema:**
   - Required fields present and non-empty: `id`, `title`, `status`, `owners`, `linked_paths`, `acceptance_commands`, `depends_on_specs`, `active_prs`.
   - `id` matches the directory name.
   - `status` is one of: `drafting`, `review`, `approved`, `implementing`, `done`, `superseded`.
   - `linked_paths`, `acceptance_commands`, `depends_on_specs`, `active_prs` are arrays (may be empty for the latter two).

2. **`linked_paths` resolution.** Each entry is a glob. For each, expand via `git ls-files` (or filesystem walk if not a git repo) and confirm at least one match exists. List unresolved globs as **WARNING**.

3. **`depends_on_specs` resolution.** Each entry must point to another `docs/specs/<dep>/spec.json` that exists. Missing dependencies are **WARNING**.

4. **README consistency.** Parse the status table in `README.md`. For each row, compare the marker (`[ ] empty`, `[~] in-progress`, `[x] done`) against the matching `spec/<n>-*.md` file. A `[x] done` row whose section file is empty or scaffold-only is **INFO** (doc drift, not blocking).

5. **DOC-N round-trip.** Grep `research/sources.md` for `\bDOC-\d+\b` to build the catalog. Then grep all section files for `\bDOC-\d+\b` references. Flag both directions:
   - `DOC-N` referenced in a section but not defined in `sources.md` → **WARNING**.
   - `DOC-N` defined in `sources.md` but never cited → **INFO**.

---

### Phase 3 — Constraint Evidence Audit

This is the audit's substance. The spec makes claims via tagged constraints; this
phase checks whether the codebase actually delivers each one. The discipline is
the same as `/ground-first`: every verdict cites `file:line`, never "probably"
or "should be".

1. **Build the constraint inventory.** Grep all section files for the pattern `\b(ARCH|IMPL|TEST|PERF|REL|OPS|SEC|KD|R|A)-\d+\b`. For each match, record:
   - the constraint id
   - the section it's defined in (where the row introduces it, not just mentions it)
   - the constraint text (the row content for table-defined constraints, or the surrounding paragraph for prose-defined constraints)

2. **Search for evidence per constraint.** For each constraint, search the `linked_paths` files first (highest signal), then the broader repo if nothing found. Look for:
   - **Direct traceability:** the literal constraint id (`PERF-2`, `KD-7`) in a code comment, test name, or commit message. This is the strongest evidence.
   - **Behavioral evidence:** function names, log fields, metric names, error codes, env vars, config keys, or test descriptions that the constraint text mentions explicitly.
   - **Test evidence:** test files that name the constraint or its behavior.

3. **Classify each constraint:**
   - **Implemented** — at least one direct or behavioral citation, with `file:line`.
   - **Partial** — some evidence but the constraint has multiple parts and only some are covered (cite what was found, name what's missing).
   - **Unverified** — no evidence found in `linked_paths` or the wider repo. Do not guess. Unverified is a legitimate verdict — that's what the audit is for.
   - **N/A** — the spec explicitly defers it (e.g. "Out of scope for v1" in the constraint row, or `R-N` risks classified as "accepted, no mitigation").

4. **§6 Implementation Plan extra checks.** Per the `/spec` convention (see `references/cc-prompt-templates.md` in the spec skill), prompt blocks under §6.3 should each contain:
   - A `<read-first>` block listing source files,
   - Test names (TDD-first),
   - A `<verify>` block.

   Flag prompt blocks missing any of the three as **INFO** (process drift, not implementation failure).

5. **§8 Risks audit.** For each `R-N` row, check whether the `Mitigation` column points to anything in the codebase (a guard, a test, a runbook). Risks with empty mitigations are **INFO** unless `Likelihood`+`Impact` are both High → **WARNING**.

---

### Phase 4 — Acceptance Command Execution

The `acceptance_commands` array in `spec.json` is the spec's executable
ground truth. Run them.

**Skip this phase entirely if `--no-run` was passed.** Record the commands as "not executed in this run" in the audit and proceed to Phase 5.

1. **For each command in `spec.json.acceptance_commands`:**
   - Run it from the project root.
   - Capture exit code, last 30 lines of stdout, last 30 lines of stderr.
   - Record duration.

2. **On any failure, prove pre-existing vs. introduced.** This is non-negotiable per the user's CLAUDE.md test discipline — never assert "pre-existing" without proof. The required check:

   ```bash
   git stash --include-untracked
   <failing-command>
   STASHED_EXIT=$?
   git stash pop
   ```

   - If `STASHED_EXIT` is also non-zero → label the failure **pre-existing** (recorded as **WARNING**, not **CRITICAL**, since not the spec's fault but worth flagging).
   - If `STASHED_EXIT` is zero → label the failure **introduced** (recorded as **CRITICAL** — the spec implementation broke this command).
   - If there is nothing to stash (clean working tree), the failure is in committed code — label **pre-existing**.

3. **Always restore working state.** `git stash pop` after every stash. If `git stash pop` errors (e.g. conflicts), stop the entire skill, surface the situation to the user, and do not write the audit. Losing user work is worse than missing the audit.

---

### Phase 5 — Write the Audit Doc

1. **Compose the audit** using the exact template at [references/audit-template.md](references/audit-template.md). Fill every section. If a section has no findings, write "No issues found." rather than omitting it — readers need to know it was checked.

2. **Severity convention** (matches `/create-audit`):
   - **CRITICAL** — Constraint marked "Implemented" or status `done`/`implementing` in `spec.json` but acceptance command fails as **introduced**. Or: a CRITICAL/HIGH risk has no mitigation evidence and the corresponding behavior fails.
   - **WARNING** — `Partial` or `Unverified` constraints; pre-existing acceptance failures; unresolved `linked_paths`; missing dependency specs; missing risk mitigations on high-impact risks.
   - **INFO** — README/section status drift; orphan or undefined `DOC-N`; §6 prompt blocks missing `<read-first>`/`<verify>`/test names; documentation nits.

3. **Filename:** `spec-<spec-id>-validation-<YYYY-MM-DD>.md`, lowercase kebab-case, written to `<project-root>/docs/audits/`. Create `docs/audits/` if it doesn't exist. If a file with that name already exists from earlier today, append `-2`, `-3`, etc. — never overwrite a prior audit.

4. **Do not modify the spec.** No edits to `spec.json`, `README.md`, or any section file. No staging, no committing of any file. Leave the audit as untracked. The user decides whether to commit it.

5. **Report to the user**, in this exact tight form (no document dump in chat):

   ```
   Wrote: docs/audits/spec-<id>-validation-<date>.md
   Constraints: <implemented>/<partial>/<unverified>/<n/a> (total <N>)
   Acceptance: <pass>/<fail-introduced>/<fail-pre-existing>/<not-run>
   Issues: <critical> CRITICAL · <warning> WARNING · <info> INFO
   ```

   That's it. The audit doc speaks for itself.

---

## Key Principles

1. **Evidence before claims.** Every "Implemented" verdict cites `file:line`. "Unverified" is honest; guessing is forbidden. The audit's value is in being trustworthy — a single hallucinated citation poisons the whole document.

2. **Audit, don't fix.** Findings only. The user decides what to act on. If you spot a bug while auditing, log it as an issue with severity and location — do not patch it.

3. **Read-only against the spec.** Never edit section files, `README.md`, or `spec.json`. Status drift between README and section files is a finding, not something to silently correct. The spec is an artifact of human + AI collaboration; "fixing" it without the user changes the historical record.

4. **Honor the test discipline.** Pre-existing failures must be proven via `git stash`, never asserted. The user's CLAUDE.md is explicit on this and past sessions have been wrong about it. Always restore working state before moving on.

5. **Tight output.** Tables over prose. No filler, no narrative throat-clearing. The audit is a working document the user opens to decide what to do next, not a report to read end-to-end. Match `/create-audit`'s discipline.

6. **One spec at a time.** Don't try to validate multiple specs in one invocation. Each spec gets its own focused audit. Multi-spec runs encourage shallow checks and cross-contamination of evidence.
