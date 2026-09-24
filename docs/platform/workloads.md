---
title: Workloads
description: What runs on the folly and offsite Kubernetes clusters, the files that list it, and the workloads that have their own page.
---

A workload is an app or controller that Flux runs on one of the two [Kubernetes](kubernetes.md) clusters. Git holds the full list for each cluster.

offsite runs the public and upload-heavy workloads, because folly's internet link has little upload capacity. folly runs the household, media and lab workloads, and the ones that need riptide's GPU.

## Where it lives

| File or directory | What it lists |
| --- | --- |
| `clusters/<site>/apps/kustomization.yaml` | The apps in the `apps` Flux Kustomization. A commented-out line does not run. |
| `clusters/<site>/flux-system/` | The other Flux Kustomizations of the cluster, such as `networking`, `monitoring`, `arc-runners` and `oauth2-proxy` |
| `clusters/base/flux-system/` | The shared controllers in `clusters/base/platform/`, which both clusters run |
| `clusters/base/apps/` | Apps that both clusters include by path |

A `.yaml` file in `clusters/folly/apps/` next to a directory of the same name is a Flux Kustomization that applies that directory.

To see what is live, run `flux --context <site> get kustomizations -A` and `flux --context <site> get helmreleases -A`. To see the objects that a directory makes, run `kubectl kustomize <path>`. `mise run k8s:render-apps` makes sure that each directory renders, and shows no objects.

## Workloads with a page

| Workload | Cluster | Page |
| --- | --- | --- |
| kthx quick-site server | offsite | [Quick sites](../apps/kthx/sites.md) |
| kthx built-app engine | offsite. It deploys built apps to both clusters. | [Built apps](../apps/kthx/built-apps.md) |
| clankerbanker | offsite, as a kthx built app | [clankerbanker](../apps/clankerbanker.md) |
| Rowbutt | offsite | [Rowbutt](../apps/mate.md) |
| Weather Hub | offsite | [Weather Hub](../apps/hub.md) |
| PBX | both | [PBX](../apps/pbx.md) |
| Smiirl counter | folly | [Smiirl counter](../apps/smiirl.md) |
| Tidbyt apps | folly | [Tidbyt apps](../apps/tidbyt.md) |
| Flame Boss exporter | folly | [Flame Boss exporter](../apps/flameboss.md) |
| netbench | folly, with iperf3 on both | [netbench](../apps/netbench.md) |
| Monitoring | both | [Observability](observability.md) |
| Atlantis | offsite | [OpenTofu and Atlantis](opentofu.md) |
| GitHub Actions runners | both | [Build and release](build-and-release.md) |
| OpenBao | folly | [Secrets](secrets.md) |
| Postgres databases | both | [Operate Postgres](../runbooks/operate-postgres.md) |

Argo CD runs on folly from `clusters/folly/apps/argo/`. Git declares no Argo `Application`. The kthx engine creates Applications in `argo` for a folly `kubernetes` Target that delivers through Argo ([Built apps](../apps/kthx/built-apps.md#targets)).

## Related

- [Kubernetes](kubernetes.md)
- [Apply a Kubernetes change](../runbooks/apply-a-kubernetes-change.md)
