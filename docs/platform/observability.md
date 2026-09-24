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

The `discord` AlertmanagerConfig sends alerts to a Discord webhook from 1Password, except `Watchdog` and `InfoInhibitor`. Each alert carries its `cluster` label, repeats every 12 hours, and reports when it resolves. The `inhibit_rules` in `kube-prometheus.yaml` send an info alert only while a warning or critical alert fires in its namespace.

The in-cluster log streams carry `cluster` and a `job` of `kubernetes` or `systemd-journal`. The desktop streams carry `job="windows-eventlog"`, `host`, `channel` and `level`. Query logs in Grafana, or directly with the header `AccountID: 1`.

## Targets outside Kubernetes

folly scrapes the lab hosts and the Windows desktops through EndpointSlices. `PrometheusTargetMissing` fires when a lab host stops answering. A desktop that is off fires only the chart's `TargetDown` warning for job `windows-exporter`.

## k6

The k6 operator on folly runs each new TestRun, a k6 test, in a runner Job. Each day at 09:17 local time, the CronJob `k6-scenarios` recreates the `scenarios` TestRun. It checks the kthx console and two built apps, and pushes metrics to Prometheus. A failed threshold fails the runner Job and fires `KubeJobFailed`, but the TestRun still shows `finished`.

## Rules

- Label each ServiceMonitor and PrometheusRule, and each PodMonitor on folly, `release: prom-stack`, or Prometheus ignores it. offsite selects every PodMonitor.
- Keep `alertmanagerConfigSelector` and `alertmanagerConfigMatcherStrategy` in each `kube-prometheus.yaml`, or no alert reaches Discord.
- Route only `/insert` of VictoriaLogs out of the cluster. It has no authentication, so another path exposes every log.
- Run `mise run k8s:check-rules` after a rule change, or a broken rule fails CI.

## Where it lives

- `clusters/base/monitoring/`: the shared parts, Discord route, rules and dashboards
- `clusters/<site>/monitoring/`: `kube-prometheus.yaml` and the rules of one cluster. folly's also holds its scrape targets and `grafana-dashboards/`.
- `clusters/offsite/monitoring-crds/`: offsite's Prometheus Operator CRDs. folly's come from the chart.
- `clusters/folly/apps/k6/`: the k6 operator, CronJob and test script
- `clusters/folly/config/lab-topology.json`: the host and desktop addresses

## Related

- [Install Windows monitoring](../runbooks/install-windows-monitoring.md)
- [Adopt the folly Prometheus Operator CRDs](../runbooks/adopt-the-folly-prometheus-operator-crds.md)
- [Apply a Kubernetes change](../runbooks/apply-a-kubernetes-change.md)
