---
title: Operate the Flame Boss exporter
description: Check a cook in the Flame Boss exporter, act on its alerts, change the alert thresholds, replace the Flame Boss token, read the first controller payloads and get a past cook's log.
---

This runbook checks and repairs the [Flame Boss exporter](../apps/flameboss.md), changes its alert thresholds, replaces its token and gets cook data. Use it when a cook does not show in Grafana or an alert fires.

> [!WARNING]
> This runbook restarts the exporter by hand. It is an exception to the GitOps rule because the exporter reads its token only when it starts.

## Before you start

- Get `kubectl` and `flux` access to folly ([Get cluster admin access](get-cluster-admin-access.md)).
- To replace the token, get the operator age key ([Manage SOPS secrets](manage-sops-secrets.md)) and a sign-in to `myflameboss.com`. Set the key path.

  ```bash
  export SOPS_AGE_KEY_FILE=~/.config/age/keys.txt
  ```

- Run the commands from the repository root. mise installs `kubectl`, `flux` and `sops`.

`<cook_id>` is the `cook_id` label of the `flameboss_cook` series.

## Check a cook

> [!NOTE]
> After a controller goes offline, its `flameboss_device_online` and `flameboss_device_server` series stay until the exporter restarts.

1. Forward the exporter port to your machine.

   ```bash
   kubectl --context folly -n monitoring port-forward deploy/flameboss 8080:8080 &
   ```

   Result: The command prints `Forwarding from 127.0.0.1:8080 -> 8080`.

2. Read the exporter series.

   ```bash
   curl -s localhost:8080/metrics | grep -E '^flameboss_(broker_connected|device|cook)'
   ```

   Result: `flameboss_broker_connected` is 1 for each Flame Boss server. `flameboss_cook_active` is 1 while readings arrive.

3. Read the exporter log.

   ```bash
   kubectl --context folly -n monitoring logs deploy/flameboss --tail=20
   ```

   Result: An `announced` line every 15 minutes, and a `device migrating` line when a controller moves to another server.

4. Stop the port forward.

   ```bash
   kill %1
   ```

## Change the alert thresholds

> [!NOTE]
> Flux owns the live `flameboss` PrometheusRule and restores it from git.

1. Edit the threshold in `clusters/folly/monitoring/flameboss-rules.yaml`.
2. Change the matching values in `clusters/folly/monitoring/flameboss_test.yaml`.
3. Run the rule checks.

   ```bash
   mise run k8s:check-rules
   ```

   Result: Each check prints `SUCCESS`.

4. Merge the change through a pull request.

## Replace the Flame Boss token

1. Sign in at `https://myflameboss.com/users/dev`. Copy the `T-<user_id>` username and the token.
2. Open the folly cluster secrets.

   ```bash
   sops clusters/folly/config/cluster-secrets.sops.yaml
   ```

3. Set `SECRET_FLAMEBOSS_USERNAME` to the username and `SECRET_FLAMEBOSS_PASSWORD` to the token. Save the file.
4. Merge the change through a pull request.
5. Apply the `cluster-secrets` Secret, then the `flameboss-credentials` Secret.

   ```bash
   flux --context folly reconcile kustomization config -n flux-system --with-source
   flux --context folly reconcile kustomization monitoring -n flux-system
   ```

   Result: Each command prints `applied revision refs/heads/main@sha1:<commit>`.

6. Make sure the Secret holds the new username.

   ```bash
   cmp -s <(kubectl --context folly -n monitoring get secret flameboss-credentials -o jsonpath='{.data.username}' | base64 -d) <(sops -d --extract '["stringData"]["SECRET_FLAMEBOSS_USERNAME"]' clusters/folly/config/cluster-secrets.sops.yaml) && echo match
   ```

   Result: The command prints `match`.

7. Restart the exporter.

   ```bash
   kubectl --context folly -n monitoring rollout restart deploy/flameboss
   ```

   Result: The command prints `deployment.apps/flameboss restarted`.

8. Do steps 1, 2 and 4 of [Check a cook](#check-a-cook).

   Result: `flameboss_broker_connected` is 1.

## Read the first controller payloads

Use this procedure to see the raw payload of a message whose format is not confirmed. After each start, the exporter logs the first payload of each message type in `evidence` in `apps/flameboss/relay.go`. It leaves out `wifi`, which can carry the Wi-Fi key.

1. Search the exporter log.

   ```bash
   kubectl --context folly -n monitoring logs deploy/flameboss | grep '"first uplink"'
   ```

   Result: One `first uplink` line for each of those types that the controller sent since the exporter started.

## Get a past cook

Flame Boss keeps each cook at a 3-second resolution. Anyone with the cook ID can download it.

1. Download the cook log.

   ```bash
   curl -s -o cook-<cook_id>.csv https://myflameboss.com/en/cooks/<cook_id>/raw
   ```

   Result: The file `cook-<cook_id>.csv` has the columns `time,set_temp,pit_temp,meat_temp1,meat_temp2,meat_temp3,duty_cycle`. Temperatures are in tenths of a degree Celsius. `duty_cycle` is in hundredths of a percent.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `FlameBossCookStarted` (info) fires. | A cook started less than 15 minutes ago. | No action. |
| `FlameBossPitBelowTarget` fires. | The pit reached the set temperature, then stayed more than 25 °F below it for 10 minutes. | Examine the coals and the intake. |
| `FlameBossFireStarving` fires. | The blower is at 99% or more, and the pit is more than 15 °F below the set temperature for 15 minutes. | Add fuel. Close the lid. |
| `FlameBossPitAboveTarget` fires. | The pit is more than 30 °F above the set temperature for 10 minutes. | Close the top vent and the lid. |
| `FlameBossPitProbeDisconnected` fires. | The pit probe is unplugged for 5 minutes. | Connect the pit probe. |
| `FlameBossMeatProbeAtWrapPoint` (info) fires. | A meat probe is at 165 °F or more. | Wrap the meat. Poultry is done. |
| `FlameBossMeatProbeAtTarget` or `FlameBossMeatDone` fires. | A meat probe is at 203 °F, or at the done temperature set on the controller. | Take the meat off the heat. |
| `FlameBossPitAlarm` fires. | The pit left the range of the controller's pit alarm. | Examine the fire. |
| `FlameBossLidOpen` fires. | The controller reports the lid open for 5 minutes. | Close the lid. |
| `FlameBossVentAdvice` (info) fires. | The controller advises closing the vent. | Close the top vent a little. |
| `FlameBossCookSilent` fires. | No reading for 10 minutes. | If the cook continues, examine the controller power and Wi-Fi. |
| `FlameBossCloudUnreachable` fires, or no `flameboss_broker_connected` series exists. | The exporter has no connection to a Flame Boss server. If the exporter cannot connect when it starts, it logs no error. | Make sure folly reaches `myflameboss.com:8883`. If it does, do [Replace the Flame Boss token](#replace-the-flame-boss-token). |
| `FlameBossExporterDown` fires. | Prometheus cannot scrape the exporter for 15 minutes. | Run `kubectl --context folly -n monitoring get pods -l app.kubernetes.io/name=flameboss`. |
| No `flameboss_device_server` series during a cook. | The Flame Boss cloud does not report the controller online. | Examine the controller power and Wi-Fi. |
| No `flameboss_cook` series, and `flameboss_messages_total` does not increase. | The controller sends no readings. | Make sure a cook runs on the controller. |

## Related

- [Flame Boss exporter](../apps/flameboss.md)
- [Apply a Kubernetes change](apply-a-kubernetes-change.md)
