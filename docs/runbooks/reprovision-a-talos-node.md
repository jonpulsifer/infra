---
title: Reprovision a Talos node
description: Wipe a folly node that has Intel AMT and reinstall Talos through Tinkerbell, started by a pull request, with nobody at the machine.
---

Use this runbook to reinstall Talos on a folly node that has Intel AMT. A pull request adds a `Workflow`, and [Tinkerbell](../platform/nixos/tinkerbell.md#boot-path) power-cycles the node into HookOS, which wipes the system disk and boots the signed Talos UKI from it. You then approve the node's enrollment. For a node without AMT, use [Enroll a Talos node](enroll-a-talos-node.md).

## Before you start

- The node is riptide or shale, and it has an entry in `clusters/folly/apps/talos-enroll/machine-inputs.json`.
- Its Rufio `Machine` is contactable:

  ```bash
  ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get machines.bmc.tinkerbell.org <node> -o jsonpath='{.status.conditions}'
  ```

- The firmware has PXE on, and its boot order has the system disk first and IPv4 PXE after it.
- No node has our Secure Boot keys, and Secure Boot is off on riptide. The path loads only signed images, so it runs either way. Key enrollment goes first in this list once the keys exist.
- You can see the node's console in MeshCommander, or on riptide's PiKVM.
- You are on the tailnet as a login in `ENROLL_APPROVERS`, and you can read the Discord prompts.
- `<node>` is the host name, and `<addr>` is its entry in `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`.

> [!CAUTION]
> Smee answers only on the bootstrap VLAN, and on folly's switch a port that carries the bootstrap VLAN untagged passes none of the node's frames: no DHCP, no ARP, with or without MAC auth and with DHCP snooping off. The VLAN passes traffic only tagged, on spore's port. No reprovision reaches HookOS until the boot path moves off the bootstrap access VLAN.

## Back up and drain

> [!WARNING]
> The wipe destroys every local-path volume on the node. Velero copies only the volumes of a running pod with the annotation `backup.velero.io/backup-volumes`, so take the backup before the drain.

1. Take a Velero backup.

   ```bash
   velero backup create <node>-pre-reprovision --from-schedule daily --wait --kubecontext folly
   velero backup describe <node>-pre-reprovision --details --kubecontext folly
   ```

   Result: A `Pod Volume Backups` list with each volume on the node, in the phase `Completed`.

2. Drain the node.

   ```bash
   kubectl --context folly drain <node> --ignore-daemonsets --delete-emptydir-data
   ```

   Result: `node/<node> drained`.

3. Set `enrolled.<node>` to `"bootstrap"` in `terraform/network/unifi/folly/bootstrap.tf`, and apply it through Atlantis. The node moves at its next link-up.

## Start the reprovision

1. On a branch, create `clusters/folly/tinkerbell/reprovision-<node>.yaml`. A patch in `kustomization.yaml` adds the Template and boot options.

   ```yaml
   apiVersion: tinkerbell.org/v1alpha1
   kind: Workflow
   metadata:
     name: reprovision-<node>
   spec:
     hardwareRef: <node>
   ```

2. Add `reprovision-<node>.yaml` to `resources` in `clusters/folly/tinkerbell/kustomization.yaml`.
3. Open a pull request. Make sure that the `kustomize` check passes.

> [!WARNING]
> The merge powers the node off and wipes its system disk: META, STATE, EPHEMERAL, ETCD and the `data` volume.

4. Merge the pull request.
5. Make Flux apply it now.

   ```bash
   flux --context folly reconcile kustomization tinkerbell --with-source
   ```

   Result: `applied revision` with the merge commit.

## Watch the run

1. Watch the `Workflow`.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get workflow reprovision-<node> -w
   ```

   Result: `PREPARING`, `PENDING`, then `RUNNING` through `wipe-disk`, `stage-talos-uki` and `reboot`, then `SUCCESS`.

2. Watch the node's console.

   Result: HookOS prints `reprovision:` lines and reboots. The Talos UKI boots from the disk and shows a user code and a QR code.

3. Make sure that netboot is off.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get hardware <node> -o jsonpath='{.spec.interfaces[0].netboot.allowPXE}'
   ```

   Result: `false`.

## Approve and return the node

1. Read the user code on the node's console. Approve that code as the node.

   ```bash
   mise run enroll:approve <code> <node>
   ```

   Result: JSON with `"phase": "approved"` and `"mac_mismatch": false`.

2. Set `enrolled.<node>` to `"kubernetes"`, and apply it through Atlantis before the install reboot.
3. Wait for the Discord prompt to change.

   Result: `<node> fetched its config`. Talos installs and reboots from the disk.

4. If the node rebooted before the apply, power-cycle it from MeshCommander or the PiKVM.
5. Make sure that the node is Ready, then uncordon it.

   ```bash
   kubectl --context folly get node <node>
   kubectl --context folly uncordon <node>
   ```

   Result: `Ready`, then `node/<node> uncordoned`.

6. Make sure that Secure Boot is in the expected state.

   ```bash
   talosctl --nodes <addr> get securitystate
   ```

   Result: `secureBoot: true` on a node that has our keys, and `false` on a node without them.

7. Restore the node's volumes, as [Restore a volume](restore-a-volume.md) describes.

## Clean up

1. Remove `reprovision-<node>.yaml` and its `resources` entry in a pull request, and merge it.

   Result: Flux deletes the `Workflow`.

## If something goes wrong

To run the `Workflow` again, rename it, for example to `reprovision-<node>-2`, and merge. Flux deletes the old one and creates the new one.

| Symptom | Cause | Action |
| --- | --- | --- |
| The `Workflow` stays `PREPARING` with `BootJobFailed` | Rufio cannot reach AMT | Read the `Machine`'s conditions, fix AMT, and run the `Workflow` again. |
| The `Workflow` stays `PENDING`, and the node boots its old Talos | The node PXE-booted off the bootstrap VLAN, or Flux turned `allowPXE` off before the node fetched HookOS | Move the node to the bootstrap VLAN, and run the `Workflow` again. |
| The `Workflow` is `FAILED` | An action failed | Read the action's message in the `Workflow` on spore, and the HookOS console. |
| HP shows 3F0 Boot Device Not Found after HookOS | The firmware skipped the staged boot entry | Boot `Talos Linux UKI` from the F9 menu. |
| MeshCommander cannot reach AMT after the move | AMT shares the node's MAC, so it moved to the bootstrap VLAN with a new address | Find the node's bootstrap lease in UniFi and connect from the `future` network, which the policy `future_to_bootstrap_amt` admits on TCP 16992–16995. On riptide, the PiKVM also works. |
| The enrollment fails | See [Enroll a Talos node](enroll-a-talos-node.md#if-something-goes-wrong) | Follow its table. |

## Related

- [Tinkerbell](../platform/nixos/tinkerbell.md)
- [Enroll a Talos node](enroll-a-talos-node.md)
- [Talos enrollment](../apps/talos-enroll.md)
- [Restore a volume](restore-a-volume.md)
