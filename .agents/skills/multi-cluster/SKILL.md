---
name: multi-cluster
description: Add or modify shared resources across folly and offsite k8s clusters using the base/ pattern.
metadata:
  runbook: docs/pages/Runbooks___Add Shared Kubernetes Resource.md
  wiki: https://wiki.lolwtf.ca/runbooks/add-shared-kubernetes-resource/
---

# Multi-Cluster

Canonical human runbook: `docs/pages/Runbooks___Add Shared Kubernetes Resource.md`.
Reference bridge: `references/runbook.md`.

## Agent Notes

- Shared resources live under `clusters/base/`.
- Each shared component should be a directory with its own `kustomization.yaml`.
- Cluster overlays reference shared directories, not individual files outside the kustomization root.
- Templatize cluster-specific values with Flux substitutions such as `${CLUSTER_NAME}` and `${SECRET_DOMAIN}` when the parent Flux Kustomization provides them.
- Validate every consuming cluster:
  ```bash
  kubectl kustomize clusters/folly/<category>
  kubectl kustomize clusters/offsite/<category>
  ```
- Keep genuinely cluster-specific resources in cluster overlays.
