# Facet Definitions

_Last updated: v2.5.0_

Canonical definitions for every enum value in `schemas/facets.schema.json`.
When adding a new value, update this file in the same PR and include one
example artifact that uses it (governance rule).

---

## domain

| Value           | Meaning                                           | Example artifact  |
| --------------- | ------------------------------------------------- | ----------------- |
| `infra`         | Cloud infrastructure, IaC, Kubernetes, networking | `aws-specialist`  |
| `backend`       | Server-side services, APIs, databases             | —                 |
| `frontend`      | Browser/client-side code, UI components           | —                 |
| `data`          | Data pipelines, ETL, analytics, ML data prep      | —                 |
| `security`      | Vulnerability scanning, secrets, IAM, compliance  | `security-review` |
| `observability` | Logging, metrics, tracing, alerting               | —                 |
| `devex`         | Developer tooling, workflows, CI/CD, productivity | `review-pr`       |
| `writing`       | Documentation, changelogs, technical writing      | `markdown`        |

---

## platform

| Value            | Meaning                               | Example artifact        |
| ---------------- | ------------------------------------- | ----------------------- |
| `aws`            | Amazon Web Services                   | `aws-specialist`        |
| `azure`          | Microsoft Azure                       | `azure-specialist`      |
| `gcp`            | Google Cloud Platform                 | `gcp-specialist`        |
| `kubernetes`     | Kubernetes (cluster-agnostic)         | `kubernetes-specialist` |
| `docker`         | Docker / OCI container runtime        | —                       |
| `vercel`         | Vercel hosting and edge functions     | —                       |
| `flyio`          | Fly.io application platform           | —                       |
| `neon`           | Neon serverless Postgres              | —                       |
| `github-actions` | GitHub Actions CI/CD                  | `review-pr`             |
| `terraform`      | HashiCorp Terraform IaC               | `terraform-specialist`  |
| `terragrunt`     | Terragrunt Terraform wrapper          | `terragrunt-specialist` |
| `pulumi`         | Pulumi infrastructure as code         | `pulumi-specialist`     |
| `crossplane`     | Crossplane cloud-native control plane | `crossplane-specialist` |
| `none`           | No specific platform dependency       | `fix-with-evidence`     |

**Note:** `none` is the correct value when an artifact works across all
platforms or has no platform-specific dependency. Do not omit the `platform`
field — use `[none]` explicitly.

---

## task

| Value               | Meaning                                                                                         | Example artifact        |
| ------------------- | ----------------------------------------------------------------------------------------------- | ----------------------- |
| `debugging`         | Diagnosing and fixing runtime or build failures                                                 | `fix-with-evidence`     |
| `migration`         | Moving systems, schemas, or data between states                                                 | —                       |
| `scaffolding`       | Generating new projects, files, or boilerplate                                                  | —                       |
| `review`            | Code review, audit, assessment, PR review                                                       | `review-pr`             |
| `testing`           | Writing, running, or diagnosing tests                                                           | `detect-flaky`          |
| `documentation`     | Writing, updating, or generating docs                                                           | `changelog`             |
| `incident-response` | On-call triage, runbooks, postmortems                                                           | —                       |
| `runtime-ops`       | Operating live systems: container exec, log inspection, service restart, traffic shifts         | `docker-engineer`       |
| `diagnostics`       | Inspecting state to understand behavior: kubectl describe, network tracing, query analysis      | `kubernetes-specialist` |
| `provisioning`      | Standing up new infrastructure or accounts: cluster bootstrap, IAM role creation, database init | `aws-engineer`          |

---

## maturity

| Value        | Meaning                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `draft`      | Work in progress; no consumer expectations. Anyone can author.                                                |
| `validated`  | Passes schema; has at least one real usage; ID is immutable from here.                                        |
| `production` | Used in at least one real external consumer or the plugin's own commands; owner on-call for breaking changes. |
| `deprecated` | Replaced; must set `deprecated_by`. Removed after 2 minor plugin releases.                                    |
