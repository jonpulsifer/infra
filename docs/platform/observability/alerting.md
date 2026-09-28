---
title: Alerting
description: How Alertmanager routes every alert to Discord, routes a critical offsite alert to the owner's phone, and who can post an alert.
---

Alertmanager in each cluster's [monitoring stack](../observability.md) routes every alert to Discord. On offsite it also routes a firing `critical` alert to [Switchboard](../../apps/switchboard.md), which rings the owner.

## Routes

The `discord` AlertmanagerConfig sends alerts to a Discord webhook from 1Password, except `Watchdog` and `InfoInhibitor`. Each alert carries its `cluster` label, repeats every 12 hours, and reports when it resolves. The `inhibit_rules` in `kube-prometheus.yaml` send an info alert only while a warning or critical alert fires in its namespace.

On offsite, the `switchboard` AlertmanagerConfig posts a firing `critical` alert to Switchboard and repeats it every 15 minutes, so a notification skipped for quiet hours or the cap is retried soon after. It is parked: offsite's `alertmanagerConfigSelector` names `discord` alone. A switchboard restart forgets what it rang, so a pod roll during an incident rings once more per firing critical alert.

## Who can post an alert

Alertmanager's API has no authentication. On offsite, its network policy admits Prometheus, Grafana, the API server, whose service proxy `mise run alerts` reads through, and the host-network pods on its node. The Rowbutt sandbox's egress excludes Alertmanager, but the sandbox is `cluster-admin` and root on the nodes, so it can post an alert on purpose ([How Rowbutt works](../../apps/mate/how-it-works.md#network)).

## Rules

- Keep `alertmanagerConfigSelector` and `alertmanagerConfigMatcherStrategy` in each `kube-prometheus.yaml`, or no alert reaches Discord.
- Add `switchboard` to offsite's `alertmanagerConfigSelector` only once the switchboard Deployment has a Ready pod, in its own merge, and drop it before parking the Deployment. Selected with no pod, every webhook fails and `AlertmanagerClusterFailedToSendAlerts`, a critical alert, rings the owner when the pod comes up.

## Where it lives

- `clusters/base/monitoring/alertmanager-discord.yaml`: the Discord route
- `clusters/<site>/monitoring/kube-prometheus.yaml`: the selector and the inhibit rules
- `clusters/offsite/monitoring/alertmanager-switchboard.yaml`: the switchboard receiver
- `clusters/offsite/monitoring/alertmanager-network-policy.yaml`: who reaches Alertmanager on offsite
