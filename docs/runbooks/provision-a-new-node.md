---
title: Provision a new node
description: Set up a new folly machine at the provisioning station, enroll the lab's Secure Boot keys over PXE, rack it, and enroll it as a Talos worker.
---

Use this runbook to add a new machine to folly as a Talos worker. You set its firmware at the provisioning station, where it also gets the lab's Secure Boot keys over PXE. Then you rack it, and it installs through [Talos enrollment](../apps/talos-enroll.md). The machine reports its own MAC, serial and UUID when it first asks to enroll, so you write nothing down.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the firmware settings and the enrollment code happen at the machine.

## Before you start

- The machine has a TPM 2.0 and Intel AMT. These steps are for the HP EliteDesk 800 G5, the model of riptide.
- Its name and rack port are in `intake_ports` in `terraform/network/unifi/folly/bootstrap.tf`, applied through Atlantis. The provisioning station's port is there too. Both carry the bootstrap VLAN.
- You can see the machine's screen at the provisioning station, and you are on the tailnet as a login in `ENROLL_APPROVERS`.
- The AMT password is in the 1Password item `AMT MEBx credentials`.

## Set the firmware

1. Connect the machine to the provisioning station's port and its monitor. Power it on and press F10.
2. Set the date and time to the current UTC time. The machine checks the enrollment server's certificate against its clock.
3. Turn off legacy support. Turn on UEFI network boot over IPv4. Set the boot order to the NVMe disk first and IPv4 network boot second, so an empty disk falls through to PXE.
4. Set the power-loss behaviour to power on.
5. Turn on the TPM and set it to clear at the next boot. The clear removes an earlier owner's settings and keeps the endorsement key and its certificate.
6. Turn Secure Boot off, and clear the Secure Boot keys. The firmware is then in Setup Mode. With Secure Boot on, HP reloads its factory keys at the next boot instead.
7. Save, then confirm the TPM clear with F1.
8. Press Ctrl+P at boot to open MEBx. Set the AMT password, turn on AMT and network access, and set the KVM user consent to none.

## Enroll the Secure Boot keys

1. Boot from IPv4 network boot. The signed iPXE shows the `folly netboot` menu.
2. Select `enroll` within 10 seconds.

   Result: iPXE boots the signed ISO from spore. Its systemd-boot prints `Enrolling secure boot keys from directory: \loader\keys\auto` and `Secure Boot keys successfully enrolled`, then reboots.

3. Open the firmware setup and turn Secure Boot on.
4. Power off the machine.

## Rack and enroll

1. Connect the machine to its rack port and power it on.

   Result: the disk is empty, so the firmware boots from the network. The `install` item starts after 10 seconds, and Talos shows a user code.

2. Read the machine's MAC, serial and UUID from talos-enroll's `device code issued` log line.

   ```bash
   kubectl --context folly -n talos-enroll logs deploy/talos-enroll | grep 'device code issued'
   ```

3. In one pull request, declare the node:
   - its MAC under `k8s` in `terraform/network/unifi/folly/clients.yaml`
   - its address in `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`
   - a `neighbor <address> peer-group HOMELAB` line in `terraform/network/unifi/folly/bgp-folly.conf`
   - its entry in `nodes` in `clusters/folly/talos/talos.tf` with `enrolling = true`, and its name in `tpm_nodes`
   - its move from `intake_ports` to `mab_ports` and `enrolled` (as `"bootstrap"`) in `bootstrap.tf`
   - the result of `mise run render-machine-inputs`

4. Apply the pull request through Atlantis.
5. Read the user code on the machine's screen, or on its AMT console. Approve that code as the node. If the code expired, power-cycle the machine for a new one.

   ```bash
   mise run enroll:approve <code> <node>
   ```

   Result: JSON with `"phase": "approved"` and `"mac_mismatch": false`. Talos installs and reboots through the firmware.

6. Set `enrolled.<node>` to `"kubernetes"`, and apply it through Atlantis. Power-cycle the node, so that the switch applies the VLAN at link-up.
7. In a pull request, remove `enrolling = true` and add the node to `encrypted_nodes` in `talos.tf`. Apply it through Atlantis.
8. Make sure that the node is Ready and that Secure Boot is on.

   ```bash
   kubectl --context folly get node <node>
   talosctl --context folly --nodes <address> get securitystate
   ```

9. Admit the node's TPM to SPIRE, as [Add a TPM node to SPIRE](add-a-tpm-node-to-spire.md) describes.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| iPXE says `sanboot` failed. | The firmware cannot boot the ISO over HTTP. | Write the ISO from spore's `/talos/folly/metal-amd64-secureboot.iso` to a USB stick and boot it. |
| systemd-boot shows no enrollment message. | The firmware is not in Setup Mode. | Clear the Secure Boot keys again. |
| The firmware says `Selected boot image did not authenticate`, or skips the disk and PXE. | Its `db` lacks the lab's certificate, or holds only HP's factory keys. | Turn Secure Boot off, clear the keys, enroll again, then turn it on. The lab's signing keys are RSA-2048, the size HP firmware verifies. |
| The screen is black after enrollment. | An option ROM is not signed by a certificate in `db`. | Clear the Secure Boot keys to boot without them, and note the model. `db` already holds Microsoft's option ROM and UEFI CAs. |
| Talos stops at `failed to read pcr signing public key`. | Talos booted by kexec, not through the firmware. | Power-cycle the node. |
| The enrollment fails. | See [Enroll a Talos node](enroll-a-talos-node.md#if-something-goes-wrong). | Follow its table. |

## Related

- [Enroll a Talos node](enroll-a-talos-node.md)
- [Talos boot](../platform/nixos/talos-boot.md)
- [Talos enrollment](../apps/talos-enroll.md)
