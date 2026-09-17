# Security Hardening

## Key Concepts

- **Pod Security Standards** — cluster-level policy profiles: `privileged` (no restrictions), `baseline` (minimal restrictions), `restricted` (hardened defaults).
- **Admission controllers** — webhooks that validate or mutate resources at admission time (e.g., OPA Gatekeeper, Kyverno).
- **securityContext** — per-pod and per-container controls: run as non-root, drop capabilities, read-only filesystem.
- **Image signing** — cryptographic attestation that an image was built by a trusted source and not tampered with.
- **Supply-chain integrity** — SBOM generation, digest pinning, base image provenance.

## Common Patterns

```yaml
# Restricted pod security context
securityContext:
  runAsNonRoot: true
  runAsUser: 10000
  fsGroup: 10000
  seccompProfile:
    type: RuntimeDefault

containers:
  - name: app
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
          - ALL
```

Apply this template to every container as a baseline. Add capabilities back only when provably necessary.

```yaml
# Kyverno policy: disallow privileged containers
spec:
  rules:
    - name: disallow-privileged
      match:
        resources:
          kinds: ["Pod"]
      validate:
        message: "Privileged containers are not allowed."
        pattern:
          spec:
            containers:
              - securityContext:
                  privileged: false
```

## Checklist

- [ ] Namespace labeled with Pod Security Admission level (`pod-security.kubernetes.io/enforce`).
- [ ] No containers running as root (`runAsNonRoot: true`).
- [ ] `allowPrivilegeEscalation: false` on all containers.
- [ ] `capabilities.drop: [ALL]` with only necessary capabilities added back.
- [ ] `readOnlyRootFilesystem: true` with explicit `emptyDir` or `volumeMounts` for writable paths.
- [ ] Image tags pinned to digests in production (`image: repo/name@sha256:...`).
- [ ] Admission policy enforcing these controls at the cluster or namespace level.

## Gotchas

- `readOnlyRootFilesystem: true` will cause crashes if the application writes to `/tmp` or other paths without explicit volume mounts for those paths.
- `runAsNonRoot: true` is enforced by the kubelet — the image must not have `USER root` as its final user directive.
- Dropping `ALL` capabilities and adding back only `NET_BIND_SERVICE` is sufficient for most web servers.
- Image digest pinning breaks automatic base image updates — pair with a dependency update tool (e.g., Renovate) to get both security and freshness.
