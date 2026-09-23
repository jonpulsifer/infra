---
title: Flame Boss exporter
description: "A Go service on folly that reads Flame Boss's cloud MQTT and exports barbecue cook telemetry to Prometheus."
---

Use this when a cook is not showing up in Grafana, an alert about the barbecue looks wrong, or the exporter cannot reach the Flame Boss cloud. The Flame Boss controller publishes to Flame Boss's own MQTT brokers, never to the lab, so `apps/flameboss` is a client of that cloud: it discovers each controller, follows it between servers, and exports its readings as Prometheus series. Everything the alerts and the dashboard read comes from there. The declaration is `clusters/folly/monitoring/flameboss.yaml`, the alerts are `clusters/folly/monitoring/flameboss-rules.yaml`, and the dashboard is `clusters/folly/monitoring/grafana-dashboards/flameboss.json`.

## Quick checks

Is a cook live, and what does the exporter think of it:

```bash
kubectl --context folly -n monitoring port-forward deploy/flameboss 8080:8080 &
curl -s localhost:8080/metrics | grep -E '^flameboss_(cook|pit|probe|blower|broker|device)'
```

`flameboss_cook_active 1` means readings are arriving. `flameboss_cook{cook_id="..."}` names the cook, which is also the id in `https://myflameboss.com/en/cooks/<cook_id>`.

The exporter's own log says which server the controller is on, one line per event:

```bash
kubectl --context folly -n monitoring logs deploy/flameboss
```

The Grafana dashboard is **Flame Boss** (`flameboss-cook`). It is empty between cooks by design — see below.

## How the data gets here

The controller is not pinned to a server. It connects to whichever Flame Boss server it lands on and it moves between them, and the published entry host is a load balancer in front of all of them. So the exporter announces itself on the entry connection (`user/<user_id>/send`, `{"name":"connected"}`) and reads the replies on `user/<user_id>/recv`: one naming the server its own connection landed on, then one per online device naming that device's server. A device on a server it already holds is served on that connection; anything else gets a new one.

Telemetry arrives on `flameboss/<device_id>/send/open` as `{"name":"temps","cook_id":…,"sec":…,"temps":[…],"set_temp":…,"blower":…}`. Subscriptions name that topic and `send/data` explicitly: the broker accepts a `send/#` wildcard and then delivers nothing on it, which looks exactly like a controller that is switched off.

**Every temperature on the wire is decidegrees Celsius**, whatever the controller's display is set to: `1212` is 121.2 °C, which is the 250 °F on the front panel. `-32767` is a probe that is not plugged in. `blower` is hundredths of a percent, so `10000` is a fan at full. The exporter converts once, and every series it exports is Fahrenheit.

Credentials are the `T-<user_id>` username and token from `https://myflameboss.com/users/dev`, kept as `SECRET_FLAMEBOSS_USERNAME` and `SECRET_FLAMEBOSS_PASSWORD` in `clusters/folly/config/cluster-secrets.sops.yaml` and substituted by Flux into the Secret the pod reads. The exporter takes the account id from the username rather than keeping a third value in step. See [Manage SOPS secrets](../runbooks/manage-sops-secrets.md) to read or rotate them.

Nothing is ever published to the controller. The exporter subscribes and announces; it sends no commands, so it cannot change a set temperature or silence an alarm.

## Why there is nothing to see between cooks

A cook's series exist only while the cook does. Five minutes without a reading drops `flameboss_cook_active` to 0, and half an hour without one retires the cook's series entirely. That is deliberate: a cold pit held at its last value would graph and alert as a live cook forever, and it is what makes `FlameBossCookSilent` resolve by itself once the barbecue is put away.

`flameboss_device_online` and the `flameboss_messages_total` counters describe the controller rather than the fire, so they outlive the cook.

## The alerts

`FlameBossCookStarted` (info) — readings are arriving and the pit has not settled yet. This is the "there is a cook" notification; it clears itself once the pit reaches its set temperature.

`FlameBossPitBelowTarget` (warning) — the pit held set earlier in this cook and has been more than 25 °F under it for ten minutes.

`FlameBossFireStarving` (warning) — fifteen minutes at a 100% duty cycle with the pit still under set. The controller has nothing left to give: the charcoal is spent, the fire has tunnelled, or the lid is open.

`FlameBossPitAboveTarget` (warning) — more than 30 °F over set for ten minutes. A controller can only slow a fire by starving it of air, so this is a damper left open or too much lit charcoal.

`FlameBossMeatProbeAtWrapPoint` (info, 165 °F) and `FlameBossMeatProbeAtTarget` (warning, 203 °F) — a meat probe crossing the usual wrap point and the usual pull point. These are one cook's numbers, not a law: edit the thresholds in `flameboss-rules.yaml` for what is actually on the grill.

`FlameBossPitProbeDisconnected` (warning) — the controller regulates from the pit probe, so without it there is no control loop.

`FlameBossCookSilent` (warning) — five minutes of nothing from a controller that was cooking. Either the cook ended and it was switched off, or it lost power or wifi mid-cook.

`FlameBossMeatDone` (warning), `FlameBossPitAlarm` (warning), `FlameBossLidOpen` (warning, five minutes) and `FlameBossVentAdvice` (info) — the controller's own alarms and events, so they fire at what is set on the controller. The meat alarm names the probe by the label the controller shows for it. They run beside the threshold alerts rather than replacing them until a real cook has shown these arrive live, not only in the burst a controller sends when it reconnects.

`FlameBossCloudUnreachable` and `FlameBossExporterDown` (warning) — the watching, rather than the cooking, is broken.

Delivery is the shared Discord receiver, so `info` arrives too — the stack is described on [Kubernetes](../platform/kubernetes.md).

## If a cook is running and Grafana is empty

Read the exporter's log first. `connected` with `entry=true` then `entry connection is on server` means the control plane answered; a `device` line means a controller was found.

No device line at all means the controller is offline as far as the cloud is concerned: it is off, or off the network. Check the front panel, then its Wi-Fi.

`FlameBossCloudUnreachable` with the pod running is a credential or egress problem. Confirm the credentials still work from a workstation by connecting to `myflameboss.com:8883` with the same username and token, and confirm folly still has egress.

A device line but no `flameboss_cook_*` series means the controller is connected and publishing nothing, which is a controller sitting idle rather than a fault.

## If the thresholds are wrong for this cook

Edit `clusters/folly/monitoring/flameboss-rules.yaml` and ship it through git like any other cluster change ([Apply a Kubernetes change](../runbooks/apply-a-kubernetes-change.md)). Do not patch the live PrometheusRule: Flux owns it and will put the old numbers back.

Validate before pushing — the alert unit tests are `clusters/folly/monitoring/flameboss_test.yaml`:

```bash
mise run k8s:check-rules
```

## Reading what the controller actually sends

The exporter logs the first payload of each controller message whose format is still unmeasured, once per pod, so after a cook the evidence is already in the log:

```bash
kubectl --context folly -n monitoring logs deploy/flameboss | grep '"first uplink"'
```

`wifi` is deliberately never logged; it carries the network's SSID and may carry its key.

## Historical cooks

Prometheus holds what it scraped; Flame Boss holds every cook in full at three-second resolution. `https://myflameboss.com/en/cooks/<cook_id>/raw` is that log as CSV (`time,set_temp,pit_temp,meat_temp1,meat_temp2,meat_temp3,duty_cycle`, same decidegree Celsius scale), which is the source to reach for when a cook needs to be studied after the fact rather than watched.
