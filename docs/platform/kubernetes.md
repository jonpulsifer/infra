---
title: Kubernetes
description: The folly and offsite Kubernetes clusters, how Flux applies clusters/ from git, and the sandbox runtimes and storage the clusters offer.
---

The lab runs two Kubernetes clusters on NixOS hosts: `folly` at home and `offsite` at the remote site. Flux, the GitOps controller in each cluster, applies `clusters/` from `main`. [Workloads](workloads.md) lists what runs where.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Control plane | Runs the API server, etcd and pods | [optiplex](../hosts/optiplex.md) on folly, [retrofit](../hosts/retrofit.md) on offsite |
| Workers | Run pods | [riptide](../hosts/riptide.md) and [shale](../hosts/shale.md) on folly, [oldschool](../hosts/oldschool.md) on offsite |
| Bootstrap root | The OpenTofu root module that labels the nodes and installs CoreDNS, `flux-operator` and the `FluxInstance`, the object that `flux-operator` installs Flux from | Atlantis |
| Flux | Applies `clusters/` from the `infra` GitRepository | The `flux-system` namespace |
| Shared controllers | CloudNativePG, External Secrets, Kyverno and others | Both clusters |
| Storage | `local-path` volumes, and NFS volumes from [spore](../hosts/spore.md) | Both clusters, NFS on folly |
| GPU plugin | Offers riptide's GPU to pods | folly |

## How state reaches a cluster

A Flux Kustomization is a Flux object that applies one directory.

1. `instance.sync` in the bootstrap root's `flux-values.yaml` points Flux at `clusters/<site>/flux-system` on `main`.
2. That directory holds the Flux Kustomizations of the cluster, and includes `clusters/base/flux-system/` for the shared controllers.
3. Each Flux Kustomization applies its directory in `dependsOn` order. It decrypts SOPS files only with `spec.decryption`, and substitutes `${VAR}` only from `postBuild.substituteFrom`.

## Sandbox runtimes

A pod that names no RuntimeClass runs on `runc`. Every node also has these:

| RuntimeClass | Isolation |
| --- | --- |
| `gvisor` | gVisor, a user-space kernel (`runsc`) |
| `kata` | A QEMU microVM |
| `kata-clh` | A Cloud Hypervisor microVM |

[Rowbutt](../apps/mate.md) sandboxes run on `kata-clh`. The `packages/charts/app/` chart runs pods on `gvisor` unless its `sandbox` value is false.

## Rules

- Deploy a new containerd handler to every node from `main` before a workload names its RuntimeClass. The kubelet rejects a pod whose handler is missing.
- Put a new CRD in its own Flux Kustomization, and add that to the `dependsOn` of each consumer. Flux dry-runs every object first, so one unknown kind stops the Flux Kustomization.
- On folly, a kube-prometheus-stack bump leaves the Prometheus Operator CRDs behind the operator, because `upgrade.crds` defaults to `Skip`. [Adopt the folly Prometheus Operator CRDs](../runbooks/adopt-the-folly-prometheus-operator-crds.md) corrects this.
- Do not delete the `prometheus-operator-crds` HelmRelease. Helm then deletes the Prometheus Operator CRDs and every object of those kinds.
- A change to only `flux-values.yaml` in `clusters/<site>/bootstrap/` gets no autoplan. Plan and apply it as [OpenTofu and Atlantis](opentofu.md#rules) says.

## Where it lives

- `clusters/<site>/flux-system/` and `clusters/base/flux-system/`: the Flux Kustomizations
- `clusters/<site>/bootstrap/` and `terraform/modules/flux-bootstrap/`: the bootstrap root, with its state in `gs://homelab-ng/clusters/<site>/bootstrap`
- `clusters/base/platform/`, `clusters/*/storage/` and `clusters/folly/nodes/`: the shared controllers, storage and GPU plugin
- `clusters/base/cluster-runtimeclass.yaml`: the RuntimeClasses. `nix/services/k8s/` registers the handlers.
- `clusters/<site>/config/`: the settings, secrets and topology that Flux substitutes. See [Topology](../reference/topology.md).

## Related

- [How changes ship](how-changes-ship.md)
- [Apply a Kubernetes change](../runbooks/apply-a-kubernetes-change.md)
- [Get cluster admin access](../runbooks/get-cluster-admin-access.md)
- [Operate Postgres](../runbooks/operate-postgres.md)
- [Add a Kubernetes node](../runbooks/add-a-kubernetes-node.md)
