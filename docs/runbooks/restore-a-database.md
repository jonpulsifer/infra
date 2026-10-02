---
title: Restore a database
description: Open a restic repository, find a Postgres snapshot, and restore it into a CloudNativePG database, or run the restore drill.
---

Use this runbook to restore a Postgres database from a restic snapshot, or to test the backups with the restore drill. [Backups](../platform/backups.md) describes the repositories and what each snapshot holds. The other restore runbooks open a repository with the steps in [Open a repository](#open-a-repository).

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git holds no data, only the declaration of the database.

## Before you start

- Get `kubectl` access, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Install the tools in `mise.toml`, which include `restic`, `op`, `gcloud` and `flux`, and sign in to `op`.
- Install `kubectl-cnpg`, as [Operate Postgres](operate-postgres.md#before-you-start) describes.
- To read a staging repository, be on the LAN of its site or on the tailnet.

`<site>` is `folly` or `offsite`. The staging host is `spore` for folly and `oldschool` for offsite.

## Open a repository

The staging repository has the newest snapshots. Use the GCS copy when the staging host is down. The GCS copy of folly can be a week older than staging.

1. Put the repository key in the environment.

   ```bash
   export RESTIC_PASSWORD="$(op read 'op://homelab/restic-repository/password')"
   ```

2. To use staging, set the repository and the rest-server login.

   ```bash
   export RESTIC_REPOSITORY="rest:http://<staging-host>.lolwtf.ca:8000/<site>/"
   export RESTIC_REST_USERNAME="$(op read 'op://homelab/restic-rest-server/username')"
   export RESTIC_REST_PASSWORD="$(op read 'op://homelab/restic-rest-server/password')"
   ```

3. To use GCS, sign in to GCP and set the repository.

   ```bash
   gcloud auth application-default login
   export GOOGLE_PROJECT_ID=homelab-ng
   export RESTIC_REPOSITORY="gs:homelab-ng-backups-<site>:/"
   ```

4. List the snapshots of one kind.

   ```bash
   restic snapshots --tag kind=pg
   ```

   Result: A table of snapshots, with the `ID`, `Time`, `Host` and `Paths` of each. The host is `<site>/<namespace>/<name>`.

## Restore a database

`<cluster>` is the CloudNativePG `Cluster`, and `<owner>` is the role that owns `<database>`.

1. Restore the snapshot to a local directory.

   ```bash
   restic restore <snapshot-id> --target ./restore
   ```

   Result: The dump file under `./restore`, at the path that `restic snapshots` shows.

2. Stop the writers of the database. Suspend the HelmRelease or Kustomization that applies the app, then scale the app to zero.

   ```bash
   flux suspend helmrelease <release> -n <namespace> --context <site>
   kubectl scale deployment <app> -n <namespace> --replicas 0 --context <site>
   ```

3. Find the primary pod.

   ```bash
   kubectl cnpg status <cluster> -n <namespace> --context <site>
   ```

   Result: The pod name on the `Primary instance` line.

4. Read the first five bytes of the dump. A `.gz` file is plain SQL.

   ```bash
   head -c 5 <dump>
   ```

   Result: `PGDMP` for a `pg_dump -Fc` archive. Other output is plain SQL from `pg_dumpall`.

5. If the dump is a `PGDMP` archive, restore it over the database.

   ```bash
   kubectl exec -i <primary> -n <namespace> -c postgres --context <site> -- \
     pg_restore --clean --if-exists --no-owner --role=<owner> -d <database> < <dump>
   ```

   Result: No output.

> [!CAUTION]
> A `pg_dumpall` file creates and fills each database it holds, and psql goes on past an error. Drop every database that the dump holds, or the replay loads its rows a second time into a database that still exists.

6. If the dump is plain SQL, drop each database that it holds.

   ```bash
   kubectl cnpg psql <cluster> -n <namespace> --context <site> -- -c 'drop database <database> with (force)'
   ```

   Result: `DROP DATABASE`.

7. Replay the plain SQL dump.

   ```bash
   gzip -dc <dump> | kubectl exec -i <primary> -n <namespace> -c postgres --context <site> -- psql -X -q -d postgres
   ```

   Result: An error for each role that exists, such as `role "postgres" already exists`.

> [!NOTE]
> The kthx dump has no role passwords. A role that the replay creates has no password until kthx or the owner sets one.

8. Count the rows of a table that the app always fills.

   ```bash
   kubectl cnpg psql <cluster> -n <namespace> --context <site> -- -d <database> -At -c 'select count(*) from <table>'
   ```

   Result: A number above zero.

9. Resume the release. Flux scales the app back to its declared replicas.

   ```bash
   flux resume helmrelease <release> -n <namespace> --context <site>
   ```

## Run the restore drill

The `restore-drill` CronJob restores the latest kthx `kind=pg` snapshot from the offsite GCS bucket into a throwaway Postgres. It fails unless the `sites` table of the `kthx` database has rows.

1. Start a drill.

   ```bash
   kubectl create job restore-drill-now --from=cronjob/restore-drill -n backups --context offsite
   ```

   Result: `job.batch/restore-drill-now created`.

2. Read the result.

   ```bash
   kubectl logs job/restore-drill-now -c drill -n backups --context offsite
   ```

   Result: `restored <file>: <n> rows in kthx.sites`.

3. Delete the Job.

   ```bash
   kubectl delete job restore-drill-now -n backups --context offsite
   ```

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `Fatal: wrong password or no key found` | `RESTIC_PASSWORD` is not the `restic-repository` password. | Read the password from 1Password again. |
| `unexpected HTTP response (401)` | The rest-server login is wrong. | Read the `restic-rest-server` fields again. |
| `restic snapshots` shows no snapshot for the host. | The backup CronJob has not run, or the GCS copy is behind. | Read the CronJob with `kubectl get cronjob -A -l lolwtf.ca/backup=true --context <site>`. Use staging for folly's newest snapshots. |
| The drill's `fetch` container prints `want one kthx host`. | No `kind=pg` snapshot of kthx is in GCS, or two hosts match `offsite/kthx/`. | Read `restic snapshots --tag kind=pg` on the offsite GCS repository. |
| `KubeJobFailed` fires for a `restore-drill` Job. | The last drill failed. | Read the logs of both containers of the last `restore-drill` Job. |

## Related

- [Backups](../platform/backups.md)
- [Operate Postgres](operate-postgres.md)
- [Restore a volume](restore-a-volume.md)
- [Restore etcd](restore-etcd.md)
