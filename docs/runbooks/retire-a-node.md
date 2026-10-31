---
title: Retire a node
description: Drain a folly worker, back up its volumes, and set its NetBox device to decommissioning, so that fleetd wipes it, then remove its entry from the nodes file.
---

Use this runbook to take a worker out of folly for good. You drain the node and set its [NetBox](../platform/netbox.md) device to `decommissioning`. [fleetd](../apps/fleetd.md) then wipes and erases the whole system disk and powers the node off, deletes its `Node`, its kubelet's CSRs and its bootstrap token, and sets the device to `offline`. A pull request then removes its entry from the nodes file, which deletes the device.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because NetBox holds each machine's lifecycle, and the drain acts on the cluster.

## Before you start

- You need the `folly` context with cluster admin, as [Get cluster admin access](get-cluster-admin-access.md) describes, and the `velero` CLI.
- You can sign in to NetBox at `https://capsule.<tailnet>`.
- The node is a worker with a BMC. optiplex is folly's only control-plane node, and this runbook does not retire it.
- `<node>` is the host name.
- Retire one node at a time. spore's SPIRE applier withdraws at most one node a run and refuses a run that would withdraw more. To retire several at once, first name each one in `/var/lib/spire-fleet-entries/withdraw` on spore, as [Identity](../platform/identity.md#fleetd-entries) describes.

## Back up and drain

> [!WARNING]
> The retirement erases the whole system disk, with every local-path volume on it, and the erase cannot be undone. Velero copies only the volumes of a running pod with the annotation `backup.velero.io/backup-volumes`, so take the backup before the drain.

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

   Result: `RUNNING` through `wipe-disk`, `next-boot` and `reboot`, then `SUCCESS`. `wipe-disk` clears the signatures and then erases the whole disk, so it runs longer than a wipe: an NVMe sanitize or format takes seconds to minutes, a discard seconds, and a zeroing as long as the disk takes to write, up to the action's 900 second limit.

3. Make sure that NetBox shows the device as `offline`.

   Result: the device's journal says that fleetd cordoned and drained the node and deleted its `Node`, the CSRs of its kubelet and its bootstrap token, and that the device is offline and its Tinkerbell objects are gone.

