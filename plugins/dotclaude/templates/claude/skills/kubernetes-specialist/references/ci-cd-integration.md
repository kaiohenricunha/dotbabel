# CI/CD Integration

## Key Concepts

- **Manifest generation** — producing Kubernetes YAML from templates (Helm, Kustomize, raw YAML) as a CI artifact.
- **GitOps** — declaring desired cluster state in git; a controller (Argo CD, Flux) reconciles the cluster to match.
- **Image promotion** — updating the image tag or digest in manifests as the artifact moves through environments.
- **Pull vs push** — GitOps uses pull-based delivery (cluster pulls from git); traditional CD uses push (pipeline writes to cluster).

## Common Patterns

```yaml
# CI step: build and push image, then update manifest
- name: Update image tag
  run: |
    IMAGE_TAG="${{ github.sha }}"
    sed -i "s|image: my-app:.*|image: my-app:${IMAGE_TAG}|" k8s/deployment.yaml
    git config user.email "ci@example.com"
    git config user.name "CI Bot"
    git add k8s/deployment.yaml
    git commit -m "chore: update image to ${IMAGE_TAG}"
    git push
```

With GitOps, the CI pipeline writes to the config repo; the GitOps controller picks up the change.

```yaml
# Kustomize overlay for environment-specific values
# overlays/production/kustomization.yaml
resources:
  - ../../base
images:
  - name: my-app
    newTag: "abc123" # set by CI
patches:
  - path: hpa-patch.yaml
```

## Checklist

- [ ] Manifests are generated and linted in CI before merge (not only at deploy time).
- [ ] Image tag is set to a specific commit SHA or immutable tag — never `latest` in production.
- [ ] Secrets are injected at deploy time from a secret store, not committed to the config repo.
- [ ] Rollback is possible by reverting the config repo commit, not by manual cluster surgery.
- [ ] GitOps controller sync status is monitored — drift alerts configured.

## Gotchas

- Committing directly to the main config branch from CI bypasses PR review — use a separate branch + auto-merge PR for traceability.
- `latest` image tags defeat rollback: redeploying `latest` can silently change the actual image.
- Kustomize `images` stanza updates `newTag` but not `newDigest` — digest pinning requires explicit tooling (e.g., `kustomize edit set image my-app@sha256:...`).
- GitOps controllers may have a sync interval — a commit doesn't mean the cluster updated immediately. Check sync status before marking a deploy complete.
