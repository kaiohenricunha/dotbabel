# Storage

## Key Concepts

- **PersistentVolume (PV)** — a cluster-level storage resource, provisioned statically or dynamically.
- **PersistentVolumeClaim (PVC)** — a pod's request for storage; bound to a PV by the control plane.
- **StorageClass** — defines the provisioner, parameters, and reclaim policy for dynamic provisioning.
- **volumeClaimTemplates** — StatefulSet-specific; creates a unique PVC per pod replica automatically.
- **Access modes** — `ReadWriteOnce` (single node), `ReadWriteMany` (multi-node), `ReadOnlyMany`.

## Common Patterns

```yaml
# Dynamic PVC — request 10Gi from the default StorageClass
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

```yaml
# StatefulSet volumeClaimTemplate — each replica gets its own PVC
spec:
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 10Gi
```

## Checklist

- [ ] `ReadWriteOnce` used for single-pod databases (most block storage supports only RWO).
- [ ] `ReadWriteMany` verified to be supported by the StorageClass before use (NFS, CephFS, etc.).
- [ ] `reclaimPolicy` reviewed — `Delete` removes the PV when the PVC is deleted; `Retain` keeps it.
- [ ] `storageClassName` explicitly set rather than relying on the cluster default.
- [ ] Backup strategy confirmed for stateful workloads before going to production.

## Gotchas

- Deleting a StatefulSet does NOT delete its PVCs — they persist and must be cleaned up manually.
- Resizing a PVC requires the StorageClass to have `allowVolumeExpansion: true`; not all provisioners support this.
- `ReadWriteOnce` volumes can only be mounted by pods on the same node — if the pod reschedules to a different node, it will be stuck pending if the volume can't follow.
- The `Retain` reclaim policy leaves data on the underlying volume even after PVC deletion, which can accumulate cost silently.
