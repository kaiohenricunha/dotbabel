---
id: terraform-specialist
name: terraform-specialist
type: skill
version: 1.0.0
domain: [infra]
platform: [terraform]
task: [debugging, review]
maturity: validated
description: >
  Deep-dive Terraform architecture review, module design, state management, and
  migration. Use for structured investigations of Terraform workspaces, provider
  configuration, module coupling, import workflows, and test coverage. Triggers on:
  "Terraform audit", "module review", "state management", "Terraform import",
  "workspace design", "provider config review", "Terraform testing".
argument-hint: "<module path, workspace, or problem description>"
tools: Read, Grep, Glob, Bash
effort: max
model: opus
---

# Terraform Specialist

Structured investigation for Terraform codebases. Five phases: gather context,
diagnose, design, recommend, verify.

## Arguments

- `$0` — module path, workspace context, or problem description. Required.

---

## Phase 1: Context Gathering

1. Identify the scope: module, workspace, or full repo.
2. Glob for Terraform files:
   ```bash
   find . -name "*.tf" | sort
   find . -name "*.tfvars" | sort
   find . -name ".terraform.lock.hcl" | sort
   ```
3. Check backend and provider configuration:
   ```bash
   grep -r "backend" . --include="*.tf" -l
   grep -r "required_providers" . --include="*.tf" -l
   ```
4. Check for existing state:
   ```bash
   terraform workspace list
   terraform state list
   ```

---

## Phase 2: Diagnosis

**Module structure:**

```bash
# Check module inputs/outputs surface
grep -r "variable\|output\|locals" . --include="*.tf" -l
terraform validate
```

**State health:**

```bash
terraform state list
terraform state show <resource>
terraform plan -detailed-exitcode
```

**Provider locks:**

```bash
cat .terraform.lock.hcl
terraform providers
```

**Test coverage:**

```bash
find . -name "*_test.go" -o -name "*.tftest.hcl" | sort
```

---

## Phase 3: Design / Root-Cause Analysis

Map symptoms to causes:

| Symptom                       | Common Causes                           | Check                                  |
| ----------------------------- | --------------------------------------- | -------------------------------------- |
| Plan shows unexpected replace | `ForceNew` attribute changed, ID drift  | `terraform state show` + provider docs |
| State drift                   | Manual console change, import not run   | `terraform refresh` + `terraform plan` |
| Module coupling               | Outputs passed through too many layers  | Count cross-module variable chains     |
| Provider version conflict     | Lock file pinned differently per module | `.terraform.lock.hcl` comparison       |
| `count` vs `for_each` bug     | Resource renamed on index change        | Switch to `for_each` with stable keys  |

Cite `file:line` for every finding.

---

## Phase 4: Recommendations

Output findings in priority order:

```
[CRITICAL] <title>
Resource: <address or file:line>
Issue: <one sentence>
Evidence: <plan output or code snippet>
Fix: <specific change, with HCL diff if applicable>
Trade-off: <alternative and its downside, if meaningful>
```

Order: CRITICAL → WARNING → INFO.

---

## Phase 5: Verification

After fixes are applied:

1. Re-run `terraform validate` — no errors.
2. Run `terraform plan` — confirm zero unexpected changes.
3. For state moves: `terraform state list` before and after.
4. For module refactors: run tests if present (`terraform test` or `go test ./...`).
5. Confirm `.terraform.lock.hcl` is committed and unchanged.

---

## Reference Docs

| File                  | When to use                                      |
| --------------------- | ------------------------------------------------ |
| `modules.md`          | Module design, variable/output surface, coupling |
| `state-management.md` | Backends, state mv, import, drift remediation    |
| `workspaces.md`       | Workspace-per-env vs stack-per-env trade-offs    |
| `testing.md`          | Unit tests, integration tests, tftest            |
| `providers.md`        | Provider config, version pinning, aliases        |
| `import-patterns.md`  | `terraform import`, import blocks, bulk import   |
