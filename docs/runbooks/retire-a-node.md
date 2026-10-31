---
title: Retire a node
description: Drain a folly worker, back up its volumes, and set its NetBox device to decommissioning, so that fleetd wipes it, then remove its entry from the nodes file.
---

Use this runbook to take a worker out of folly for good. You drain the node and set its [NetBox](../platform/netbox.md) device to `decommissioning`. [fleetd](../apps/fleetd.md) then wipes the system disk and powers the node off, and sets the device to `offline`. A pull request then removes its entry from the nodes file, which deletes the device.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because NetBox holds each machine's lifecycle, and the drain and the `Node` deletion act on the cluster.

## Before you start

- You need the `folly` context with cluster admin, as [Get cluster admin access](get-cluster-admin-access.md) describes, and the `velero` CLI.
- You can sign in to NetBox at `https://capsule.<tailnet>`.
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

   Result: within two minutes, `last_workflow` names `retire-<node>-<unix seconds>`. When another run of the node is going, such as an install, fleetd first has the BMC power the machine off through the Rufio Job `stop-<run>`, and the journal then says `the retirement ends Workflow <run> (<action>) and starts retire-<node>-<unix seconds>: the BMC powered the machine off`. fleetd drops the config it rendered for the install.

2. Watch the `Workflow`.

   ```bash
   ssh spore.lolwtf.ca sudo kubectl --kubeconfig /etc/tinkerbell/kubeconfig -n tinkerbell get workflows -w
   ```

   Result: `RUNNING` through `wipe-disk`, `next-boot` and `reboot`, then `SUCCESS`. The node powers off. `SUCCESS` means the power-off started, so step 3 is how you know it happened.

3. Make sure that NetBox shows the device as `offline`.

   Result: the device's journal says that the node is offline and its Tinkerbell objects are gone.

4. Delete the node's `Node` object.

   ```bash
   kubectl --context folly delete node <node>
   ```

   Result: `node "<node>" deleted`.

## Drop the node from the nodes file

1. Make sure that the device is `offline` in NetBox.
2. On a branch, remove the node's entry from `clusters/folly/inventory/nodes.yaml`.
3. If `nix/hosts/spore.nix` pins an EK hash for `<node>`, remove it.
4. To keep the node's switch port a node port, add it to `free_node_ports` in `terraform/network/unifi/folly/bootstrap.tf`. A port that no block names keeps its last override.
5. Open a pull request. Comment `atlantis plan -d terraform/netbox/folly`, `atlantis plan -d terraform/network/unifi/folly` and `atlantis plan -d clusters/folly/talos`.

   Result: the plans delete the node's device, address and cable in NetBox, its DNS record, and its `talos_machine` if the Talos root still manages it.

6. Comment `atlantis apply`.
7. Deploy spore from `main`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.

## What each system does

| System | What happens to the node |
| --- | --- |
| UniFi | The apply deletes its DNS record, and its switch port keeps its Kubernetes override |
| SPIRE | spore drops its LDevID alias at the deploy, so no workload entry names it. fleetd renews no LDevID for a `decommissioning` or `offline` device, so the LDevID lapses at its expiry |
| Talos | The Talos root stops managing the node |
| Tinkerbell | fleetd deletes its `Hardware` and `Machine` |
| NetBox | The apply deletes the device with its history. To use the machine again, follow [Provision a node](provision-a-node.md) |

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| No `retire-` `Workflow` | The device has no primary MAC, `install_disk` or `install_disk_serial`, or fleetd is down | Read the device's journal, and `journalctl -u fleetd` on spore |
| The `Workflow` ends `FAILED` within seconds with `BootJobFailed`, and the `danger` journal line says `ended FAILED before any action ran: its BMC job netboot-<workflow> failed: <message>` | The BMC refused a power action or did not answer, so no action ran and nothing was wiped | Fix the BMC: the message is the BMC's answer, and `kubectl -n tinkerbell get machine <node> -o yaml` on spore shows whether Rufio reaches it. fleetd starts the retirement again at the time the line gives, 5 minutes after the first failure and twice as long after each one, up to 4 hours, while the device stays `decommissioning` |
| The journal says `the retirement waits for Workflow <run> (<action>): the BMC did not power the machine off` | The BMC refused the power-off that stops the run, so fleetd keeps the run: deleting it would not stop its action | Wait: the retirement starts on the pass after the run ends. Fix the BMC, or the retirement's own boot job fails the same way. Powering the machine off by hand ends the run at its global timeout |
| `wipe: no disk reports the serial`, or `<disk> is <name>, but the disk that reports <serial> is <other>` | The disk at `install_disk` is not the declared disk. Nothing was wiped | Read the machine's disks, and correct `disk` or `disk_serial` in the nodes file, or wipe the disk at the machine |
| The device stays `decommissioning` after a run that failed at an action | fleetd journals a failed retirement once and stops; it retries only a retirement that failed at its BMC job | Read the journal line, which names the action, and the action's output with `journalctl -u tinkerbell \| grep <address>` on spore. Wipe the disk at the machine, then set the status to `offline` |
| The journal says `the retirement waits for Workflow <run>` | The device has no BMC, so nothing can stop the run that is going | Power the machine off. The run ends at its global timeout, and the retirement starts on the pass after; power the machine on, and it network-boots |
| The device went back out of `decommissioning` mid-retirement | fleetd deletes the retirement when the device has a BMC and journals it; an action already running on the machine runs to its end, so the disk may be partly wiped | Set `desired_action` to `provision` to install the node again |

## Related

- [Provision a node](provision-a-node.md)
- [fleetd](../apps/fleetd.md)
- [Hardware inventory](../reference/inventory.md)
- [Identity](../platform/identity.md#lifecycle)
- [Restore a volume](restore-a-volume.md)
