---
title: Operate Postgres
description: Find, connect to, inspect and restart the CloudNativePG Postgres databases with the kubectl cnpg plugin, and check which ones have a backup.
---

Use this runbook to find, connect to, inspect or restart a Postgres database, and to check its backup. To change the instances, storage or Postgres version of a database, change its manifest, as [Apply a Kubernetes change](apply-a-kubernetes-change.md) describes. Each database is a CloudNativePG `Cluster` object. CloudNativePG is the Kubernetes controller that runs Postgres, and `kubectl cnpg` is its kubectl plugin. The `cnpg` commands find the primary pod and container for you.

> [!WARNING]
> This runbook restarts databases and runs psql by hand. It is an exception to the GitOps rule because git cannot hold a restart or a query.

## Before you start

- Get `kubectl` access, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Install `kubectl-cnpg`. `dotfiles/mise-global-config.toml` installs it with mise, and the [Rowbutt](../apps/mate.md) sandbox image carries it at the operator's version.
- Put `--context <site>` after the `cnpg` command. `<site>` is `folly` or `offsite`.

## Find a database

| Declared in | Change it through |
| --- | --- |
| `clusters/folly/apps/tronbyt/04-database.yaml` | Git |
| `clusters/offsite/apps/mate/database.yaml` | Git |
| `packages/charts/*/templates/database.yaml`, in each chart that has one | Git, in the chart values of the HelmRelease |
| The `spindrift-datastores` namespace | kthx. Each is the database that kthx makes for a [built app](../apps/kthx/built-apps.md). |

`clusters/base/platform/cloudnative-pg/` installs the controller on both clusters.

1. List the databases of a cluster.

   ```bash
   kubectl get cluster.postgresql.cnpg.io -A --context <site>
   ```

   Result: A line for each database, with its `INSTANCES`, `STATUS` and `PRIMARY`.

## Connect to a database

1. Open a psql session in the app database.

   ```bash
   kubectl cnpg psql <name> -n <namespace> --context <site> -- -d <database>
   ```

   Result: The `<database>=#` prompt. Without `-d`, psql opens the `postgres` database.

2. To run one statement, give psql its flags after `--`.

   ```bash
   kubectl cnpg psql <name> -n <namespace> --context <site> -- -d <database> -At -c 'select 1'
   ```

   Result: `1`.

## Inspect a database

1. Show the health, primary and backup state.

   ```bash
   kubectl cnpg status <name> -n <namespace> --context <site>
   ```

   Result: `Status: Cluster in healthy state` and the `Primary instance`.

2. Read the logs of all instances.

   ```bash
   kubectl cnpg logs cluster <name> -n <namespace> --context <site> --tail 50
   ```

   Result: JSON log lines from each instance.

## Restart a database

> [!NOTE]
> Each live `Cluster` has one instance and no standby instance.

> [!CAUTION]
> A restart stops the database until its pod is ready again.

1. Restart the database.

   ```bash
   kubectl cnpg restart <name> -n <namespace> --context <site>
   ```

   Result: `<name> restarted`.

2. Make sure that `kubectl cnpg status` shows `Cluster in healthy state`.

## Check the backups

Each database except `mate-db` has a barman `ObjectStore` named `garage` in its namespace, a `ScheduledBackup`, and WAL archiving through the barman-cloud plugin. The store is the `cnpg` bucket of the site's Garage, under `<namespace>/`. A chart's `backup` value sets the endpoint and the 1Password item. [Backups](../platform/backups.md) describes the schedule, the copy to GCS and the retention. To restore a database, use [Restore a database](restore-a-database.md).

A Postgres Datastore in `spindrift-datastores` archives to that namespace's `garage` store, which `clusters/base/platform/spindrift-target/backup/` declares. The kthx engine owns each Datastore's `Cluster` and `ScheduledBackup`. It turns the plugin on when it provisions a Datastore, and on an older one at the hourly check of an attached Datastore. The first check after the `Cluster` is ready with the plugin adds the `ScheduledBackup`. A Datastore attached to no App is not checked.

| Database | Extra backup |
| --- | --- |
| kthx (`kthx-db`) | The CronJob `kthx-db-backup` writes a `pg_dumpall` to `gs://bluenose-kthx/backups/pg/` each night. The bucket deletes a dump after 30 days. |
| mate (`mate-db`) | Its only backup. The CronJob `mate-db-backup` writes a `pg_dump` to `gs://homelab-ng-mate/backups/pg/` each night, without the ChatGPT sign-in. The bucket deletes a dump after 30 days. |
| The built-apps database (`spindrift-db`) | None. `keepOnDelete` keeps the `Cluster` and its data if the release is deleted. |
| Prowler (`prowler-db`), tronbyt (`tronbyt`, on folly), the Datastores | None. |

> [!WARNING]
> A database with neither an `ObjectStore` nor a dump has no backup. If it loses its volume, its data is lost.

1. Read the backup lines in the `kubectl cnpg status` output of the database.

   Result: `Continuous Backup status` with the first and last point of recoverability.

2. List the backups of the database.

   ```bash
   kubectl get backup -n <namespace> --context <site>
   ```

   Result: A row for each backup, with the phase `completed` and the newest less than a day old.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `flags cannot be placed before plugin name: --context` | `--context` is before `cnpg`. | Put `--context` after the `cnpg` command. |
| `unknown command "cnpg" for "kubectl"` | The plugin is not installed. | Run `mise install github:cloudnative-pg/cloudnative-pg`. |
| `cnpg status` shows no primary. | The `Cluster` is in bootstrap or in a restart. | If no primary shows after 5 minutes, read `kubectl cnpg logs cluster`. |
| `BackupJobStale` or `BackupJobFailed` fires. | The `backup-push` CronJob has not succeeded in its window. | Read the logs of each container of the last Job of the CronJob in the alert. |
| `CNPGBackupStale` fires. | A database has no backup newer than 36 hours. | Run `kubectl get scheduledbackup,backup -n <namespace>`, then read `kubectl cnpg status`. |
| `KthxBackupFailing` fires. | No kthx dump has succeeded for 36 hours. | Read the logs of the last `kthx-db-backup` Job. |
| `MateDatabaseBackupFailing` fires. | No mate dump has succeeded for 36 hours. | Read the logs of the last `mate-db-backup` Job. A 403 from `upload` is the grant in `terraform/gcp/projects/homelab-ng/mate.tf`. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [kthx](../apps/kthx.md)
- [How Rowbutt works](../apps/mate/how-it-works.md#session-store)
- [Backups](../platform/backups.md)
