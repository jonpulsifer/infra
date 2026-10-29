---
title: Retire a node
description: Drain a folly worker, back up its volumes, and set its NetBox device to decommissioning, so that fleet-controller wipes it and the exports drop it.
---

Use this runbook to take a worker out of folly for good. You drain the node and set its [NetBox](../platform/netbox.md) device to `decommissioning`. [fleet-controller](../apps/fleet-controller.md) then wipes the system disk and powers the node off, and sets the device to `offline`, which NetBox keeps for history. A pull request then drops the node from the inventory export and from `NODE_ADDRESSES`.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because NetBox holds each machine's lifecycle, and the drain and the `Node` deletion act on the cluster.

## Before you start

- You need the `folly` context with cluster admin, as [Get cluster admin access](get-cluster-admin-access.md) describes, and the `velero` CLI.
- You can sign in to NetBox at `https://capsule.<tailnet>`, and `mise run netbox:export` reaches it.
- The node is a worker with a BMC. optiplex is folly's only control-plane node, and this runbook does not retire it.
- `<node>` is the host name.

## Back up and drain

> [!WARNING]
> The retirement erases every partition of the system disk, with every local-path volume on it. Velero copies only the volumes of a running pod with the annotation `backup.velero.io/backup-volumes`, so take the backup before the drain.

1. Take a Velero backup.

   ```bash
   velero backup create <node>-pre-retire --from-schedule daily --wait --kubecontext folly
   velero backup describe <node>-pre-retire --details --kubecontext folly
   ```

   Result: a `Pod Volume Backups` list with each volume on the node, in the phase `Completed`.

2. Drain the node.

   ```bash
   kubectl --context folly drain <node> --ignore-daemonsets --delete-emptydir-data
   ```

   Result: `node/<node> drained`.

3. Restore each volume that the node held on another node, as [Restore a volume](restore-a-volume.md) describes. A pod whose volume is bound to the node stays `Pending` until then.

## Retire the device

1. In NetBox, set the device's status to `decommissioning`.

   Result: within two minutes, `last_workflow` names `retire-<node>-<unix seconds>`.

2. Watch the `Workflow`.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get workflows -w
   ```

   Result: `RUNNING` through `wipe-disk`, `next-boot` and `reboot`, then `SUCCESS`. The node powers off.

3. Make sure that NetBox shows the device as `offline`.

   Result: the device's journal says that the node is offline and its Tinkerbell objects are gone.

4. Delete the node's `Node` object.

   ```bash
   kubectl --context folly delete node <node>
   ```

   Result: `node "<node>" deleted`.

## Drop the node from git

1. On a branch, export the inventory.

   ```bash
   mise run netbox:export
   ```

   Result: `wrote clusters/folly/inventory/machines.yaml`, with no entry for `<node>`.

2. Remove `<node>` from `NODE_ADDRESSES` in `clusters/folly/config/cluster-topology.json`.
3. If `nix/hosts/spore.nix` pins an EK hash for `<node>`, remove it.
4. To keep MAC auth on the node's switch port, add the port to `spare_ports` in `terraform/network/unifi/folly/bootstrap.tf`. A port that no list names keeps its last override, an open Kubernetes port.
5. Make sure that the inventory and the addresses agree.

   ```bash
   mise run netbox:check
   ```

   Result: no output.

6. Open a pull request. Comment `atlantis plan -d terraform/network/unifi/folly` and `atlantis plan -d clusters/folly/talos`.

   Result: the plans delete the node's RADIUS user, its DNS record and its `talos_machine`.

7. Comment `atlantis apply`.
8. Deploy spore from `main`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.

## What each system does

| System | What happens to the node |
| --- | --- |
| UniFi | The apply deletes its RADIUS user, so the switch puts its MAC on the bootstrap fallback if it connects again |
| SPIRE | spore drops its LDevID alias at the deploy, so no workload entry names it. talos-attest renews no LDevID for a `decommissioning` or `offline` device, so the LDevID lapses at its expiry |
| Talos | The Talos root stops managing the node |
| Tinkerbell | fleet-controller deletes its `Hardware` and `Machine` |
| NetBox | The `offline` device keeps its history. To use the machine again, set its status to `planned`, then follow [Provision a node](provision-a-node.md) |

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| No `retire-` `Workflow` | The device has no primary MAC or `install_disk`, or fleet-controller is down | Read the device's journal, and `journalctl -u fleet-controller` on spore |
| The `Workflow` stays `PREPARING` with `BootJobFailed` | Rufio cannot reach the BMC | Read the `Machine`'s conditions, and fix the BMC |
| The device stays `decommissioning` after a failed run | The controller journals a failed retirement once and stops | Read the `Workflow`'s message. Wipe the disk at the machine, then set the status to `offline` |
| `netbox:check` prints `in NODE_ADDRESSES, not exported with an address` | `NODE_ADDRESSES` still names the node | Remove it |
| `NetboxExportDiffers` fires | The export pull request has not merged for two hours | Merge it |

## Related

- [Provision a node](provision-a-node.md)
- [fleet-controller](../apps/fleet-controller.md)
- [Hardware inventory](../reference/inventory.md)
- [Identity](../platform/identity.md#lifecycle)
- [Restore a volume](restore-a-volume.md)
