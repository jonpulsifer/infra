---
title: Flame Boss exporter
description: A Go exporter on folly that reads barbecue cooks from Flame Boss's cloud into Prometheus, for a Grafana dashboard and cook alerts in Discord.
status: live
---

The Flame Boss is a barbecue controller. It reads a pit probe and three meat probes, and runs a blower fan to hold the pit at a set temperature. The controller sends its readings only to Flame Boss's cloud. The `flameboss` exporter on the folly [Kubernetes](../platform/kubernetes.md) cluster reads them from that cloud into Prometheus. The owner watches a cook on a Grafana dashboard and gets its alerts in Discord.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Dashboard | Flame Boss, at `https://grafana.lolwtf.ca/d/flameboss-cook` | Clients that route to folly's load-balancer range, with a Grafana sign-in |
| Alerts | Discord, through Alertmanager on folly | The owner's Discord channel |
| Metrics | `/metrics` on port `8080` of the `flameboss` Service in `monitoring` | Prometheus, or `kubectl port-forward` |
| Cook log | `https://myflameboss.com/en/cooks/<cook_id>` | Anyone with the cook ID, with no sign-in |

## Limits

- The exporter sends no commands. It cannot change the set temperature or silence an alarm on the controller.
- A cook's series exist while readings arrive. After 5 minutes without a reading, `flameboss_cook_active` is 0. After 30 minutes, the cook's series go away, so the dashboard is empty between cooks.
- The info alerts, `FlameBossCookStarted`, `FlameBossMeatProbeAtWrapPoint` and `FlameBossVentAdvice`, reach Discord only while a warning or critical alert fires in the `monitoring` namespace. At other times, the `InfoInhibitor` rule of the kube-prometheus-stack chart suppresses them.
- If the exporter cannot connect when it starts, it logs no error and exports no `flameboss_broker_connected` series. `FlameBossCloudUnreachable` then does not fire.

## How it works

The exporter signs in to `myflameboss.com:8883` with the account's `T-<user_id>` username and token. The Flame Boss cloud names the server that each online controller is on. The exporter connects to that server and follows the controller when it moves. `apps/flameboss/README.md` has the protocol and every metric.

The controller sends temperatures in tenths of a degree Celsius, whatever its display shows. `-32767` is an unplugged probe. Every exported temperature is in Fahrenheit.

Flux substitutes `SECRET_FLAMEBOSS_USERNAME` and `SECRET_FLAMEBOSS_PASSWORD` from `clusters/folly/config/cluster-secrets.sops.yaml` into the `flameboss-credentials` Secret.

## Operate

The rules watch the pit, the meat probes, the controller's alarms and the exporter. Their thresholds are in Fahrenheit, for a brisket or a pork butt. [Operate the Flame Boss exporter](../runbooks/operate-the-flame-boss-exporter.md) lists each alert and its action.

## Reference

- Source, protocol and metrics: `apps/flameboss/`
- Manifests: `clusters/folly/monitoring/flameboss.yaml`
- Alerts: `clusters/folly/monitoring/flameboss-rules.yaml`, tested by `clusters/folly/monitoring/flameboss_test.yaml`
- Dashboard: `clusters/folly/monitoring/grafana-dashboards/flameboss.json`
- Image: `ghcr.io/jonpulsifer/flameboss`
