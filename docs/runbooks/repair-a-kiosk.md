---
title: Repair a kiosk
description: Check the Weather Hub kiosks on homepi4 and weatherpi4, restart them after an error page or a deploy, and start one that shows a blank screen.
---

This runbook checks and repairs the kiosks on [homepi4](../hosts/homepi4.md) and [weatherpi4](../hosts/weatherpi4.md). Use it when a kiosk shows an error page, a blank screen or an old hub. A kiosk is a Raspberry Pi 4 with a display that shows the [Weather Hub](../apps/hub.md) full-screen. The `cage-tty1` service runs Cage, a Wayland compositor for one app, and Cage runs Firefox in kiosk mode. Firefox opens `hubUrl` in `nix/lib/fleet.nix`.

> [!WARNING]
> This runbook starts and restarts the kiosk service by hand. It is an exception to the GitOps rule because NixOS does not restart the service after a deploy, and nothing restarts it after Firefox exits.

## Before you start

- Get SSH access to homepi4 and weatherpi4 as `jawn`.
- Set `<target>` to `homepi4.<tailnet>` or `weatherpi4.<tailnet>`. `<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`. homepi4 also answers at `homepi4-wifi.lolwtf.ca`.

## Check the kiosk

1. Read the state of the kiosk service.

   ```bash
   ssh <target> systemctl is-active cage-tty1.service
   ```

   Result: The command prints `active`.

2. Read the Firefox command line.

   ```bash
   ssh <target> pgrep -a firefox
   ```

   Result: The command prints a line that ends with `--kiosk --private-window https://hub.lolwtf.ca`.

3. Make sure the host reaches the hub.

   ```bash
   ssh <target> "curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 https://hub.lolwtf.ca"
   ```

   Result: The command prints `200`.

## Restart the kiosk

If the screen shows a Firefox error page, do this procedure.

> [!NOTE]
> Firefox loads the hub once, when Cage starts. If the hub does not answer then, Firefox shows its error page until the service restarts.

1. Do step 3 of [Check the kiosk](#check-the-kiosk). If the result is not `200`, see [If something goes wrong](#if-something-goes-wrong).
2. Restart the kiosk service.

   ```bash
   ssh <target> sudo systemctl restart cage-tty1.service
   ```

3. Do steps 1 and 2 of [Check the kiosk](#check-the-kiosk).

## Start a stopped kiosk

If the screen is blank or shows a text console, do this procedure. When Firefox exits, the kiosk service stops and does not restart.

1. Make sure the kiosk service starts at boot.

   ```bash
   ssh <target> systemctl is-enabled cage-tty1.service
   ```

   Result: The command prints `enabled`.

2. Make sure the host boots to the graphical target.

   ```bash
   ssh <target> readlink -f /etc/systemd/system/default.target
   ```

   Result: The command prints a path that ends with `graphical.target`.

3. Start the kiosk service.

   ```bash
   ssh <target> sudo systemctl start cage-tty1.service
   ```

4. Do steps 1 and 2 of [Check the kiosk](#check-the-kiosk).
5. If the service stops again, read its log.

   ```bash
   ssh <target> journalctl -u cage-tty1.service -n 50 --no-pager
   ```

   Result: The command prints the last 50 lines of the service log. Find the line where Firefox or Cage exits.

## Deploy a kiosk change

The Pi 4 hosts have no auto-upgrade. A change to `nix/services/kiosk.nix` or `nix/profiles/pi4-kiosk.nix` reaches a kiosk only when you deploy it.

1. Deploy the host with `switch`, as in [Deploy a NixOS host](deploy-a-nixos-host.md).

   Result: If the change touches the kiosk, the output lists `cage-tty1.service` after `NOT restarting the following changed units:`.

2. If the output lists `cage-tty1.service`, do step 2 of [Restart the kiosk](#restart-the-kiosk).

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| Step 3 of [Check the kiosk](#check-the-kiosk) prints a code other than `200`, or nothing. | The host has no network, or the hub is down. | Open `https://hub.lolwtf.ca` from another client. If it fails, run `kubectl --context offsite -n hub get pods`. If it works, examine the Wi-Fi of the host. |
| The kiosk shows the old hub after a hub deploy. | The page reloads for a new build at most once every 5 minutes. | Wait 5 minutes. If the kiosk still shows the old hub, do [Restart the kiosk](#restart-the-kiosk). |
| SSH to `homepi4.lolwtf.ca` fails or times out. | That name is the address of the Ethernet port, and homepi4 uses Wi-Fi. | Use the tailnet name or `homepi4-wifi.lolwtf.ca`. |
| weatherpi4 does not answer on a `lolwtf.ca` name. | No `lolwtf.ca` record names weatherpi4. | Use the tailnet name. |
| Step 1 or 2 of [Start a stopped kiosk](#start-a-stopped-kiosk) prints a different result. | The deployed configuration has no kiosk. | Deploy the host from `main`, as in [Deploy a NixOS host](deploy-a-nixos-host.md). |
| The kiosk service stops again after a start. | Firefox or Cage exits. | Read the log in step 5 of [Start a stopped kiosk](#start-a-stopped-kiosk). |

## Related

- [Weather Hub](../apps/hub.md)
- [Deploy a NixOS host](deploy-a-nixos-host.md)
