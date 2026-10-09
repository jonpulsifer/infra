---
title: Move a cluster's data through a Talos rebuild
description: Freeze a cluster's writers and take its last backups before a Talos rebuild, then restore its databases, volumes and kthx Apps on the new cluster.
---

Use this runbook during [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md). Freeze the old cluster before its control plane leaves NixOS, and restore the data after Flux applies `main` on the new cluster. Node-local data comes back only from a CloudNativePG or Velero backup.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because Flux is suspended on the old cluster and does not recreate kthx engine objects on the new one.

## Before you start

- You need `kubectl`, `flux` and `velero` with the kubeconfig context `<site>`.

`<site>` is `folly` or `offsite`.

## Freeze the cluster

> [!NOTE]
> A running Flux undoes the scale-down of the writers. The flux-operator can resume its own Kustomization, and the old cluster stops when its control plane leaves NixOS.

1. Stop Flux on the old cluster.

   ```bash
   flux --context <site> -n flux-system suspend kustomization --all
   ```

> [!NOTE]
> A Velero file-system backup skips the volume of a pod that is not running.

2. Take a last Velero backup.

   ```bash
   velero backup create <site>-pre-talos --from-schedule daily --wait --kubecontext <site>
   velero backup describe <site>-pre-talos --details --kubecontext <site>
   ```

   Result: A `Pod Volume Backups` list with each volume that you restore, in the phase `Completed`.

3. Stop the writers of each database. On folly, that is the `tronbyt` Deployment.

   ```bash
   kubectl --context folly -n tronbyt scale deploy/tronbyt --replicas 0
   ```

4. Take a last barman backup of each database, as [Recover a re-created database](recover-a-re-created-database.md#take-a-last-backup) describes.
5. Record the kthx engine's workloads on the cluster. Neither Velero nor Flux recreates them, and the engine, which runs on offsite, reports drift but never re-converges it. In the kthx console, list each Deploy that is `LIVE` and each Datastore whose Target is on the Vessel for `<site>`. Then record the releases.

   ```bash
   kubectl --context <site> -n spindrift-apps get hr
   kubectl --context <site> -n spindrift-datastores get cluster
   ```

## Restore the data

1. Make sure that each database recovers, as [Check the recovery](recover-a-re-created-database.md#check-the-recovery) describes, including its base backup under the new prefix. Flux creates each `Cluster` with the recovery that the cutover pull request declares. On folly, that is `tronbyt` in `clusters/folly/apps/tronbyt/04-database.yaml`.
2. Restore each volume from the backup in step 2 of [Freeze the cluster](#freeze-the-cluster), as [Restore a volume](restore-a-volume.md) describes.

> [!NOTE]
> Velero's namespace selection does not restore the `app-<name>` namespaces, and no runbook covers the recovery of an engine Datastore. The engine owns its namespaces and releases, so never create them by hand.

3. Recreate each Datastore from step 5 of [Freeze the cluster](#freeze-the-cluster) in the kthx console. Then request a Deploy of each `LIVE` build there. The engine does not do either by itself. Then make sure that the engine created its release.

   ```bash
   kubectl --context <site> -n spindrift-apps get hr
   ```

   Result: Each release from the freeze is `True`.

4. On offsite, recover the `clankerbanker` Datastore in `spindrift-datastores` from its barman archive.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The backup has no `Pod Volume Backups` entry for a volume. | The pod did not run during the backup, or it has no backup annotation. | Start the pod, then take the backup again. See [Restore a volume](restore-a-volume.md#if-something-goes-wrong). |
| A `Cluster` stays in `Setting up primary`. | The recovery cannot read its archive. | Do the checks in [Recover a re-created database](recover-a-re-created-database.md#if-something-goes-wrong). |

## Related

- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Recover a re-created database](recover-a-re-created-database.md)
- [Restore a volume](restore-a-volume.md)
