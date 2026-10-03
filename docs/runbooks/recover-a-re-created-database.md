---
title: Recover a re-created database
description: Bring a Postgres database back from its barman backups when its CloudNativePG Cluster is created again under the same name, such as after a Kubernetes cluster rebuild.
---

Use this runbook when a CloudNativePG `Cluster` is created again under its old name, after a Kubernetes cluster rebuild or a lost volume. The barman-cloud plugin archives each `Cluster` under `s3://cnpg/<namespace>/<serverName>/`, and `serverName` defaults to the `Cluster` name. A new `Cluster` refuses to archive into a prefix that holds WAL, so it recovers from the old prefix and archives under a new one. The charts in `packages/charts/` render both from `backup.recoverFrom` and `backup.serverName`. [Restore a database](restore-a-database.md) covers a restore into a `Cluster` that still runs.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git holds no data, only the declaration of the database.

## Before you start

- Get `kubectl` access, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Install `kubectl-cnpg`, as [Operate Postgres](operate-postgres.md#before-you-start) describes.
- Find the declaration: the `backup` values of the HelmRelease in `clusters/<site>/apps/<app>/`, or a plain `Cluster` manifest such as `clusters/folly/apps/tronbyt/04-database.yaml`.

`<site>` is `folly` or `offsite`. `<old>` is the prefix the `Cluster` archives under today: `backup.serverName`, or the `Cluster` name if that is empty. `<new>` is a prefix no `Cluster` has used, such as `<cluster>-2`.

## Take a last backup

If the old `Cluster` still runs, stop the writers of the database first. The backup switches the WAL file, so the archive then holds every write.

1. Read the prefix in use and the archive state.

   ```bash
   kubectl cnpg status <cluster> -n <namespace> --context <site>
   ```

   Result: `ObjectStore / Server name: garage/<old>` and `Working WAL archiving: OK`.

2. Take a base backup.

   ```bash
   kubectl cnpg backup <cluster> -n <namespace> --method plugin --plugin-name barman-cloud.cloudnative-pg.io --context <site>
   ```

   Result: `backup/<cluster>-<timestamp> created`.

3. Wait until the backup completes.

   ```bash
   kubectl get backup -n <namespace> --context <site>
   ```

   Result: The new row has the phase `completed`.

## Declare the new Cluster

> [!CAUTION]
> Merge after the old `Cluster` stops and before Flux creates the new one. A running `Cluster` takes `<new>` and fills it with WAL, and the new `Cluster` then stays in `Setting up primary`.

1. Set `backup.serverName: <new>` and `backup.recoverFrom: <old>` in the release's values. In a plain manifest, copy the `serverName`, `bootstrap.recovery` and `externalClusters` that `packages/charts/app/templates/database.yaml` renders.

2. If the `Cluster` is `kthx-db`, set `serverName: <new>` in `clusters/offsite/apps/restore-drill/cluster.yaml`.

3. Open a PR and merge it, as [Apply a Kubernetes change](apply-a-kubernetes-change.md) describes.

4. If the `Cluster` already exists and stays in `Setting up primary`, delete it. CloudNativePG deletes its claim. Then apply the release again, or reconcile the Kustomization of a plain manifest.

   ```bash
   kubectl delete cluster.postgresql.cnpg.io/<cluster> -n <namespace> --context <site>
   flux reconcile helmrelease <release> -n <namespace> --force --context <site>
   ```

   Result: `cluster.postgresql.cnpg.io "<cluster>" deleted`, then `HelmRelease reconciliation completed`.

## Check the recovery

1. Wait until the `Cluster` is ready.

   ```bash
   kubectl wait --for=condition=Ready cluster.postgresql.cnpg.io/<cluster> -n <namespace> --timeout=30m --context <site>
   ```

   Result: `cluster.postgresql.cnpg.io/<cluster> condition met`.

2. Count the rows of a table that the app always fills.

   ```bash
   kubectl cnpg psql <cluster> -n <namespace> --context <site> -- -d <database> -At -c 'select count(*) from <table>'
   ```

   Result: A number above zero.

3. Make sure the `Cluster` archives under the new prefix.

   ```bash
   kubectl cnpg status <cluster> -n <namespace> --context <site>
   ```

   Result: `ObjectStore / Server name: garage/<new>` and `Working WAL archiving: OK`.

4. Take a base backup under the new prefix, as in [Take a last backup](#take-a-last-backup).

5. Open a PR that removes `backup.recoverFrom`. CloudNativePG reads `bootstrap` only at creation, so the change is inert.

## Remove the old prefix

The plugin prunes only the prefix it archives under. Wait until `<new>` holds 30 days of backups.

1. Set the Garage remote, as [Restore from the GCS copy](restore-from-the-gcs-copy.md) describes, with the `cnpg` key.

2. Delete the old prefix.

   ```bash
   rclone purge garage:cnpg/<namespace>/<old>/
   ```

   Result: No output.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| Helm fails with `backup.recoverFrom ... is the prefix this Cluster archives to`. | `<new>` is empty or equals `<old>`. | Set `backup.serverName` to a prefix no `Cluster` has used. |
| The pod logs print `Expected empty archive`. | `<new>` holds WAL. | Choose another `<new>`, then do step 4 of [Declare the new Cluster](#declare-the-new-cluster). |
| The `Cluster` stays in `Setting up primary` with no such log line. | The recovery cannot read the `garage` ObjectStore, or `<old>` holds no backup. | Read the logs of the `<cluster>-1-full-recovery` pod. |
| `restore-drill` fails after you remove the old prefix. | The drill still reads `<old>`. | Set `serverName: <new>` in `clusters/offsite/apps/restore-drill/cluster.yaml`. |

## Related

- [Backups](../platform/backups.md)
- [Restore a database](restore-a-database.md)
- [Operate Postgres](operate-postgres.md)
- [Restore from the GCS copy](restore-from-the-gcs-copy.md)
