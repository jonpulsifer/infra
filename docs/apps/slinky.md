---
title: Slinky
description: Slurm on the folly cluster through the Slinky operator, a six-worker cluster with a shared scratch on forge, for learning the scheduler and running demo jobs.
status: experiment
---

Slinky is SchedMD's Slurm operator for Kubernetes. On folly it runs one Slurm cluster, named `folly`, with a controller, a REST API, a login pod and six small `slurmd` workers that spread over the three nodes. The owner uses it to learn Slurm and to show the scheduler at work. It serves no production job.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Login pod over SSH | The `slurm-login-folly` Service in `slurm`, a folly load-balancer address | Root, with the owner's GitHub SSH keys |
| Demos | `/opt/demos/` in the login pod | Anyone in the login pod |
| Shared scratch | `/shared` in the login pod and every worker, forge's `/srv/slurm` over NFS | Any job and any login shell |
| REST API | `http://slurm-restapi:6820` inside the cluster | A holder of a Slurm JWT |
| Metrics | `slurm_*` series in folly's Prometheus | Grafana |

[Run a Slurm demo](../runbooks/run-a-slurm-demo.md) has the steps.

## Limits

- Each of the six workers offers one core, 2 CPUs on the hyper-threaded nodes, and 1 GB, so the cluster has 12 CPUs and a job spreads over nodes rather than CPUs. A job that asks for more nodes than exist waits forever.
- `/shared` is the only filesystem the login pod and the workers have in common. A batch job's output file lands on the worker that ran it unless `--output` names a path under `/shared`. The mount is hard: while forge's NFS server is down, any process that touches `/shared` hangs in D state and the pods stay Ready. `ForgeNfsServerDown` fires. Nothing backs `/shared` up.
- No accounting. `sacct` has no database to read, and there is no federation with a second cluster.
- Slurm allocates whole cores, so one task runs on each worker at a time whatever its thread count.
- The login pod's root keys are the owner's GitHub keys, copied into `clusters/folly/apps/slinky/helm-release-slurm.yaml`. A key change at GitHub needs a change there too.
- The operator pins Slurm 26.05 through the `slurm` chart's image tags.

## How it works

Three Helm charts from `ghcr.io/slinkyproject/charts` run in two namespaces. `slurm-operator-crds` and `slurm-operator` install the `slinky.slurm.net` kinds and the operator into `slinky`. The `slurm` chart turns its values into a `Controller`, a `RestApi`, a `LoginSet`, a `NodeSet` and a `Token` in `slurm`, and the operator turns those into pods. The webhook certificate comes from folly's cert-manager.

The `NodeSet` is a StatefulSet-like set of `slurmd` pods. A `slurmd` registers the host's topology and reserves whatever its container limits do not cover as specialized cores and memory, in whole cores, so the limits decide what a worker offers. Two workers may share a Kubernetes node, each worker keeps its node, and a worker's Slurm record goes when its pod does. A terminating worker is marked down, and the controller's `ReturnToService=2` lets the replacement's registration bring the node back without a hand `resume`. The `Token` keeps a root JWT for the REST API in the Secret `slurm-token-root`. The demo scripts are a ConfigMap that the login pod mounts at `/opt/demos`. The login pod and every worker mount [forge](../hosts/forge.md)'s NFS export at `/shared`, through an `nfs` volume whose server address Flux fills from `anchor-topology`; `nix/services/slurm-nfs.nix` declares the export.

The `slurm` namespace runs the `privileged` pod-security profile, because `slurmd` puts each job step in a cgroup of its own.

## Operate

No alert watches Slinky. The controller's metrics reach Prometheus through its ServiceMonitor.

| Check | Command |
| --- | --- |
| Operator and webhook | `kubectl --context folly -n slinky get pods` |
| Cluster pods | `kubectl --context folly -n slurm get pods` |
| Slurm's view | `kubectl --context folly -n slurm exec slurm-controller-0 -- sinfo` |

To change the cluster, edit the values in `clusters/folly/apps/slinky/helm-release-slurm.yaml` and merge. A worker count change rolls the `NodeSet`.

## Reference

- Manifests: `clusters/folly/apps/slinky/`
- Demos: `clusters/folly/apps/slinky/demos/`
- Upstream: [github.com/SlinkyProject/slurm-operator](https://github.com/SlinkyProject/slurm-operator)
