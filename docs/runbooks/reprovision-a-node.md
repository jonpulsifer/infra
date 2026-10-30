---
title: Reprovision a node
description: Reinstall, attest again or wipe an installed folly node by setting its NetBox device's desired_action.
---

Use this runbook to run an installed folly node through [Provision a node](provision-a-node.md)'s path again. You set the device's `desired_action` in [NetBox](../platform/netbox.md), and [fleet-controller](../apps/fleet-controller.md) starts the run.

| `desired_action` | The run | After it |
| --- | --- | --- |
| `provision` | HookOS attests, the install action wipes the disk and runs the installer with the code in META, and the disk boots | The node fetches its config by the code, and the controller sets `active` |
| `attest` | Attests, and boots the installed disk | The status stays, and the node has a new LDevID |
| `wipe` | Wipes the system disk, with no attestation | The node stays in HookOS until a Workflow runs |

`provision` and `wipe` move the device back to `planned`, which the Talos root applies no config to, until the node fetches its config. `attest` leaves the status alone. A class that the controller does not render, such as the control plane, stays in HookOS after a `provision`.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because NetBox holds each machine's lifecycle.

## Before you start

- You need the `folly` context with cluster admin, and the `velero` CLI.
- You can sign in to NetBox at `https://capsule.<tailnet>`, and you can see the node's console.
- `<node>` is the host name.

> [!WARNING]
> `provision` and `wipe` erase every partition of the system disk: META, STATE, EPHEMERAL, ETCD and the `data` volume. Velero copies only the volumes of a running pod with the annotation `backup.velero.io/backup-volumes`, so take the backup before the drain.

> [!WARNING]
> optiplex is folly's only control-plane node. Its wipe destroys folly's etcd. Take a snapshot first, as [Restore etcd on Talos](restore-etcd-on-talos.md) describes.

## Run it

1. If the run wipes the disk, take a Velero backup.

   ```bash
   velero backup create <node>-pre-reprovision --from-schedule daily --wait --kubecontext folly
   velero backup describe <node>-pre-reprovision --details --kubecontext folly
   ```

   Result: a `Pod Volume Backups` list with each volume on the node, in the phase `Completed`.

2. Drain the node. Every run reboots it at least once.

   ```bash
   kubectl --context folly drain <node> --ignore-daemonsets --delete-emptydir-data
   ```

   Result: `node/<node> drained`.

3. In NetBox, set the device's `desired_action`.

   Result: within two minutes, `last_workflow` names `<action>-<node>-<unix seconds>`, and `desired_action` is `none`.

4. If the run wipes the disk, delete the node's `Node` object once HookOS runs. Before the wipe, the old kubelet registers it again.

   ```bash
   kubectl --context folly delete node <node>
   ```

5. Watch the run, as [Watch the run](provision-a-node.md#watch-the-run) describes. An `attest` run boots the installed disk after `attest: PASSED`. A `provision` run ends when NetBox shows `active`.
6. Make sure that the node is Ready, then uncordon it.

   ```bash
   kubectl --context folly get node <node>
   kubectl --context folly uncordon <node>
   ```

   Result: `Ready`, then `node/<node> uncordoned`.

7. If the run wiped the disk, restore the node's volumes, as [Restore a volume](restore-a-volume.md) describes.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The `Workflow` stays `PREPARING` with `BootJobFailed` | Rufio cannot reach the BMC | Read the `Machine`'s conditions, fix the BMC, and set `desired_action` again |
| A new `desired_action` starts nothing | A run of the device is unfinished | Wait for it. The controller records the request against the running `Workflow` |
| HP shows 3F0 Boot Device Not Found after HookOS | The firmware has no IPv4 network boot entry | Boot `IPV4 Network` from the F9 menu |
| `install: no install code` | The attest step wrote no code, because attest withheld it | Read the `attest.install` audit line in `journalctl -u talos-attest` on the anchor, then set `desired_action` again |
| The node polls its config URL and gets 404 | A STATE wipe on an installed node, because a served code is spent | Set `desired_action` to `provision`, which renders a new code |
| The console shows `Talos is already installed to disk but booted from another media` | META is on the disk | Set `desired_action` to `wipe` |
| The node fetched its config and is not Ready, and it has a bootstrap address | NetBox shows it `failed`, so its RADIUS user puts it on bootstrap | Read the device's status and its quarantine reason |
| A `failed` node stays on the Kubernetes network | A Virtual Network Override on its UniFi client comes before RADIUS | Clear the override in the UniFi controller |
| `attest: FAILED` with `ek-hash-mismatch` | A pin names another TPM, such as after a board swap | Compare `mise run attest:pending` with `ek_hash` in NetBox |
| Talos stops at `failed to read pcr signing public key` | Talos booted by kexec | Power-cycle the node |
| Another symptom of a run | See [Provision a node](provision-a-node.md#if-something-goes-wrong) | Follow its table |

## Related

- [Provision a node](provision-a-node.md)
- [Retire a node](retire-a-node.md)
- [fleet-controller](../apps/fleet-controller.md)
- [Restore a volume](restore-a-volume.md)
