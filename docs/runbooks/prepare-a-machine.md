---
title: Prepare a machine
description: Set a new folly machine's firmware and AMT address on its node port and enroll the lab's Secure Boot keys over PXE, before NetBox provisions it.
---

Use this runbook once for each new machine, before [Provision a node](provision-a-node.md). You set its firmware, read its serial and MAC, and enroll the lab's Secure Boot keys from the `folly netboot` menu.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the firmware settings happen at the machine.

## Before you start

- The machine has a TPM 2.0 and Intel AMT. The steps are for the HP EliteDesk 800 G5, the model of riptide.
- The machine is cabled to a node port, where it stays: each inventory node's `switch_port`, or `free_node_ports` in `terraform/network/unifi/folly/bootstrap.tf`. Every node port carries the Kubernetes network, where the machine netboots.
- You have a monitor and keyboard at the machine.
- The AMT password is in the 1Password item `AMT MEBx credentials`.

## Set the firmware

1. Connect the monitor and keyboard. Power the machine on and press F10.
2. Write down the serial number and the MAC address from the system information page.

> [!NOTE]
> The firmware's network update fails against HP's servers. An older BIOS can refuse the key enrollment: the 800 G2's 2.37 does, and 2.63 does not.

3. If the BIOS is older than HP's latest, update it from a FAT32 USB stick that the SoftPaq made.
4. Set the date and time to the current UTC time.
5. Turn off legacy support, and turn on UEFI network boot over IPv4.
6. Set the boot order to the NVMe disk first and IPv4 network boot second.
7. Set the power-loss behaviour to power on.
8. Turn on the TPM, and set it to clear at the next boot. The clear keeps the endorsement key (EK).

> [!NOTE]
> With Secure Boot on and no keys, HP reloads its factory keys at the next boot.

9. Turn off Secure Boot, and clear the Secure Boot keys. The firmware is then in Setup Mode.
10. Save, then press F1 to confirm the TPM clear.
11. At boot, press Ctrl+P to open MEBx. Set the AMT password, turn on AMT and network access, and set KVM user consent to none.

## Enroll the Secure Boot keys

1. Boot from IPv4 network boot. Select `enroll` in the `folly netboot` menu within 10 seconds.

   Result: iPXE boots the signed ISO, and its systemd-boot menu appears.

2. Select `Enroll Secure Boot Keys: auto`.

   Result: `Secure Boot keys successfully enrolled`, and the machine reboots.

3. Open the firmware setup, turn on Secure Boot, and power off the machine.

## Set AMT's address

AMT shares the node's NIC, and fleet-controller's Rufio `Machine` dials it at the node's own address. Talos sets that address statically, so AMT holds it statically too. Do this once the node has an address in NetBox: the stub's `--address`, or the one its binding allocates.

1. In MEBx, or in MeshCommander from the future network, turn off DHCP for AMT's wired IPv4.
2. Set the address to the node's NetBox address, shared with the host, with the prefix length of `K8S_NODE_CIDR` and the gateway `ROUTER_IP` from `clusters/folly/config/cluster-topology.json`.

   Result: AMT answers on port 16992 at the node's address.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| iPXE says that `sanboot` failed | The firmware cannot boot the ISO over HTTP | Write `/talos/folly/metal-amd64-secureboot.iso` from spore to a USB stick, and boot it |
| systemd-boot shows no enrollment message | The firmware is not in Setup Mode | Clear the Secure Boot keys again |
| `Selected boot image did not authenticate` | `db` lacks the lab's certificate | Turn off Secure Boot, clear the keys, enroll again, then turn on Secure Boot |
| The screen is black after the enrollment | An option ROM is not signed by a certificate in `db` | Clear the Secure Boot keys, and note the model |

## Related

- [Provision a node](provision-a-node.md)
- [Talos boot](../platform/nixos/talos-boot.md#netboot-images)
- [PKI](../platform/pki.md#talos-secure-boot-keys)
