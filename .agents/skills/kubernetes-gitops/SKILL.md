---
name: kubernetes-gitops
description: >-
  Work with Kubernetes manifests and GitOps workflows for the folly and offsite
  clusters. Covers FluxCD reconciliation, inspecting cluster state, and SOPS
  secrets. Use when changing anything under clusters/ or diagnosing why a
  manifest has not taken effect.
metadata:
  runbook: docs/pages/Runbooks___Kubernetes GitOps Change.md
  wiki: https://wiki.lolwtf.ca/runbooks/kubernetes-gitops-change/
---

# Kubernetes GitOps

Canonical human runbook: `docs/pages/Runbooks___Kubernetes GitOps Change.md`.
Layer background: `docs/pages/Architecture___Kubernetes.md`. This file holds
only the agent-specific guidance.

## Agent notes

- Changes under `clusters/` deploy via Flux after merge to `main`. **Never
  `kubectl apply` to author desired state** — `kubectl`, `flux get`, and
  `flux reconcile` are for inspection or forcing a sync.
- Flux owns all live cluster state. ArgoCD is installed as a HelmRelease but
  owns no applications; `terraform/argo` declares no resources.
- Always use explicit contexts — there are two clusters and the wrong one is a
  silent mistake:
  ```bash
  flux --context <folly|offsite> get kustomizations -A
  flux --context <folly|offsite> get helmreleases -A
  flux --context <folly|offsite> reconcile kustomization <name> -n flux-system --with-source
  ```
- Render locally before pushing:
  ```bash
  kubectl kustomize clusters/<site>/<category>
  ```
- Each cluster's root sync comes from its `FluxInstance`, configured in
  `clusters/<site>/bootstrap/flux-values.yaml`. There is no hand-applied root
  Kustomization — do not create one.
- Network facts are substituted from the `cluster-topology` ConfigMap via
  `postBuild.substituteFrom`. Reference `${VAR}`; never hardcode the value. The
  ConfigMap's schema is enforced by conftest in CI.
- SOPS encrypts only `data` and `stringData` in files matching
  `clusters/.*\.sops\.ya?ml`. **Never** put decrypted values in docs, PR
  comments, logs, or commit messages.
- For changes to `clusters/base/`, also use the `multi-cluster` skill.
