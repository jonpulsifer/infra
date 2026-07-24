---
name: multi-cluster
description: >-
  Add or modify resources shared between the folly and offsite Kubernetes
  clusters using the clusters/base/ pattern. Use when a change should apply to
  both clusters rather than one.
metadata:
  runbook: docs/pages/Runbooks___Add Shared Kubernetes Resource.md
  wiki: https://wiki.lolwtf.ca/runbooks/add-shared-kubernetes-resource/
---

# Multi-Cluster

Canonical human runbook: `docs/pages/Runbooks___Add Shared Kubernetes
Resource.md`. Layer background: `docs/pages/Architecture___Kubernetes.md`. This
file holds only the agent-specific guidance.

## Agent notes

- Shared resources live under `clusters/base/`. Each component is a directory
  with its own `kustomization.yaml`.
- Cluster overlays reference shared **directories**, not individual files
  outside the kustomization root.
- There are two ways a cluster picks up a shared component. Match the one
  already in use nearby rather than inventing a third:
  - the cluster's `kustomization.yaml` lists a relative path
    (`../../base/apps/<name>`), or
  - the cluster's Flux `Kustomization` CR points `spec.path` straight at the
    base directory, used where a cluster has no local override at all.
- Templatize cluster-specific values with Flux substitutions (`${CLUSTER_NAME}`,
  `${SECRET_DOMAIN}`, and the `cluster-topology` keys) rather than branching per
  cluster. Confirm the parent Flux Kustomization actually provides the variable.
- The clusters are not symmetric — folly carries monitoring, storage overlays,
  and a `nodes/` device-plugin layer that offsite does not. Do not assume a
  change that works on folly renders on offsite.
- **Always validate both clusters**, not just the one you were thinking about:
  ```bash
  kubectl kustomize clusters/folly/<category>
  kubectl kustomize clusters/offsite/<category>
  ```
- Keep genuinely cluster-specific resources in the cluster overlay. Shared means
  identical, not similar.