4. Make sure that the cluster holds no `Node` and no bootstrap token for the node.

   ```bash
   kubectl --context folly get node <node>
   kubectl --context folly -n kube-system get secrets -l lolwtf.ca/node=<node>
   ```

   Result: `Error from server (NotFound): nodes "<node>" not found`, and `No resources found in kube-system namespace.`

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
| SPIRE | At `decommissioning`, fleetd lists the node as revoked, and the applier on spore bans its agents, by LDevID or EK hash, within minutes. A banned agent cannot attest again, and SPIRE has no other revocation of an LDevID. The applier deletes the node's `fleet-*` aliases, so no workload entry names it. fleetd renews no LDevID for a `decommissioning` or `offline` device, so the LDevID lapses at its expiry |
| Kubernetes | fleetd deletes its `Node`, its kubelet's CSRs and its bootstrap token. A disk image from before the wipe still holds the kubelet's client certificate, which nothing revokes |
| Talos | The Talos root stops managing the node |
| Tinkerbell | fleetd deletes its `Hardware` and `Machine` |
| fleetd attest | fleetd marks its record `retired` before it sets the device `offline`. The record stays for audit, serves no LDevID even while NetBox is down, and leaves the expiry metrics |
| Disk | The whole disk is erased, the `data` volume included. [What the erase guarantees](#what-the-erase-guarantees) says how |
| NetBox | The apply deletes the device with its history. To use the machine again, follow [Provision a node](provision-a-node.md) |

## What the erase guarantees

`wipe-disk` writes random canary blocks at 16 offsets across the disk and at three offsets in each partition of 64 MiB or more, all past the first 16 MiB. It runs one method, then reads the canaries back. A method counts only when every canary reads differently. Otherwise the next method runs, and the action fails when none passes. Zeroing runs in 64 MiB chunks and stops between chunks at the deadline or on a stop request.

| Bus | Methods, in order | What it guarantees |
| --- | --- | --- |
| NVMe | `nvme sanitize` (crypto erase, else block erase) when the controller reports it, then `nvme format` with crypto or user data erase in the namespace's own LBA format, then the methods below | A sanitize or a format erase is the controller's own erase, which covers the whole drive. Check the controller with `nvme id-ctrl <disk> -H` for `sanicap` and `fna` |
| SATA and virtio | Secure discard where the kernel offers it, then discard, then zeroing | A discard that passes the canary check made the sampled blocks read differently. It is not a sanitize: TRIM only advises the drive, and the flash keeps the data until garbage collection. Only a zeroing that finishes is verified overwrite |

A disk that ignores discard and is too large to zero before the deadline fails the action. The free and used regions of the `data` volume are unknown to `wipe-disk`, so a partial zeroing proves nothing. SATA security erase is not used: firmware usually freezes it, and an interrupted erase leaves the drive locked.

The `data` volume is not encrypted, so only the erase destroys it. Encrypting it with a TPM-sealed key, as STATE and EPHEMERAL are, would let the loss of the key erase it too. That change belongs in the node's Talos configuration and needs each node reinstalled.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| No `retire-` `Workflow` | The device has no primary MAC, `install_disk` or `install_disk_serial`, or fleetd is down | Read the device's journal, and `journalctl -u fleetd` on spore |
| The `Workflow` ends `FAILED` within seconds with `BootJobFailed`, and the `danger` journal line says `ended FAILED before any action ran: its BMC job netboot-<workflow> failed: <message>` | The BMC refused a power action or did not answer, so no action ran and nothing was wiped | Fix the BMC: the message is the BMC's answer, and `kubectl -n tinkerbell get machine <node> -o yaml` on spore shows whether Rufio reaches it. fleetd starts the retirement again at the time the line gives, 5 minutes after the first failure and twice as long after each one, up to 4 hours, while the device stays `decommissioning` |
| The journal says `the retirement waits for Workflow <run> (<action>): the BMC did not power the machine off` | The BMC refused the power-off that stops the run, so fleetd keeps the run: deleting it would not stop its action | Wait: the retirement starts on the pass after the run ends. Fix the BMC, or the retirement's own boot job fails the same way. Powering the machine off by hand ends the run at its global timeout |
| `wipe: no disk reports the serial`, or `<disk> is <name>, but the disk that reports <serial> is <other>` | The disk at `install_disk` is not the declared disk. Nothing was wiped | Read the machine's disks, and correct `disk` or `disk_serial` in the nodes file, or wipe the disk at the machine |
| `wipe: <method> ran, but the canary blocks were not erased`, `wipe: zeroed <n> of <m> MiB before the deadline`, or `wipe: <disk> could not be erased` | No method erased the disk within the action's time, for example a disk that ignores discard and is too large to zero in about 13 minutes. The signatures are wiped and the disk is partly erased | Erase the disk at the machine, then set the status to `offline` |
| The device stays `decommissioning` after a run that failed at an action | fleetd journals a failed retirement once and stops; it retries only a retirement that failed at its BMC job | Read the journal line, which names the action, and the action's output with `journalctl -u tinkerbell \| grep <address>` on spore. Wipe the disk at the machine, then set the status to `offline`. fleetd removes from the cluster only a node its retirement wiped, so run `kubectl --context folly delete node <node>` and `kubectl --context folly -n kube-system delete secrets -l lolwtf.ca/node=<node>` |
| The `Workflow` is `SUCCESS`, the device stays `decommissioning`, and the journal says `could not take <node> out of the cluster` | folly's API does not answer, or it refuses fleetd's account, whose token is `fleetd/folly-cordon-token` in `nix/secrets/spore.sops.yaml`. The disk is wiped | Read the error in the line. Each pass tries again, and the device goes `offline` once folly's API answers |
| The journal says `the retirement waits until <time> for PodDisruptionBudgets to allow evicting <pods>` | A PodDisruptionBudget refuses an eviction, as when its other pods are not ready | Wait: at the time the line gives, fleetd deletes the `Node` anyway, which removes the pods |
| The journal says `the retirement waits for Workflow <run>` | The device has no BMC, so nothing can stop the run that is going | Power the machine off. The run ends at its global timeout, and the retirement starts on the pass after; power the machine on, and it network-boots |
| The device went back out of `decommissioning` mid-retirement | fleetd has the BMC power the machine off, which stops the wipe, then deletes the retirement and journals it. The disk may be partly wiped | Set `desired_action` to `provision` to install the node again |
| The journal says `the cancellation could not stop the retirement Workflow <run>` or `the cancellation cannot stop the retirement` | The BMC refused the power-off, or the device has no BMC, so the retirement goes on and wipes the disk | Power the machine off by hand. The retirement then ends at its global timeout, and a new `desired_action` starts after it |

## Related

- [Provision a node](provision-a-node.md)
- [fleetd](../apps/fleetd.md)
- [Hardware inventory](../reference/inventory.md)
- [Identity](../platform/identity.md#lifecycle)
- [Restore a volume](restore-a-volume.md)
