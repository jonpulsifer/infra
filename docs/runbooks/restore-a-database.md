---
title: Restore a database
description: Recover a Postgres database from its barman backups in Garage into a scratch CloudNativePG cluster, copy the data back, and run the restore drill.
---

Use this runbook to restore a Postgres database from the backups of the barman-cloud plugin, or to test the backups with the restore drill. [Backups](../platform/backups.md) describes the stores and the retention. The recovery makes a scratch cluster from a base backup and the WAL, and then copies the data into the live database. If the live `Cluster` is gone, follow [Recover a re-created database](recover-a-re-created-database.md) instead.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git holds no data, only the declaration of the database.

## Before you start

- Get `kubectl` access, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Install `kubectl-cnpg`, as [Operate Postgres](operate-postgres.md#before-you-start) describes.
- If Garage has lost the `cnpg` bucket, follow [Restore from the GCS copy](restore-from-the-gcs-copy.md) first.

`<site>` is `folly` or `offsite`. `<cluster>` is the CloudNativePG `Cluster`, and `<owner>` is the role that owns `<database>`.

## Recover the database

1. Read the backups of the database.

   ```bash
   kubectl get backup -n <namespace> --context <site>
   ```

   Result: A row for each backup, with the phase `completed`.

2. Write `recovery.yaml`. For a point in time, add `recoveryTarget.targetTime` under `bootstrap.recovery`.

   ```yaml
   apiVersion: postgresql.cnpg.io/v1
   kind: Cluster
   metadata:
     name: <cluster>-restore
     namespace: <namespace>
   spec:
     instances: 1
     storage:
       storageClass: local-path
       size: <size of the live volume>
     bootstrap:
       recovery:
         source: origin
         database: <database>
         owner: <owner>
     externalClusters:
       - name: origin
         plugin:
           name: barman-cloud.cloudnative-pg.io
           parameters:
             barmanObjectName: garage
             serverName: <cluster>
   ```

   `serverName` is the prefix the live `Cluster` archives under: its `backup.serverName`, or its name when that is empty.

3. Create the scratch cluster.

   ```bash
   kubectl create -f recovery.yaml --context <site>
   ```

4. Wait until the scratch cluster is ready.

   ```bash
   kubectl wait --for=condition=Ready cluster.postgresql.cnpg.io/<cluster>-restore -n <namespace> --timeout=30m --context <site>
   ```

   Result: `cluster.postgresql.cnpg.io/<cluster>-restore condition met`.

5. Count the rows of a table that the app always fills.

   ```bash
   kubectl cnpg psql <cluster>-restore -n <namespace> --context <site> -- -d <database> -At -c 'select count(*) from <table>'
   ```

   Result: A number above zero.

## Copy the data into the live database

1. Stop the writers of the database. Suspend the HelmRelease or Kustomization that applies the app, then scale the app to zero.

   ```bash
   flux suspend helmrelease <release> -n <namespace> --context <site>
   kubectl scale deployment <app> -n <namespace> --replicas 0 --context <site>
   ```

2. Find the primary pod of each cluster.

   ```bash
   kubectl cnpg status <cluster> -n <namespace> --context <site>
   kubectl cnpg status <cluster>-restore -n <namespace> --context <site>
   ```

   Result: The pod name on the `Primary instance` line of each.

3. Dump the scratch database to a local file.

   ```bash
   kubectl exec <restore-primary> -n <namespace> -c postgres --context <site> --      pg_dump -Fc -d <database> > restore.dump
   ```

   Result: A `restore.dump` file.

4. Restore the dump over the live database.

   ```bash
   kubectl exec -i <primary> -n <namespace> -c postgres --context <site> --      pg_restore --clean --if-exists --no-owner --role=<owner> -d <database> < restore.dump
   ```

   Result: No output.

5. Delete the scratch cluster, then resume the release. Flux scales the app back to its declared replicas.

   ```bash
   kubectl delete cluster.postgresql.cnpg.io/<cluster>-restore -n <namespace> --context <site>
   flux resume helmrelease <release> -n <namespace> --context <site>
   ```

## Run the restore drill

The `restore-drill` CronJob recovers the kthx database from offsite's Garage into a throwaway cluster. It fails unless the `sites` table of the `kthx` database has rows.

1. Start a drill.

   ```bash
   kubectl create job restore-drill-now --from=cronjob/restore-drill -n restore-drill --context offsite
   ```

   Result: `job.batch/restore-drill-now created`.

2. Read the result.

   ```bash
   kubectl logs job/restore-drill-now -c drill -n restore-drill --context offsite
   ```

   Result: `recovered kthx-db: <n> rows in kthx.sites`.

3. Delete the Job.

   ```bash
   kubectl delete job restore-drill-now -n restore-drill --context offsite
   ```

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `kubectl get backup` shows no `completed` backup. | The `ScheduledBackup` has not run, or Garage is unreachable. | Run `kubectl get scheduledbackup -n <namespace> --context <site>`. Read `kubectl cnpg status <cluster>` for the archive state. |
| The scratch cluster stays in `Setting up primary`. | The recovery pod cannot read the `garage` ObjectStore. | Read the logs of the `<cluster>-restore-1-full-recovery` pod. |
| `KubeJobFailed` fires for a `restore-drill` Job. | The last drill failed. | Read the logs of the `drill` container, and `kubectl get cluster -n restore-drill`. |

## Related

- [Backups](../platform/backups.md)
- [Recover a re-created database](recover-a-re-created-database.md)
- [Operate Postgres](operate-postgres.md)
- [Restore a volume](restore-a-volume.md)
- [Restore etcd](restore-etcd.md)
