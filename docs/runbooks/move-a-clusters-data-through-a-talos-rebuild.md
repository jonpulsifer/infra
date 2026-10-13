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

3. Stop the writers of each database. On folly, that is the `tronbyt` Deployment. On offsite, they are `kthx`, `mate`, `spindrift-web`, `spindrift-reconciler`, `prowler-api`, `prowler-worker`, `prowler-beat` and `clankerbanker-web`.

   ```bash
   kubectl --context folly -n tronbyt scale deploy/tronbyt --replicas 0
   ```

4. Take a last barman backup of each database, as [Recover a re-created database](recover-a-re-created-database.md#take-a-last-backup) describes. On offsite, `mate-db` has no archive: run its `mate-db-backup` CronJob once instead, and make sure that the dump reached `gs://homelab-ng-mate/backups/pg/`.

   ```bash
   kubectl --context offsite -n mate create job --from=cronjob/mate-db-backup mate-db-backup-pre-talos
   kubectl --context offsite -n mate wait --for=condition=complete job/mate-db-backup-pre-talos --timeout=10m
   ```
5. Record the kthx engine's workloads on the cluster. Neither Velero nor Flux recreates them, and the engine, which runs on offsite, reports drift but never re-converges it. In the kthx console, list each Deploy that is `LIVE` and each Datastore whose Target is on the Vessel for `<site>`. Then record the releases.

   ```bash
   kubectl --context <site> -n spindrift-apps get hr
   kubectl --context <site> -n spindrift-datastores get clusters.postgresql.cnpg.io,valkeyclusters.valkey.io
   ```

## Restore the data

1. Make sure that each database recovers, as [Check the recovery](recover-a-re-created-database.md#check-the-recovery) describes, including its base backup under the new prefix. Flux creates each `Cluster` with the recovery that the cutover pull request declares. On folly, that is `tronbyt` in `clusters/folly/apps/tronbyt/04-database.yaml`. On offsite, they are the `backup.recoverFrom` values of the `kthx`, `prowler` and `spindrift` releases in `clusters/offsite/apps/`. `mate-db` starts empty: restore the dump from step 4 of [Freeze the cluster](#freeze-the-cluster) with [Restore a database](restore-a-database.md), then sign in to ChatGPT again, because the dump leaves out `mate_credentials`.
2. Restore each volume from the backup in step 2 of [Freeze the cluster](#freeze-the-cluster), as [Restore a volume](restore-a-volume.md) describes.

> [!NOTE]
> Velero's namespace selection does not restore the `app-<name>` namespaces, and no runbook covers the recovery of an engine Datastore. The engine owns its namespaces and releases, so never create them by hand.

3. Recreate each Datastore from step 5 of [Freeze the cluster](#freeze-the-cluster) in the kthx console: detach and destroy the stale one, create it again under the same name on the same Vessel, and attach it to its App. Then request a Deploy of each `LIVE` build there. The engine does not do either by itself. Then make sure that the engine created its release.

   ```bash
   kubectl --context <site> -n spindrift-apps get hr
   ```

   Result: Each release from the freeze is `True`.

4. On offsite, recover the `clankerbanker` Datastore in `spindrift-datastores` from its barman archive.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The backup has no `Pod Volume Backups` entry for a volume. | The pod did not run during the backup, or it has no backup annotation. | Start the pod, then take the backup again. See [Restore a volume](restore-a-volume.md#if-something-goes-wrong). |
| The backup stays `InProgress` with a `Pod Volume Backup` in `New`, and `velero backup delete` reports `backup is still in progress`. | The pod sits on a node whose node agent is gone, and Velero processes a delete request against a running backup once, with that error. | Restart the `velero` Deployment, which fails the backup, force-delete the dead pod, run `velero backup delete` again, then take the backup again. |
| `kubectl cnpg backup` fails with `no backup section`. | The command used the default method. | Add `--method plugin --plugin-name barman-cloud.cloudnative-pg.io`. |
| `DROP DATABASE` fails with `other sessions using the database`. | The writer's connections outlive its pod. | Run `select pg_terminate_backend(pid) from pg_stat_activity where datname = '<database>'` first, or `DROP DATABASE <database> WITH (FORCE)`. |
| `kubectl cp` into a CloudNativePG pod fails. | The image has no `tar`. | Load a dump over stdin: `gunzip -c <dump> \| kubectl exec -i <pod> -c postgres -- psql -v ON_ERROR_STOP=1 -1 -d <database>`. |
| A `Cluster` stays in `Setting up primary`. | The recovery cannot read its archive. | Do the checks in [Recover a re-created database](recover-a-re-created-database.md#if-something-goes-wrong). |

## Related

- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Recover a re-created database](recover-a-re-created-database.md)
- [Restore a volume](restore-a-volume.md)
