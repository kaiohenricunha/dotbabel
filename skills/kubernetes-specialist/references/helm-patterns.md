# Helm Patterns

## Key Concepts

- **Chart** — a package of Kubernetes templates with a `Chart.yaml` descriptor and a `values.yaml` defaults file.
- **Values hierarchy** — `values.yaml` (defaults) < `values-<env>.yaml` < `--set` flags. Later values override earlier ones.
- **Hooks** — lifecycle callbacks (`pre-install`, `post-upgrade`, `pre-delete`, etc.) for migrations, tests, and cleanup.
- **Subcharts / dependencies** — charts declared in `Chart.yaml` `dependencies`; managed via `helm dependency update`.

## Common Patterns

```yaml
# values.yaml — parameterize what varies between environments
image:
  repository: my-app
  tag: "" # left empty; set by CI via --set image.tag=<sha>
  pullPolicy: IfNotPresent

replicaCount: 2
```

```
# templates/deployment.yaml — reference values with defaults
image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
```

Always provide a fallback for values that might be empty in dev environments.

```yaml
# hooks/migrate-job.yaml — run DB migration before upgrade completes
metadata:
  annotations:
    "helm.sh/hook": pre-upgrade
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
```

`hook-delete-policy: hook-succeeded` cleans up successful jobs automatically.

## Checklist

- [ ] `values.yaml` documents every value with a comment explaining its effect.
- [ ] Secrets are not in `values.yaml` — use a secret store reference or external secret injection.
- [ ] `helm template` output reviewed before `helm install/upgrade` in CI.
- [ ] `helm lint` passes with no errors.
- [ ] `helm test` suite exists for smoke-testing deployed releases.
- [ ] Hook delete policy set to prevent accumulation of completed hook pods/jobs.

## Gotchas

- `--set` values containing dots (`a.b.c`) require escaping (`a\.b\.c`) or use of `--set-string` for string values.
- `helm upgrade --install` is idempotent for CI but hides whether an install or upgrade ran — check release history after.
- Subchart values are namespaced: set them as `subchart.key: value`, not `key: value`.
- `helm rollback` rolls back the release but not PVCs or external resources created by hooks — always verify data state after rollback.
