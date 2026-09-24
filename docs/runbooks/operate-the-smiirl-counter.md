---
title: Operate the Smiirl counter
description: Check the Smiirl counter, calibrate its drums, repair it when it does not show the value set on its page, and return it to Smiirl's cloud.
---

This runbook checks the [Smiirl counter](../apps/smiirl.md), calibrates its drums, repairs it, and returns it to Smiirl's cloud. If the counter does not show the value set on its web page, start at [Check the counter](#check-the-counter).

A cell is the character that the app sends for one drum. A cell is a digit, `a` for the blank flap, or `b` for the striped flap. The internet check is the `GET /number` request that the counter firmware sends after it joins Wi-Fi. The setup wizard is the set of web pages on the counter that configures its Wi-Fi. The `smiirl` Gateway is the Kubernetes resource that owns the app's load-balancer address.

> [!WARNING]
> This runbook changes live state by hand. It sets the Wi-Fi and the calibration of the counter, shows a test value on the drums, and starts the NFS server on spore. It is an exception to the GitOps rule because git cannot hold counter settings, and a stopped NFS server needs a manual start.

## Before you start

- Get `kubectl` access to the folly Kubernetes cluster. See [Get cluster admin access](get-cluster-admin-access.md).
- Make sure that you can SSH to [capsule](../hosts/capsule.md) and [spore](../hosts/spore.md), the DNS servers of the counter.
- Use a shell and a browser that can reach addresses on the `iot` network. Terraform declares no firewall policy into `iot`, so this access is live UniFi state.
- Make sure that `.agents/skills/unifi-network/unifi.sh` works. See [Inspect the UniFi network](inspect-the-unifi-network.md).
- If `unifi.fml.pulsifer.ca` does not resolve, set `UNIFI_HOST=https://<udm>` and `UNIFI_SSH_HOST=<udm>`. `<udm>` is the address of the UniFi Dream Machine Pro (UDM Pro), the folly router. It is the first host in `FUTURE_CIDR` in `clusters/folly/config/lab-topology.json`.

## Check the counter

If the counter does not show the value set on its web page, do this procedure.

1. Read the device state from the app.

   ```bash
   curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq .device
   ```

   Result: The device fields. If the counter polled in the last 60 seconds, `online` is `true`. `lastSent` is the cells that the counter received last. `lastStatus.wlan` is the address of the counter, `<counter-ip>`.

2. Read the app log.

   ```bash
   kubectl --context folly -n smiirl logs deploy/smiirl --tail=50
   ```

   Result: A `cells <old> -> <new>, showing <mode> <value>` line for each change from the page, the daily step or a GitHub count. Lines with `github:` or `daily:` report a problem with the GitHub count or the daily step.

3. Read the address of the `smiirl` Gateway.

   ```bash
   GW=$(kubectl --context folly -n smiirl get gateway smiirl -o jsonpath='{.status.addresses[0].value}'); echo "$GW"
   ```

   Result: One address.

4. Make sure that capsule and spore give the Gateway address for `api.smiirl.com`.

   ```bash
   for h in capsule spore; do ssh "$h.lolwtf.ca" getent hosts api.smiirl.com; done
   ```

   Result: Two lines. Each line starts with the Gateway address.

5. Send the internet check through the Gateway.

   ```bash
   curl -s -D - -H 'Host: api.smiirl.com' "http://$GW/number"
   ```

   Result: The headers include `content-length: 12`, and the body is `{"number":1}`.

6. Make sure that the web server on the counter answers.

   ```bash
   curl -s --max-time 5 "http://<counter-ip>/cgi-bin/luci/smiirl/api/version"
   ```

   Result: The counter replies with its firmware version.

7. If you want to test the drums without the app, send a test value to the counter.

   ```bash
   curl -s "http://<counter-ip>/cgi-bin/luci/smiirl/api/test/number?number=00042"
   ```

   Result: The command returns after about 10 seconds. The next poll from the counter replaces the value.

## Calibrate the drums

If every value shows a fixed offset, for example stripes where blanks belong, do this procedure.

> [!CAUTION]
> If a browser opens a page under `http://<counter-ip>/`, the counter stops its polls until it restarts. The `curl` commands in this runbook do not stop the polls. The calibration ends with a restart. If you stop the calibration before the end, power-cycle the counter.

1. Record the current mode and cells.

   ```bash
   curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq -c '{mode, cells}'
   ```

   Result: The mode and the cells, for example `{"mode":"clock","cells":"aa302"}`.

2. Set the stored cells to stripes on all drums.

   ```bash
   curl -s -X PUT -d '{"cells":"bbbbb"}' https://smiirl.lolwtf.ca/api/number
   ```

   Result: `{"cells":"bbbbb","number":null}`.

