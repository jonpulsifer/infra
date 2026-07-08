---
name: kubernetes-gitops
description: Work with Kubernetes manifests and GitOps workflows for the folly and offsite clusters. Covers FluxCD reconciliation, networking architecture, and SOPS secrets.
metadata:
  runbook: docs/pages/Runbooks___Kubernetes GitOps Change.md
  wiki: https://wiki.lolwtf.ca/runbooks/kubernetes-gitops-change/
---

# Kubernetes GitOps

Canonical human runbook: `docs/pages/Runbooks___Kubernetes GitOps Change.md`.
Reference bridge: `references/runbook.md`.

## Agent Notes

- Changes under `clusters/` deploy automatically via Flux after merge to `main`.
- Do not use `kubectl apply` to author desired state.
- Use explicit contexts: `--context folly` and `--context offsite`.
- Inspect reconciliation:
  ```bash
  flux --context <cluster> get kustomizations -A
  flux --context <cluster> get helmreleases -A
  ```
- Force reconcile only for inspection or merged changes:
  ```bash
  flux --context <cluster> reconcile kustomization <name> -n flux-system --with-source
  ```
- SOPS files are encrypted at rest; never expose decrypted values in docs, PR comments, or logs.
- HelmRepository/GitRepository/OCIRepository sources are colocated with the resources that consume them unless the local pattern says otherwise.
- For shared `clusters/base/` changes, also use the `multi-cluster` skill.
