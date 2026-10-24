---
title: Enroll a Talos node
description: Wipe a folly node's system disk, boot it from the network on the bootstrap VLAN, approve its enrollment, and return it to the Kubernetes VLAN.
---

Use this runbook to install Talos on riptide or optiplex with Secure Boot. The node boots the signed UKI from spore over UEFI HTTP boot, asks [Talos enrollment](../apps/talos-enroll.md) for its config, and installs once you approve it. For these nodes, it replaces the kexec path of [Install Talos on a node](install-talos-on-a-node.md).

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the disk wipe and the firmware settings happen at the machine.

## Before you start

- Our Secure Boot keys are enrolled on the node, its TPM or PTT is on, and HTTP boot is first in its boot order.
- `clusters/folly/apps/talos-enroll/machine-inputs.json` has the node. If it does not, run `mise run render-machine-inputs`, then commit and merge the result.
- You are on the tailnet as a login in `ENROLL_APPROVERS`, and you can read the Discord prompts.
- `<node>` is the host name, and `<addr>` is its entry in `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`.

> [!WARNING]
> optiplex is folly's only control-plane node. Its wipe destroys folly's etcd. Take a snapshot first, as [Restore etcd on Talos](restore-etcd-on-talos.md) describes.

## Wipe the full system disk

The HTTP boot UKI sets `talos.halt_if_installed=1`. Talos halts on any disk that has a META partition, sends no device request, and nothing reaches Discord. A wipe of STATE and EPHEMERAL leaves META. Wipe the full system disk before every enrollment.

> [!WARNING]
> The wipe erases every partition of the system disk: META, STATE, EPHEMERAL, ETCD and the `data` user volume.

1. If the node runs Talos and you can reach it, reset the full disk. Do not add `--system-labels-to-wipe`.

   ```bash
   talosctl --nodes <addr> reset --graceful=false --reboot
   ```

   Result: The node reboots, and the firmware moves to the next boot entry.

2. If you cannot reach the node, boot the Talos Secure Boot ISO at the machine and select `Reset system disk`.

## Set the clock

The node checks the server's certificate against its own clock. The bootstrap VLAN gives it no time source before it has a config.

1. Open the firmware setup: F10 on riptide, F2 on optiplex.
2. Make sure that the date and time are the current UTC time.

## Boot and approve

1. Set the node's RADIUS user to the bootstrap VLAN in `terraform/network/unifi/folly/`, and apply the change through Atlantis.
2. Power on the node.

   Result: The console shows a user code, and Discord shows a prompt with the code, UUID, MAC, serial and host name.

3. Make sure that the MAC and the serial in the prompt are this machine's.
4. Approve the code as the node.

   ```bash
   mise run enroll:approve <code> <node>
   ```

   Result: JSON with `"phase": "approved"` and `"mac_mismatch": false`.

5. Wait for the Discord prompt to change.

   Result: `<node> fetched its config`. Talos installs and reboots.

The prompt also links the approval page, where you select the node and approve from a phone.

## Return the node to the Kubernetes VLAN

1. Set the node's RADIUS user to the Kubernetes VLAN, and apply the change through Atlantis.
2. If the node rebooted before the apply, power-cycle it. The switch runs MAC auth again at link-up.
3. Make sure that the node is Ready.

   ```bash
   kubectl --context folly get node <node>
   ```

   Result: `Ready`.

4. Make sure that Secure Boot is on.

   ```bash
   talosctl --nodes <addr> get securitystate
   ```

   Result: `secureBoot: true`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The console shows `Talos is already installed to disk but booted from another media` | META is on the disk | Wipe the full system disk |
| The console shows a certificate error, such as `not yet valid` | The firmware clock is wrong | Set the clock, then reboot |
| A new code appears every 15 minutes | Each code lasts 15 minutes | Approve the newest code |
| Approval answers 400 with a list of nodes | `machine-inputs.json` lacks the node | Run `mise run render-machine-inputs`, then merge |
| Approval answers 500 | `talosctl` failed | Read `kubectl --context folly -n talos-enroll logs deploy/talos-enroll` |
| A denied machine gets 403 | The server refuses its UUID until it restarts | Run `kubectl --context folly -n talos-enroll rollout restart deploy/talos-enroll` |

## Related

- [Talos enrollment](../apps/talos-enroll.md)
- [Install Talos on a node](install-talos-on-a-node.md)
- [Restore etcd on Talos](restore-etcd-on-talos.md)
- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