3. Set the app to `number` mode.

   ```bash
   curl -s -X PUT -d '{"mode":"number"}' https://smiirl.lolwtf.ca/api/mode
   ```

   Result: The mode fields of the app state, with `"display":"bbbbb"` and `"mode":"number"`.

4. Wait until the counter receives the stripes.

   ```bash
   until [ "$(curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq -r .device.lastSent)" = bbbbb ]; do sleep 5; done
   ```

   Result: The command stops when `lastSent` is `bbbbb`. The drums turn to stripes, or to a fixed offset from stripes.

5. Open `http://<counter-ip>/calibrate/index.html` in a browser.
6. On the "WHAT DO YOU SEE?" screen, select each box until it shows the same flap as its drum.

   The boxes are in the same order as the drums, from left to right. Each selection shows the next flap, in this order: the digits, the blank flap, then the stripes.

7. Select NEXT.
8. Wait 10 seconds.

   Result: All drums turn to stripes.

9. On the "CLICK ON THE DIGIT IF YOU SEE STRIPES" screen, select each drum that shows stripes.
10. Select NEXT.

    Result: If you selected all five drums, the page shows "COUNTER IS REBOOTING". If you did not, the counter turns the other drums again.

11. If the page does not show "COUNTER IS REBOOTING", do steps 9 and 10 again.
12. Wait until the counter polls the app again.

    ```bash
    until curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq -e .device.online >/dev/null; do sleep 5; done
    ```

    Result: The command stops when `online` is `true`.

13. Set the cells from step 1.

    ```bash
    curl -s -X PUT -d '{"cells":"<cells>"}' https://smiirl.lolwtf.ca/api/number
    ```

    Result: The cells from step 1 and the number that they show. If the cells do not show a number, `number` is `null`.

14. If the mode from step 1 is not `number`, select that mode on the web page at `https://smiirl.lolwtf.ca`.

    The page uses the stored settings of each mode. It shows `countdown` as Timer and `countup` as Since.

15. Make sure that each drum shows the correct flap.
16. If a drum shows the flap next to the correct flap, do this procedure again.

## Join the counter to Wi-Fi

If the counter is not a UniFi client, do this procedure. If the counter cannot join Wi-Fi, it opens its own Wi-Fi network, `SmiirlSetup`, and serves the setup wizard at `http://192.168.1.1`.

> [!NOTE]
> The counter must join the `iot` network, because DHCP on `iot` gives capsule and spore as DNS servers. Git declares no Wi-Fi network name (SSID) for `iot`. The SSID that puts a client on `iot` is live UniFi state.

1. Find the SSID of the Wi-Fi clients on `iot`.

   ```bash
   .agents/skills/unifi-network/unifi.sh clients
   ```

   Result: One row for each client. In the rows with `iot` in the `NETWORK` column, the `WIFI/WIRED` column gives the SSID.

