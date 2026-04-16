---
name: terragrunt-specialist
description: >
  Deep-dive Terragrunt hierarchy review, DRY pattern audits, and run-all
  orchestration analysis. Use for structured investigations of multi-environment
  Terragrunt layouts, dependency graphs, remote state config, and hook correctness.
  Triggers on: "Terragrunt audit", "run-all review", "dependency block", "DRY pattern
  review", "env hierarchy audit", "mock_outputs", "terragrunt hooks".
argument-hint: "<repo root or terragrunt.hcl path>"
tools: Read, Grep, Glob, Bash
effort: max
model: opus
---

# Terragrunt Specialist

Structured investigation for Terragrunt-managed Terraform codebases. Five phases:
gather context, diagnose, design, recommend, verify.

## Arguments

- `$0` — repo root, specific `terragrunt.hcl` path, or problem description. Required.

---

## Phase 1: Context Gathering

1. Map the full hierarchy:
   ```bash
   find . -name "terragrunt.hcl" | sort
   ```
2. Identify the root `terragrunt.hcl` (contains `remote_state`, `terraform_version_constraint`).
3. Check include chain:
   ```bash
   grep -r "include" . --include="terragrunt.hcl" -l
   grep -r "find_in_parent_folders" . --include="terragrunt.hcl" -l
   ```
4. List all dependency blocks:
   ```bash
   grep -r "dependency" . --include="terragrunt.hcl" -A5
   ```

---

## Phase 2: Diagnosis

**DRY pattern health:**

```bash
# Check for duplicated locals or inputs across leaves
grep -r "locals" . --include="terragrunt.hcl" -l
grep -r "inputs\s*=" . --include="terragrunt.hcl" -l
```

**Remote state config:**

```bash
grep -r "remote_state" . --include="terragrunt.hcl" -A10
```

**run-all safety:**

```bash
terragrunt run-all plan --terragrunt-non-interactive 2>&1 | head -100
```

**Hook correctness:**

```bash
grep -r "before_hook\|after_hook\|error_hook" . --include="terragrunt.hcl" -A8
```

---

## Phase 3: Design / Root-Cause Analysis

Map symptoms to causes:

| Symptom                       | Common Causes                             | Check                                                 |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `run-all` applies wrong order | Missing `dependency` block                | Dependency graph via `run-all plan`                   |
| `mock_outputs` plan fails     | Wrong type in mock (string vs list)       | Compare mock type to real output type                 |
| DRY violation                 | Same `inputs` block in multiple leaves    | Extract to parent `locals` + `read_terragrunt_config` |
| State collision               | Two leaves share the same backend key     | Grep `remote_state.config.key` across leaves          |
| Hook runs unexpectedly        | Hook trigger is `run_if` on wrong command | Check `commands` list in hook block                   |

Cite `file:line` for every finding.

---

## Phase 4: Recommendations

Output findings in priority order:

```
[CRITICAL] <title>
File: <file:line>
Issue: <one sentence>
Evidence: <config snippet>
Fix: <specific change, with HCL diff>
Trade-off: <alternative and its downside, if meaningful>
```

Order: CRITICAL → WARNING → INFO.

---

## Phase 5: Verification

After fixes are applied:

1. `terragrunt validate` on affected leaves.
2. `terragrunt run-all plan --terragrunt-non-interactive` — confirm correct dependency order.
3. Verify no two leaves share the same remote state key.
4. If `mock_outputs` changed, confirm `plan --terragrunt-non-interactive` succeeds on dependent modules.
5. Run hooks manually to confirm they execute in the expected phase.

---

## Reference Docs

| File                   | When to use                                           |
| ---------------------- | ----------------------------------------------------- |
| `dry-patterns.md`      | `include`, `read_terragrunt_config`, locals reuse     |
| `run-all.md`           | `run-all` orchestration, dependency graph, scoping    |
| `env-hierarchy.md`     | Account → region → env → module layout patterns       |
| `hooks.md`             | `before_hook`, `after_hook`, `error_hook` design      |
| `dependency-blocks.md` | Explicit deps, `mock_outputs`, cross-stack references |
