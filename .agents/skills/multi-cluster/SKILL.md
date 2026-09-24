---
name: multi-cluster
description: >-
  Add or change a Kubernetes resource that both the folly and offsite clusters
  run, through clusters/base/. Use when a change should apply to both
  clusters.
metadata:
  runbook: docs/runbooks/apply-a-kubernetes-change.md
  wiki: https://wiki.lolwtf.ca/runbooks/apply-a-kubernetes-change/
---

# Multi-cluster

The procedure is `docs/runbooks/apply-a-kubernetes-change.md`. These notes
cover what an agent needs beyond it. The `kubernetes-gitops` skill applies too.

## Notes

- Each shared component is a directory under `clusters/base/` with its own
  `kustomization.yaml`. A cluster references the directory, never a file in
  it.
- A cluster picks up a shared component in one of three ways. Match the one
  its neighbours use:
  - Its `kustomization.yaml` lists a relative path such as
    `../../base/apps/<name>`.
  - One of its Flux `Kustomization` objects points `spec.path` at the base
    directory, as `clusters/offsite/flux-system/storage.yaml` does.
  - `clusters/base/flux-system/` holds a Flux `Kustomization` for each shared
    platform component, and both clusters include that directory.
- Put the values that differ between clusters in Flux substitutions:
  `cluster-settings`, `cluster-topology` and `cluster-secrets`. Make sure the
  Flux `Kustomization` that applies the file lists the source; most
  `clusters/base/flux-system/` objects substitute nothing.
- A resource that differs in more than its substitutions goes in each
  cluster's directory.
- folly has `nodes/` and its own storage overlay, and offsite has
  `monitoring-crds/`. A change that renders on one cluster can fail on the
  other.
- Render both clusters with `mise run k8s:render-apps`. For one directory,
  such as `apps` or `monitoring`, run `kubectl kustomize clusters/<site>/<dir>`
  for each site.