2. Join `SmiirlSetup` from a phone or a laptop.
3. Open `http://192.168.1.1` in a browser.
4. In the setup wizard, select the SSID from step 1.
5. Enter the password of that SSID.
6. Do the other screens of the setup wizard.
7. Do step 1 of [Check the counter](#check-the-counter).

   Result: Within a few minutes, `online` is `true`.

## Capture the counter's requests

If the setup wizard says "Counter does not have access to internet", do this procedure.

> [!NOTE]
> The counter sends the internet check three times, one second apart. Then it opens `SmiirlSetup` and sends the check again one minute later. A two-minute capture holds at least one retry of the internet check. `br666` is the `iot` bridge on the UDM Pro. The `any` interface cannot filter by MAC address.

1. Find the MAC address of the counter.

   ```bash
   .agents/skills/unifi-network/unifi.sh find <counter-ip>
   ```

   Result: The row of the counter, with its MAC address, `<counter-mac>`.

2. Capture the traffic of the counter on the UDM Pro for two minutes.

   ```bash
   .agents/skills/unifi-network/unifi.sh ssh \
     'timeout 120 tcpdump -nn -A -s0 -i br666 "ether host <counter-mac>"'
   ```

   Result: Each request and reply as text. The reply to the internet check must be the same as in step 5 of [Check the counter](#check-the-counter).

## Start the NFS server on spore

If `/api/state` does not answer in 5 seconds, do this procedure.

> [!NOTE]
> The app state is on an NFS (network file system) share from spore, mounted `hard`. If spore stops NFS, the next write of the app does not return. The app then stops answering `/api/state` and the counter. The pod probes use `/healthz`, which reads no state, so the pod stays ready and its log stops.

1. Make sure that the app answers `/healthz`.

   ```bash
   curl -s --max-time 5 https://smiirl.lolwtf.ca/healthz
   ```

   Result: `ok`.

2. Read the NFS registration on spore.

   ```bash
   ssh spore.lolwtf.ca rpcinfo -T tcp localhost nfs
   ```

   Result: If NFS runs, the result ends with `ready and waiting`. If NFS is stopped, the result contains `Program not registered`.

3. If NFS is stopped, start it.

   ```bash
   ssh spore.lolwtf.ca sudo systemctl start nfs-server.service
   ```

4. Read the status code of `/api/state`.

   ```bash
   curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' https://smiirl.lolwtf.ca/api/state
   ```

   Result: `200`. The pod does not restart.

5. If the start in step 3 failed, read the status of `nfs-data-directories.service` on spore.

   ```bash
   ssh spore.lolwtf.ca systemctl status nfs-data-directories.service
   ```

   Result: The state of the unit. If `/nfs/data` is not mounted, the unit is failed.

## Return the counter to Smiirl's cloud

If the counter must use Smiirl's cloud again, do this procedure.

> [!NOTE]
> After this procedure, the counter needs a Smiirl account. The app continues to run, and the counter does not poll it. The `counter` and `smiirl` names on the `hosts` line keep the web page reachable without the WAN. The nightly upgrade applies `main` to capsule and spore. CoreDNS gives each answer from the `hosts` line a time to live (TTL) of 65535 seconds, about 18 hours. Until the counter restarts, it can keep the old answer.

1. Remove `api.smiirl.com` from the `hosts` line in `nix/services/coredns-sinkhole.nix`. Keep the `counter` and `smiirl` names on that line.
2. Commit the change on a branch.
3. Merge the branch through a pull request.
4. If you need the change before the nightly upgrade, run the upgrade on capsule.

   ```bash
   ssh capsule.lolwtf.ca sudo systemctl start nixos-upgrade.service
   ```

   Result: The command returns when the upgrade is complete.

5. If you ran step 4, run the upgrade on spore.

   ```bash
   ssh spore.lolwtf.ca sudo systemctl start nixos-upgrade.service
   ```

6. Do step 4 of [Check the counter](#check-the-counter).

   Result: The lines do not show the Gateway address.

7. Power-cycle the counter.
8. Wait one minute.
9. Read `online` from the app.

   ```bash
   curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq .device.online
   ```

   Result: `false`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `/api/state` does not answer in 5 seconds. | spore stopped NFS. | Do [Start the NFS server on spore](#start-the-nfs-server-on-spore). |
| `nfs-data-directories.service` failed on spore. | `/nfs/data` is not mounted. | Read the mount error with `ssh spore.lolwtf.ca journalctl -b -u nfs-data.mount`. |
| The `smiirl` Gateway has no address in step 3 of [Check the counter](#check-the-counter). | Cilium did not assign the address in `04-gateway.yaml` to the Gateway. | Read the conditions with `kubectl --context folly -n smiirl describe gateway smiirl`. Then see [Apply a Kubernetes change](apply-a-kubernetes-change.md). |
| The pod is not ready. | The app does not start. For example, it cannot read `number.json`. | Read the log with `kubectl --context folly -n smiirl logs deploy/smiirl --previous`. |
| `online` is `false`, and capsule or spore gives another address for `api.smiirl.com`. | That host does not run the config from `main`. | Run `sudo systemctl start nixos-upgrade.service` on that host. |
| `online` is `false`, and all checks pass. | A browser opened a page on the counter, or the counter has an old DNS answer. | Power-cycle the counter. |
| `device.lastStatus` is `null`. | The counter has not sent a status since the app started. | Find the counter in the `iot` rows of `.agents/skills/unifi-network/unifi.sh clients`. |
| The counter is not a UniFi client. | The counter is not on Wi-Fi. | Do [Join the counter to Wi-Fi](#join-the-counter-to-wi-fi). |
| The setup wizard says "Counter does not have access to internet". | The reply to the internet check is wrong. | Do [Capture the counter's requests](#capture-the-counters-requests). |
| Every value shows a fixed offset. | Values reached the drums too fast, or the calibration is wrong. | Do [Calibrate the drums](#calibrate-the-drums). |
| A drum shows the flap next to the correct flap after two calibrations. | The drum has a mechanical fault. | Inspect the drum mechanism. The app and the calibration cannot correct it. |

## Related

- [Smiirl counter](../apps/smiirl.md)
- [Inspect the UniFi network](inspect-the-unifi-network.md)
- [Deploy a NixOS host](deploy-a-nixos-host.md)
- [spore](../hosts/spore.md)
