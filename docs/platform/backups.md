---
title: Backups
description: How Garage, Velero, CloudNativePG and etcd snapshots back up the lab's databases, volumes and etcd, and how each site copies them to GCS.
---

Backups write to a Garage S3 store at each site. A CronJob copies each store to GCS, encrypted.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Garage | Stores the buckets `velero`, `cnpg` and `etcd` | A NixOS service on [spore](../hosts/spore.md) for folly, a StatefulSet on [oldschool](../hosts/oldschool.md) for offsite |
| Velero | Backs up objects, and the volumes of pods with the annotation `backup.velero.io/backup-volumes` | The `velero` namespace |
| barman-cloud plugin | Archives each database's base backups and WAL, through an `ObjectStore` named `garage` | The `cloudnative-pg` namespace |
| `etcd-backup` | Snapshots etcd | [optiplex](../hosts/optiplex.md) and [retrofit](../hosts/retrofit.md) |
| `backup-push` | Syncs each bucket to GCS through an rclone crypt remote | The `backups` namespace |
| `restore-drill` | Recovers the kthx database into a throwaway cluster | The `restore-drill` namespace on offsite |

## Schedule

| Step | When |
| --- | --- |
| Velero Schedule `daily` | 02:00 Halifax |
| CNPG `ScheduledBackup` | Daily, 01:00 to 04:00 Halifax |
| etcd snapshot | 02:30 Halifax |
| `backup-push` | `BACKUP_PUSH_SCHEDULE`: weekly on folly, because of Starlink, and daily on offsite |
| `restore-drill` | The 1st of the month, 06:00 Halifax |

## Retention

- Velero keeps a backup 720 hours.
- Each `ObjectStore` keeps 30 days.
- The etcd job deletes snapshots older than 14 days.
- GCS has object versioning, and keeps a deleted or replaced object 30 days.

## Credentials

1Password holds the Garage keys in `garage-<site>`, and the crypt and Velero repository passwords in `backup-crypt`. The hosts read theirs from SOPS under `garage/`. `backup-push` reaches GCS through [workload identity](pki.md#workload-identity), as `backups:backup-push`.

## Volumes

Velero skips a PVC bound to a hostPath volume. Migrate any such claim to a `local` volume with [Migrate a local-path volume](../runbooks/migrate-a-local-path-volume.md) before relying on its backup.

## Rules

- Keep `backup-crypt` in 1Password. Without it the GCS copy cannot be read.
- Label each backup CronJob `lolwtf.ca/backup: "true"`. `BackupJobStale` and `BackupJobFailed` watch only those.
- Give a new database an `ObjectStore` and a `ScheduledBackup`. It has no backup without them.

## Where it lives

- `nix/services/garage.nix`, `nix/services/etcd-backup.nix`: Garage on spore, and the etcd snapshots
- `clusters/offsite/garage/`: offsite's Garage
- `clusters/base/platform/velero/`, `barman-cloud/`, `backups/`: Velero, the plugin and `backup-push`
- `clusters/base/platform/spindrift-target/backup/`: the store the kthx Datastores archive to
- `clusters/offsite/apps/restore-drill/`: the restore drill
- `clusters/<site>/config/cluster-settings.yaml`: `GARAGE_S3_ENDPOINT`, `BACKUP_PUSH_SCHEDULE`
- `terraform/gcp/projects/homelab-ng/backups.tf`: the buckets
- `clusters/base/monitoring/backup-rules.yaml`: the alerts

## Related

- [Restore a database](../runbooks/restore-a-database.md)
- [Restore a volume](../runbooks/restore-a-volume.md)
- [Restore etcd](../runbooks/restore-etcd.md)
- [Restore from the GCS copy](../runbooks/restore-from-the-gcs-copy.md)
- [Migrate a local-path volume](../runbooks/migrate-a-local-path-volume.md)
