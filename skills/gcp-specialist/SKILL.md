---
id: gcp-specialist
name: gcp-specialist
type: skill
version: 1.0.0
domain: [infra]
platform: [gcp]
task: [debugging, review]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-04-17
description: >
  Deep-dive Google Cloud architecture review, debugging, and service design.
  Use for structured investigations of GCP-specific issues, IAM or cost audits,
  and multi-service design reviews. Triggers on: "GCP audit", "GCP design review",
  "Workload Identity debug", "IAM review GCP", "review my GKE",
  "GCP troubleshooting", "Cloud Run deep-dive".
argument-hint: "<project context, service, or problem description>"
tools: Read, Grep, Glob, Bash
effort: max
model: opus
---

# GCP Specialist

Structured investigation for Google Cloud workloads. Five phases: gather context,
diagnose, design, recommend, verify.

## Arguments

- `$0` — project context, service scope, or problem description. Required.

---

## Phase 1: Context Gathering

1. Identify the organization, folders, project(s), and services in scope.
2. Glob for IaC in the working directory: `**/*.tf`, `**/*.yaml` (Config Connector), `**/*.jinja` (Deployment Manager legacy).
3. If gcloud CLI access is available:
   ```bash
   gcloud config list
   gcloud projects list
   gcloud auth list
   ```
4. List enabled APIs in the current project:
   ```bash
   gcloud services list --enabled --format="value(config.name)"
   ```

---

## Phase 2: Diagnosis

**Compute / containers:**

```bash
gcloud compute instances list
gcloud container clusters list
gcloud run services list
```

**IAM / identity:**

```bash
gcloud projects get-iam-policy <project>
gcloud iam service-accounts list
gcloud iam workload-identity-pools list --location=global
```

**Networking:**

```bash
gcloud compute networks list
gcloud compute firewall-rules list
gcloud compute routers list
```

**Serverless / events:**

```bash
gcloud functions list
gcloud pubsub topics list
gcloud pubsub subscriptions list
```

**Cost / quotas:**

```bash
gcloud compute project-info describe --format="yaml(quotas)"
gcloud logging read 'resource.type="gce_instance"' --limit=20 --format=json
```

---

## Phase 3: Design / Root-Cause Analysis

Map symptoms to causes:

| Symptom                | Common Causes                                                          | Check                                                                    |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| GKE pod AuthN fails    | Workload Identity not bound, KSA/GSA annotation mismatch               | `kubectl describe sa` + `gcloud iam service-accounts get-iam-policy`     |
| Cloud Run cold starts  | min-instances=0, cold container image                                  | `gcloud run services describe` → min-instances, image size               |
| GCS AccessDenied       | Uniform vs fine-grained mismatch, missing `roles/storage.objectViewer` | `gsutil iam get` + project-level IAM                                     |
| Pub/Sub messages stuck | Subscription ack deadline too short, consumer crashed                  | `gcloud pubsub subscriptions describe` + dead-letter config              |
| BigQuery slow query    | Missing clustering/partitioning, full table scan                       | Query plan review, DRY_RUN pricing                                       |
| VPC connectivity fail  | Firewall default-deny, missing Private Google Access                   | `gcloud compute firewall-rules list` + subnet Private Google Access flag |

Cite resource self-link or `file:line` for every finding.

---

## Phase 4: Recommendations

Output findings in priority order:

```
[CRITICAL] <title>
Resource: <self-link or file:line>
Issue: <one sentence>
Evidence: <gcloud output or code snippet>
Fix: <specific change, with Terraform/Config Connector diff>
Trade-off: <alternative and its downside, if meaningful>
```

- Order: CRITICAL → WARNING → INFO.
- For IaC fixes, show the exact Terraform or Config Connector diff.
- Reference relevant docs in `references/` where applicable.

---

## Phase 5: Verification

After fixes are applied:

1. Re-run the diagnostic command that surfaced the issue.
2. For Workload Identity changes: `gcloud iam service-accounts get-iam-policy` and live pod token request.
3. For firewall changes: `gcloud compute firewall-rules list` + connectivity probe.
4. For IAM changes: `gcloud projects get-iam-policy --flatten="bindings[].members"` to see effective membership.
5. Check Cloud Monitoring dashboards and Error Reporting — no new incidents should be open.

---

## Reference Docs

Consult `references/` for decision guides:

| File               | When to use                                              |
| ------------------ | -------------------------------------------------------- |
| `compute.md`       | GKE, Cloud Run, GCE selection and sizing                 |
| `serverless.md`    | Cloud Functions, Pub/Sub, Cloud Tasks, Eventarc          |
| `storage.md`       | GCS, Filestore, BigQuery, Cloud SQL, Spanner             |
| `networking.md`    | VPC, Cloud Load Balancing, Cloud Armor, Cloud CDN        |
| `iam.md`           | IAM hierarchy, Workload Identity, Service Accounts       |
| `observability.md` | Cloud Monitoring, Logging, Trace, Error Reporting        |
| `iac-patterns.md`  | Terraform, Config Connector, Deployment Manager patterns |
