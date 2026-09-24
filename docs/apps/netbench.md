---
title: netbench
description: An internal web tool on the folly cluster that runs iperf3 tests from a pod to Kubernetes nodes, NixOS lab hosts outside Kubernetes and the offsite cluster.
status: live
---

netbench is a web page for network tests inside the lab. It runs `iperf3`, which measures bandwidth, jitter, packet loss and retransmits, from a pod on folly to a named target. The owner uses it to test the node network, the paths between LANs and the Site Magic tunnel to offsite, which [Network](../platform/network.md) describes.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Web page and API | `https://netbench.lolwtf.ca` | Clients that route to folly's load-balancer range, with no sign-in |

Select a target, TCP or UDP, a duration, the number of parallel streams, and optionally reverse mode. The API is `GET /api/targets` and `POST /api/run`.

| Category | Path under test | Server |
| --- | --- | --- |
| `node` | A folly pod to a folly node | The `iperf3` DaemonSet |
| `lan` | A folly pod to a NixOS host outside Kubernetes, on another network | `services.iperf3` from `nix/services/iperf3.nix` |
| `cross-cluster` | A folly pod to an offsite node, through the Site Magic tunnel | The `iperf3` DaemonSet on offsite |

For HTTP load tests, use k6. See [Observability](../platform/observability.md).

## Limits

- A test runs for 1 to 60 seconds, 10 by default, with 1 to 32 parallel streams.
- The browser sends only a target name. netbench tests only the hosts in its target list.

## How it works

netbench is a Go server that runs `iperf3 -c <host> -J` and returns a summary of the result as JSON. It reads its targets when it starts, from the ConfigMap `netbench-targets`. Reloader restarts the Deployment when that ConfigMap changes.

The same image runs the `iperf3` server DaemonSet on every node of both clusters, on the host network at port 5201.

## Operate

No alerts watch netbench. `GET /healthz` returns `ok`.

To add a target, add an entry to `clusters/folly/apps/netbench/02-targets.yaml` and merge it. A NixOS host outside Kubernetes also needs `nix/services/iperf3.nix` in its imports. A Kubernetes node must not import that file, because the DaemonSet already uses port 5201 on the node.

## Reference

- Source: `apps/netbench/`
- Manifests: `clusters/folly/apps/netbench/` and `clusters/base/apps/iperf3/`
- Image: `ghcr.io/jonpulsifer/netbench`
