---
title: Alerting
description: How Alertmanager routes alerts to Slack, rings the owner for critical offsite alerts, and who can post an alert.
---

Alertmanager in each cluster's [monitoring stack](../observability.md) routes alerts to Slack `#alerts`. On offsite it also routes a firing `critical` alert to [Switchboard](../../apps/switchboard.md), which rings the owner.

## Routes

The `slack` AlertmanagerConfig sends alerts with Rowbutt's Slack bot token from 1Password to `#alerts`, except `Watchdog` and `InfoInhibitor`. Each alert carries its `cluster` label, repeats every 12 hours, and reports when it resolves. Reply to an alert with `@Rowbutt` and a request to open an operator turn in that thread; without a mention, Rowbutt does not read an unowned thread. The `inhibit_rules` in `kube-prometheus.yaml` send an info alert only while a warning or critical alert fires in its namespace.

On offsite, the `switchboard` AlertmanagerConfig posts a firing `critical` alert to Switchboard and repeats it every 15 minutes, so a notification skipped for quiet hours or the cap is retried soon after. A switchboard restart forgets what it rang, so a pod roll during an incident rings once more per firing critical alert.

The offsite selector names `slack` and `switchboard`; folly's names `slack`. Mate's read-only webhook responder is disabled. Both sites use the same Slack route, so alerts can reach Slack even if the other cluster is down.

## Who can post an alert

Alertmanager's API has no authentication. On offsite, its network policy admits Prometheus, Grafana, the API server, whose service proxy `mise run alerts` reads through, and the host-network pods on its node. The Rowbutt sandbox's egress excludes Alertmanager, but the sandbox is `cluster-admin` and root on the nodes, so it can post an alert on purpose ([How Rowbutt works](../../apps/mate/how-it-works.md#network)).

## Rules

- Keep `alertmanagerConfigSelector` and `alertmanagerConfigMatcherStrategy` in each `kube-prometheus.yaml`, or no alert reaches Slack.
- Add `switchboard` to offsite's `alertmanagerConfigSelector` only once the switchboard Deployment has a Ready pod, in its own merge, and drop it before parking the Deployment. Selected with no pod, every webhook fails and `AlertmanagerClusterFailedToSendAlerts`, a critical alert, rings the owner when the pod comes up.
- Select `slack` only once Secret `alertmanager-slack` exists on each cluster. A missing token makes the operator reject the receiver. The Slack app must remain a member of `#alerts`.

## Where it lives

- `clusters/base/monitoring/alertmanager-slack.yaml`: the Slack route
- `clusters/<site>/monitoring/kube-prometheus.yaml`: the selector and the inhibit rules
- `clusters/offsite/monitoring/alertmanager-switchboard.yaml`: the switchboard receiver
- `clusters/offsite/monitoring/alertmanager-network-policy.yaml`: who reaches Alertmanager on offsite
