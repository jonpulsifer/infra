---
title: Operate Postgres
description: Find, connect to, inspect and restart the CloudNativePG Postgres databases with the kubectl cnpg plugin, and check which ones have a backup.
---

Use this runbook to find, connect to, inspect or restart a Postgres database, and to check its backup. To change the instances, storage or Postgres version of a database, change its manifest, as [Apply a Kubernetes change](apply-a-kubernetes-change.md) describes. Each database is a CloudNativePG `Cluster` object. CloudNativePG is the Kubernetes controller that runs Postgres, and `kubectl cnpg` is its kubectl plugin. The `cnpg` commands find the primary pod and container for you.

> [!WARNING]
> This runbook restarts databases and runs psql by hand. It is an exception to the GitOps rule because git cannot hold a restart or a query.

## Before you start

- Get `kubectl` access, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Install `kubectl-cnpg`. `dotfiles/mise-global-config.toml` installs it with mise.
- Put `--context <site>` after the `cnpg` command. `<site>` is `folly` or `offsite`.

## Find a database

| Declared in | Change it through |
| --- | --- |
| `clusters/folly/apps/tronbyt/04-database.yaml` | Git |
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

> [!WARNING]
> Only the kthx database has a backup. If another database loses its volume, its data is lost.

| Database | Backup |
| --- | --- |
| kthx (`kthx-db`) | The CronJob `kthx-db-backup` writes a `pg_dumpall` to `gs://bluenose-kthx/backups/pg/` each night. The bucket deletes a dump after 30 days. |
| The built-apps database (`spindrift-db`) | None. `keepOnDelete` keeps the `Cluster` and its data if the release is deleted. |

1. Read the backup line in the `kubectl cnpg status` output of the database.

   Result: `Continuous Backup not configured`.

2. Make sure that the last kthx dump is less than a day old.

   ```bash
   kubectl get cronjob kthx-db-backup -n kthx --context offsite -o jsonpath='{.status.lastSuccessfulTime}{"\n"}'
   ```

   Result: The time of the last successful dump, in UTC.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `flags cannot be placed before plugin name: --context` | `--context` is before `cnpg`. | Put `--context` after the `cnpg` command. |
| `unknown command "cnpg" for "kubectl"` | The plugin is not installed. | Run `mise install github:cloudnative-pg/cloudnative-pg`. |
| `cnpg status` shows no primary. | The `Cluster` is in bootstrap or in a restart. | If no primary shows after 5 minutes, read `kubectl cnpg logs cluster`. |
| `KthxBackupFailing` fires. | No kthx dump has succeeded for 36 hours. | Read the logs of the last `kthx-db-backup` Job. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [kthx](../apps/kthx.md)
