---
title: Observability
description: The metrics, logs, traces, dashboards and alerts on each Kubernetes cluster, the hosts and Windows desktops they watch, and the daily k6 check.
---

The monitoring stack collects metrics, logs and traces from the [Kubernetes](kubernetes.md) clusters, lab hosts and Windows desktops, and sends alerts to Discord. Each cluster, folly and offsite, runs a copy in the `monitoring` namespace.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Prometheus, Alertmanager, Grafana | Metrics for 30 days or 16 GB, alerts, dashboards | The `prom-stack` HelmRelease |
| Vector, VictoriaLogs | Ship pod and journal logs, and store them for one month | Each node, each cluster |
| OpenTelemetry Collector, Tempo | Receive traces over OTLP, the OpenTelemetry protocol, and store them | Each cluster |
| node exporter | Host metrics | Each node, and NixOS hosts with `homelab.fleet.metrics` |

## Use it

Clients that route to a cluster's load-balancer range reach its addresses.

| Surface | Address | Sign-in |
| --- | --- | --- |
| folly Grafana | `https://grafana.lolwtf.ca` | Grafana |
| folly Prometheus and Alertmanager | `https://prom.lolwtf.ca`, `https://am.lolwtf.ca` | None |
| folly log write endpoint | `https://logs.lolwtf.ca/insert` | None |
| offsite Grafana | `https://grafana-offsite.lolwtf.ca` | Grafana |

## Alerts and logs

Alertmanager routes every alert to Discord, and on offsite a firing `critical` alert to the owner's phone as well. [Alerting](observability/alerting.md) has the routes, the selector rules and who can post an alert.

The in-cluster log streams carry `cluster` and a `job` of `kubernetes` or `systemd-journal`. Vector also listens on each node's loopback for Talos service and kernel logs, the streams `job="talos"` (with `host` and `service`) and `job="talos-kernel"` (with `host`). No node runs Talos, so both are empty. The desktop streams carry `job="windows-eventlog"`, `host`, `channel` and `level`. Query logs in Grafana, or directly with the header `AccountID: 1`.

## Targets outside Kubernetes

folly scrapes the lab hosts and the Windows desktops through EndpointSlices. `PrometheusTargetMissing` fires when a lab host stops answering. A desktop that is off fires nothing: `TargetDown` leaves job `windows-exporter` out. `WindowsAgentDown` fires when one agent on a desktop answers and the other does not, and `WindowsDesktopUnseen` fires when a desktop has not answered for 7 days.

## k6

The k6 operator on folly runs each new TestRun, a k6 test, in a runner Job. Each day at 09:17 local time, the CronJob `k6-scenarios` recreates the `scenarios` TestRun. It checks the kthx console, a built app, and the 404 status page that an unclaimed App name gets through the public edge, and pushes metrics to Prometheus. A failed threshold fails the runner Job and fires `KubeJobFailed`, but the TestRun still shows `finished`.

## Rules

- Label each ServiceMonitor and PrometheusRule, and each PodMonitor on folly, `release: prom-stack`, or Prometheus ignores it. offsite selects every PodMonitor.
- Route only `/insert` of VictoriaLogs out of the cluster. It has no authentication, so another path exposes every log.
- Keep Prometheus, VictoriaLogs and Tempo off folly's control-plane node. Each carries a `nodeAffinity` that excludes `node-role.kubernetes.io/control-plane`, because their writes share the disk that etcd uses.
- Run `mise run k8s:check-rules` after a rule change, or a broken rule fails CI.

## Where it lives

- `clusters/base/monitoring/`: the shared parts, Discord route, rules and dashboards
- `clusters/<site>/monitoring/`: `kube-prometheus.yaml` and the rules of one cluster. folly's also holds its scrape targets and `grafana-dashboards/`.
- `clusters/<site>/monitoring-crds/` and `clusters/base/monitoring-crds/`: the Prometheus Operator CRDs. kube-prometheus-stack installs none.
- `clusters/folly/apps/k6/`: the k6 operator, CronJob and test script
- `clusters/folly/config/lab-topology.json`: the host and desktop addresses

## Related

- [Install Windows monitoring](../runbooks/install-windows-monitoring.md)
- [Apply a Kubernetes change](../runbooks/apply-a-kubernetes-change.md)
