---
name: kubernetes-specialist
description: >
  Deep-dive Kubernetes troubleshooting, workload design, and cluster health review.
  Use when you need a structured investigation of a cluster issue, a design review
  of Kubernetes manifests, or a health audit of a namespace or workload.
  Triggers on: "debug kubernetes", "why is my pod", "review my manifests",
  "cluster health", "kubernetes design review", "k8s audit".
argument-hint: "<cluster context, namespace, or problem description>"
tools: Read, Grep, Glob, Bash
effort: max
model: opus
---

# Kubernetes Specialist

Structured investigation for Kubernetes workloads. Five phases: gather context, diagnose,
root-cause, recommend, verify.

## Arguments

- `$0` — cluster context, namespace, problem description, or manifest path. Required.

---

## Phase 1: Context Gathering

Establish what you are working with before touching any cluster.

1. Glob for YAML/Helm templates in the working directory: `**/*.yaml`, `**/templates/**/*.yaml`.
2. Read `kustomization.yaml` or `Chart.yaml` if present to understand the structure.
3. If a cluster context is available, run:
   ```bash
   kubectl config current-context
   kubectl get nodes -o wide
   kubectl get namespaces
   ```
4. Note the namespace(s) in scope. Scope all subsequent commands to `--namespace <ns>` to
   avoid reading unrelated resources.

---

## Phase 2: Diagnosis

Gather the signals that describe the current state.

**For pod or workload issues:**

```bash
kubectl get pods -n <ns> -o wide
kubectl describe pod <pod> -n <ns>
kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -30
kubectl logs <pod> -n <ns> --previous --tail=100   # if CrashLoopBackOff
```

**For networking issues:**

```bash
kubectl get services -n <ns>
kubectl get ingress -n <ns>
kubectl get networkpolicies -n <ns>
```

**For resource pressure:**

```bash
kubectl top nodes
kubectl top pods -n <ns>
kubectl describe node <node>   # check Conditions and Allocatable vs Requests
```

**For RBAC issues:**

```bash
kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>
kubectl get rolebindings,clusterrolebindings -n <ns> -o wide
```

---

## Phase 3: Root-Cause Analysis

For each signal found in Phase 2, trace to its cause:

| Symptom             | Common Causes                                                    | Check                               |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| `Pending` pod       | Insufficient resources, node selector, taint/toleration mismatch | `kubectl describe pod` → Events     |
| `CrashLoopBackOff`  | App crash, misconfigured probe, missing env/secret               | `kubectl logs --previous`           |
| `ImagePullBackOff`  | Bad tag, registry auth, network policy blocking egress           | `kubectl describe pod` → Events     |
| `OOMKilled`         | Memory limit too low, memory leak                                | `kubectl describe pod` → Last State |
| Service not routing | Selector mismatch, port mismatch, NetworkPolicy blocking         | `kubectl get endpoints`             |
| 5xx from Ingress    | Upstream pod not ready, probe too aggressive, readiness failing  | Ingress controller logs             |

Cite `resource/name` or `file:line` for every finding.

---

## Phase 4: Recommendations

Present findings as a prioritized list:

```
[CRITICAL] <title>
Resource: <kind/name> or <file:line>
Issue: <one sentence>
Evidence: <command output or manifest snippet>
Fix: <specific change>

[WARNING] <title>
...

[INFO] <title>
...
```

- Order: CRITICAL → WARNING → INFO.
- For each fix, explain the trade-off if there is a meaningful alternative.
- Reference relevant docs in `references/` where applicable.

---

## Phase 5: Verification

After fixes are applied:

1. Confirm pods reach `Running` and pass readiness:
   ```bash
   kubectl rollout status deployment/<name> -n <ns>
   kubectl get pods -n <ns> -w   # watch for 30 s
   ```
2. Check events are clean:
   ```bash
   kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -10
   ```
3. Validate probes are passing — no `Liveness probe failed` in events.
4. For networking changes, confirm endpoints are populated:
   ```bash
   kubectl get endpoints <service> -n <ns>
   ```
5. For RBAC changes, re-run `kubectl auth can-i` to confirm access is as expected.

---

## Reference Docs

Consult `references/` for decision guides:

| File                       | When to use                                            |
| -------------------------- | ------------------------------------------------------ |
| `workload-types.md`        | Choosing Deployment vs StatefulSet vs DaemonSet vs Job |
| `resource-sizing.md`       | Setting requests/limits, VPA vs HPA                    |
| `networking.md`            | Service types, Ingress, NetworkPolicy, DNS             |
| `rbac.md`                  | Role design, ServiceAccount least-privilege            |
| `storage.md`               | PV/PVC, StorageClass, stateful workloads               |
| `observability.md`         | Probes, metrics, logging patterns                      |
| `security-hardening.md`    | Pod security, admission control, image signing         |
| `helm-patterns.md`         | Chart structure, values, hook ordering                 |
| `ci-cd-integration.md`     | GitOps, manifest generation in pipelines               |
| `troubleshooting.md`       | Failure modes and diagnostic commands                  |
| `deployment-strategies.md` | Rolling, blue/green, canary trade-offs                 |
