---
title: Change the forge EEPROM
description: Change the boot settings in the EEPROM of forge, and keep its HTTP boot fallback to the rackpi5 image.
---

Use this runbook to change the boot order or the HTTP boot settings of [forge](../hosts/forge.md). forge's EEPROM boots from NVMe first and falls back to [rackpi5](../hosts/rackpi5.md), a signed RAM-boot image that spore serves over HTTP. The fallback is forge's only recovery path. [Netboot](../platform/nixos/netboot.md) describes it.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the EEPROM settings and the enrolled public key are outside git.

## Before you start

- Get SSH access to forge and [spore](../hosts/spore.md) as `jawn`.
- Reach `https://prom.lolwtf.ca`, folly's Prometheus.
- `<spore-ip>` is `SPORE_IP` in `clusters/folly/config/lab-topology.json`.

## Check the fallback

1. Make sure that the publisher and the artifact check on spore are active.

   ```bash
   ssh spore.lolwtf.ca systemctl is-active spore-native-boot-rackpi5.service spore-native-boot-artifact-check.timer
   ```

   Result: The command prints `active` two times.

2. Make sure that spore serves each boot file.

   ```bash
   curl -s https://prom.lolwtf.ca/api/v1/query --data-urlencode 'query=spore_native_boot_artifact_available{target="rackpi5"}' | jq -r '.data.result[] | .metric.artifact + " " + .value[1]'
   ```

   Result: Three lines, and each ends in `1`.

3. Read the live EEPROM settings.

   ```bash
   ssh forge.lolwtf.ca sudo rpi-eeprom-config
   ```

   Result: The settings, with `BOOT_ORDER`, `HTTP_HOST` and `HTTP_PATH`.

## Change the settings

> [!NOTE]
> `BOOT_ORDER` digits run right to left. `0xf1276` tries NVMe (6), HTTP (7), network (2) and SD (1), then restarts (f).

1. Open the EEPROM settings in an editor.

   ```bash
   ssh -t forge.lolwtf.ca sudo rpi-eeprom-config --edit
   ```

2. Change the settings. Keep `HTTP_HOST=<spore-ip>`, `HTTP_PATH=rackpi5-ram` and the digit 7 in `BOOT_ORDER`.
3. Save the file and close the editor.

   Result: The command stages the new EEPROM for the next reboot.

> [!CAUTION]
> A stock EEPROM image has no enrolled public key, so HTTP boot fails. If the staged image is a stock image, enrol the public half of spore's `/var/lib/pi-boot-sign/private.pem` before you reboot forge.

4. Reboot forge.

   ```bash
   ssh forge.lolwtf.ca sudo reboot
   ```

5. Do step 3 of [Check the fallback](#check-the-fallback).

   Result: The settings that you saved.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| forge boots rackpi5. | The NVMe did not boot. | Reach rackpi5 as [rackpi5](../hosts/rackpi5.md#reach) describes. Read the boot log of the NVMe system. |
| forge boots neither the NVMe nor rackpi5. | The EEPROM lost `HTTP_HOST`, `HTTP_PATH`, the digit 7 or the public key. | Connect a display to forge. Read the bootloader messages. |
| `SporeNativeBootArtifactUnavailable` fires. | spore does not serve a boot file. | Read [Netboot](../platform/nixos/netboot.md#alerts). |

## Related

- [Netboot](../platform/nixos/netboot.md)
- [forge](../hosts/forge.md)
- [Deploy a NixOS host](deploy-a-nixos-host.md)
