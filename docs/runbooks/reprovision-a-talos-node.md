---
title: Reprovision a Talos node
description: Wipe a folly node that has Intel AMT and reinstall Talos through Tinkerbell, started by a pull request, with nobody at the machine.
---

Use this runbook to reinstall Talos on a folly node that has Intel AMT. A pull request adds a `Workflow`, and [Tinkerbell](../platform/nixos/tinkerbell.md#boot-path) power-cycles the node into HookOS, which wipes the system disk, and the node then netboots the signed Talos UKI. You then approve the node's enrollment. For a node without AMT, use [Enroll a Talos node](enroll-a-talos-node.md).

## Before you start

- The node is riptide or shale, and it has an entry in `clusters/folly/apps/talos-enroll/machine-inputs.json`.
- Its Rufio `Machine` is contactable:

  ```bash
  ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get machines.bmc.tinkerbell.org <node> -o jsonpath='{.status.conditions}'
  ```

- The firmware has PXE on, and its boot order has the system disk first and IPv4 PXE after it.
- Our Secure Boot keys are enrolled and Secure Boot is on, as on riptide and shale. The path loads only signed images, so it also runs with Secure Boot off.
- You can see the node's console in MeshCommander, or on riptide's PiKVM.
- You are on the tailnet as a login in `ENROLL_APPROVERS`, and you can read the Discord prompts.
- `<node>` is the host name, and `<addr>` is its entry in `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`.

> [!CAUTION]
> A UniFi client with a Virtual Network Override is held on that network on every switch port, ahead of the port's native network and MAC auth. riptide's and optiplex's overrides to the Kubernetes network stay in the controller after `network_id` left `terraform/network/unifi/folly/k8s.tf`, because the provider does not clear them. Clear the node's override in the controller before you start, or the node never reaches the bootstrap VLAN.

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

   Result: `PREPARING`, `PENDING`, then `RUNNING` through `wipe-disk`, `netboot-next` and `reboot`, then `SUCCESS`.

2. Watch the node's console.

   Result: HookOS prints `reprovision:` lines and reboots. iPXE downloads the Talos UKI, about 280 MB, and Talos shows a user code and a QR code.

3. Once HookOS runs, delete the node's `Node` object, so that the new install registers a new one. Before the wipe, the old kubelet registers it again.

   ```bash
   kubectl --context folly delete node <node>
   ```

   Result: `node "<node>" deleted`.

4. Make sure that netboot is off.

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

   Result: `<node> fetched its config`. Talos installs, then kexecs into the installed system without a firmware reboot.

4. Wait about a minute. The bootstrap lease lasts 60 seconds, so the node is expected to take its Kubernetes address once the lease runs out. If it still shows its bootstrap address, unplug its network cable for a few seconds.
5. Power-cycle the node, so that the firmware boots Talos from the disk.

   ```bash
   talosctl --nodes <addr> reboot --mode powercycle
   ```

   Result: the console shows Talos booting from the disk, not the firmware menu.

6. Make sure that the node is Ready, then uncordon it.

   ```bash
   kubectl --context folly get node <node>
   kubectl --context folly uncordon <node>
   ```

   Result: `Ready`, then `node/<node> uncordoned`.

7. Make sure that Secure Boot is in the expected state.

   ```bash
   talosctl --nodes <addr> get securitystate
   ```

   Result: `secureBoot: true` on a node that has our keys, and `false` on a node without them.

8. Restore the node's volumes, as [Restore a volume](restore-a-volume.md) describes.

## Clean up

1. Remove `reprovision-<node>.yaml` and its `resources` entry in a pull request, and merge it.

   Result: Flux deletes the `Workflow`.

## If something goes wrong

To run the `Workflow` again, rename it, for example to `reprovision-<node>-2`, and merge. Flux deletes the old one and creates the new one.

| Symptom | Cause | Action |
| --- | --- | --- |
| The `Workflow` stays `PREPARING` with `BootJobFailed` | Rufio cannot reach AMT | Read the `Machine`'s conditions, fix AMT, and run the `Workflow` again. |
| `BootJobFailed` with "no route to host" or a timeout after the port moved to bootstrap | AMT shares the node's MAC, so it follows the port to the bootstrap VLAN and takes a bootstrap lease. The `Machine` dials the node's Kubernetes address. | Find the AMT's bootstrap lease in UniFi. Suspend the `tinkerbell` Flux Kustomization, set the `Machine`'s `spec.connection.host` to that address, recreate the `Workflow` from `kubectl kustomize clusters/folly/tinkerbell`, then resume the Kustomization once it succeeds. |
| The `Workflow` stays `PENDING`, and the node boots its old Talos | The node PXE-booted off the bootstrap VLAN | Move the node to the bootstrap VLAN, and run the `Workflow` again. |
| The `Workflow` is `FAILED` | An action failed | Read the action's message in the `Workflow` on spore, and the HookOS console. |
| HP shows 3F0 Boot Device Not Found after HookOS | The firmware has no IPv4 network boot entry, so `netboot-next` set none | Boot `IPV4 Network` from the F9 menu. |
| MeshCommander cannot reach AMT after the move | AMT shares the node's MAC, so it moved to the bootstrap VLAN with a new address | Find the node's bootstrap lease in UniFi and connect from the `future` network, which the policy `future_to_bootstrap_amt` admits on TCP 16992–16995. On riptide, the PiKVM also works. |
| The enrollment fails | See [Enroll a Talos node](enroll-a-talos-node.md#if-something-goes-wrong) | Follow its table. |

## Related

- [Tinkerbell](../platform/nixos/tinkerbell.md)
- [Enroll a Talos node](enroll-a-talos-node.md)
- [Talos enrollment](../apps/talos-enroll.md)
- [Restore a volume](restore-a-volume.md)
