---
title: Operate the Smiirl counter
description: Check the Smiirl counter, calibrate its drums, repair it when it does not show the value set on its page, and return it to Smiirl's cloud.
---

This runbook checks, calibrates and repairs the [Smiirl counter](../apps/smiirl.md), and returns it to Smiirl's cloud. A cell is the character for one drum: a digit, `a` for blank, or `b` for stripes.

> [!WARNING]
> This runbook changes counter settings and starts the NFS server on spore by hand. It is an exception to the GitOps rule because git cannot hold counter settings or start a stopped service.

## Before you start

- Get `kubectl` access to folly ([Get cluster admin access](get-cluster-admin-access.md)) and SSH access to [capsule](../hosts/capsule.md) and [spore](../hosts/spore.md).
- Reach the `iot` network from your shell and browser.
- Make sure `.agents/skills/unifi-network/unifi.sh` works ([Inspect the UniFi network](inspect-the-unifi-network.md)). If `unifi.fml.pulsifer.ca` does not resolve, set `UNIFI_HOST=https://<udm>` and `UNIFI_SSH_HOST=<udm>`, where `<udm>` is the first host in `FUTURE_CIDR` in `clusters/folly/config/lab-topology.json`.

## Check the counter

If the counter shows the wrong value, do this procedure.

1. Read the device state.

   ```bash
   curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq .device
   ```

   Result: `online` is `true` if the counter polled in the last 60 seconds. `lastSent` is the last cells sent. `lastStatus.wlan` is `<counter-ip>`.

2. Read the app log.

   ```bash
   kubectl --context folly -n smiirl logs deploy/smiirl --tail=50
   ```

   Result: A `cells <old> -> <new>` line for each change. `github:` and `daily:` lines report problems.

3. Read the Gateway address.

   ```bash
   GW=$(kubectl --context folly -n smiirl get gateway smiirl -o jsonpath='{.status.addresses[0].value}'); echo "$GW"
   ```

4. Make sure capsule and spore give the Gateway address for `api.smiirl.com`.

   ```bash
   for h in capsule spore; do ssh "$h.lolwtf.ca" getent hosts api.smiirl.com; done
   ```

5. Send the counter's internet check, `GET /number`, through the Gateway.

   ```bash
   curl -s -D - -H 'Host: api.smiirl.com' "http://$GW/number"
   ```

   Result: `content-length: 12` and the body `{"number":1}`.

6. Make sure the counter answers.

   ```bash
   curl -s --max-time 5 "http://<counter-ip>/cgi-bin/luci/smiirl/api/version"
   ```

   Result: The firmware version.

## Calibrate the drums

If every value shows a fixed offset, do this procedure.

> [!CAUTION]
> If a browser opens a counter page, the counter stops its polls until it restarts. If you stop early, power-cycle the counter.

1. Record the mode and cells.

   ```bash
   curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq -c '{mode, cells}'
   ```

2. Show stripes on all drums.

   ```bash
   curl -s -X PUT -d '{"cells":"bbbbb"}' https://smiirl.lolwtf.ca/api/number
   curl -s -X PUT -d '{"mode":"number"}' https://smiirl.lolwtf.ca/api/mode
   ```

3. Wait until the counter receives the stripes.

   ```bash
   until [ "$(curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq -r .device.lastSent)" = bbbbb ]; do sleep 5; done
   ```

4. Open `http://<counter-ip>/calibrate/index.html` in a browser.
5. On "WHAT DO YOU SEE?", select each box until it matches its drum, from left to right.
6. Select NEXT.

   Result: After 10 seconds, all drums turn to stripes.

7. On "CLICK ON THE DIGIT IF YOU SEE STRIPES", select each drum that shows stripes, then select NEXT.
8. Do step 7 again until the page shows "COUNTER IS REBOOTING".
9. Wait until the counter polls again.

   ```bash
   until curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq -e .device.online >/dev/null; do sleep 5; done
   ```

10. Set the cells from step 1.

    ```bash
    curl -s -X PUT -d '{"cells":"<cells>"}' https://smiirl.lolwtf.ca/api/number
    ```

11. If the mode from step 1 is not `number`, select it at `https://smiirl.lolwtf.ca`. The page calls `countdown` Timer and `countup` Since.
12. If a drum is one flap off, do this procedure again. A drum still off after two calibrations has a mechanical fault.

## Join the counter to Wi-Fi

If the counter is not a UniFi client, do this procedure.

1. Find the SSID of the `iot` Wi-Fi clients.

   ```bash
   .agents/skills/unifi-network/unifi.sh clients
   ```

   Result: The `WIFI/WIRED` column of the `iot` rows gives the SSID.

2. From a device on `SmiirlSetup`, the counter's own network, open `http://192.168.1.1`.
3. Complete the setup wizard with the SSID from step 1 and its password.
4. Do step 1 of [Check the counter](#check-the-counter).

   Result: Within a few minutes, `online` is `true`.

## Capture the counter's requests

If the setup wizard says "Counter does not have access to internet", do this procedure.

1. Find the MAC address of the counter, `<counter-mac>`.

   ```bash
   .agents/skills/unifi-network/unifi.sh find <counter-ip>
   ```

2. Capture the counter traffic on the UDM Pro for two minutes.

   ```bash
   .agents/skills/unifi-network/unifi.sh ssh \
     'timeout 120 tcpdump -nn -A -s0 -i br666 "ether host <counter-mac>"'
   ```

   Result: The reply to the internet check matches step 5 of [Check the counter](#check-the-counter).

## Start the NFS server on spore

If `/api/state` does not answer in 5 seconds, do this procedure.

1. Read the NFS registration on spore.

   ```bash
   ssh spore.lolwtf.ca rpcinfo -T tcp localhost nfs
   ```

   Result: `ready and waiting` if NFS runs, or `Program not registered` if it is stopped.

2. If NFS is stopped, start it.

   ```bash
   ssh spore.lolwtf.ca sudo systemctl start nfs-server.service
   ```

3. Make sure `/api/state` returns `200`.

   ```bash
   curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' https://smiirl.lolwtf.ca/api/state
   ```

## Return the counter to Smiirl's cloud

If the counter must use Smiirl's cloud again, do this procedure. The counter then needs a Smiirl account.

1. Remove `api.smiirl.com` from the `hosts` line in `nix/services/coredns-sinkhole.nix`. Keep the `counter` and `smiirl` names.
2. Merge the change through a pull request.
3. To apply it before the nightly upgrade, run the upgrade on capsule and spore.

   ```bash
   for h in capsule spore; do ssh "$h.lolwtf.ca" sudo systemctl start nixos-upgrade.service; done
   ```

4. Make sure step 4 of [Check the counter](#check-the-counter) does not show the Gateway address.
5. Power-cycle the counter.
6. After one minute, make sure `online` is `false`.

   ```bash
   curl -s --max-time 5 https://smiirl.lolwtf.ca/api/state | jq .device.online
   ```

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `nfs-server.service` does not start. | `/nfs/data` is not mounted. | Read `journalctl -b -u nfs-data.mount` on spore. |
| The Gateway has no address. | Cilium did not assign the address. | Read `kubectl --context folly -n smiirl describe gateway smiirl`. |
| capsule or spore gives another address for `api.smiirl.com`. | That host does not run `main`. | Run `sudo systemctl start nixos-upgrade.service` on that host. |
| `online` is `false`, and all checks pass. | A browser opened a counter page, or the counter cached an old DNS answer. | Power-cycle the counter. |
| `lastStatus` is `null`. | The counter has not reported since the app started. | Find `<counter-ip>` in `unifi.sh clients`. |

## Related

- [Smiirl counter](../apps/smiirl.md)
- [Deploy a NixOS host](deploy-a-nixos-host.md)
