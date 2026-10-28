---
title: Backups
description: How Garage, Velero, CloudNativePG and etcd snapshots back up the lab's databases, volumes and etcd, and how each site copies them to GCS.
---

Backups write to a Garage S3 store at each site. A CronJob copies each store to GCS, encrypted.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Garage | Stores the buckets `velero`, `cnpg` and `etcd` | A NixOS service on [spore](../hosts/spore.md), [capsule](../hosts/capsule.md) and [forge](../hosts/forge.md) for folly, a StatefulSet on [oldschool](../hosts/oldschool.md)'s `data` volume for offsite |
| Velero | Backs up objects, and the volumes of pods with the annotation `backup.velero.io/backup-volumes` | The `velero` namespace |
| barman-cloud plugin | Archives each database's base backups and WAL, through an `ObjectStore` named `garage` | The `cloudnative-pg` namespace |
| `etcd-snapshot` | Snapshots the cluster's etcd through the Talos API into `etcd/<site>/` | The `backups` namespace on each site |
| `backup-push` | Syncs each bucket to GCS through an rclone crypt remote | The `backups` namespace |
| `restore-drill` | Recovers the kthx database on offsite, and the tronbyt database on folly, into a throwaway cluster | The `restore-drill` namespace on each site |

## Schedule

| Step | When |
| --- | --- |
| Velero Schedule `daily` | 02:00 Halifax |
| CNPG `ScheduledBackup` | Daily, 01:00 to 04:00 Halifax |
| etcd snapshot | 02:30 Halifax |
| `backup-push` | `BACKUP_PUSH_SCHEDULE`: weekly on folly, because of Starlink, and daily on offsite |
| `restore-drill` | 06:00 Halifax: the 1st of the month on offsite, the 15th on folly |

## Retention

- Velero keeps a backup 720 hours.
- Each `ObjectStore` keeps 30 days.
- The etcd jobs delete snapshots older than 14 days.
- GCS has object versioning, and keeps a deleted or replaced object 30 days.

## Garage cluster

folly's Garage runs at replication factor 3 on the anchors: spore, capsule and forge. Each node stores every object and is its own zone. The cluster holds as much as the smallest node, so the layout gives each node 80 GB. RPC uses port 3901 on the Anchor network, and the firewall opens it to the other anchors only. Every anchor serves S3, and clients name spore. A node with `homelab.garage.clustered` unset is a standalone store with replication factor 1. spore keeps its old standalone store in `/nfs/data/garage` as the rollback of [Migrate Garage to three nodes](../runbooks/migrate-garage-to-three-nodes.md).

## Credentials

1Password holds the Garage keys in `garage-<site>`, and the crypt and Velero repository passwords in `backup-crypt`. The NixOS hosts read theirs from SOPS under `garage/`. The three anchors share one `garage/rpc-secret` in their own SOPS files. `backup-push` reaches GCS through [workload identity](pki.md#workload-identity), as `backups:backup-push`.

## Volumes

Every claim on folly uses `local-path`, a `local` volume on one node's `data` volume. No pod mounts storage from a host outside the cluster, so a stopped anchor does not hang a pod. A claim lives on one node, so Velero is the copy of a claim that has no second instance. [Restore a volume](../runbooks/restore-a-volume.md) recovers it on another node.

Velero skips a PVC bound to a hostPath volume. Migrate any such claim to a `local` volume with [Migrate a local-path volume](../runbooks/migrate-a-local-path-volume.md) before relying on its backup.

## Volume coverage

Velero runs in opt-in mode: `defaultVolumesToFsBackup` is `false`, so it copies a volume with kopia only when the running pod names it in `backup.velero.io/backup-volumes`. Every claim on folly has one of three answers.

| Answer | Claims | Why |
| --- | --- | --- |
| Velero | `jellyfin-config`, `prom-stack-grafana`, `smiirl-data`, `tronbyt-data`, `data-vault-openbao-0` | The state is not in the repo and cannot be rebuilt. Grafana keeps what the UI adds, such as public dashboard links; its dashboards and data sources come from the repo. |
| CloudNativePG | `tally-db-*`, `tronbyt-*` | The barman-cloud plugin archives base backups and WAL, so Velero skips them. |
| Excluded | Prometheus, VictoriaLogs and Tempo volumes | Metrics, logs and traces history. Losing it costs history only. Rules, alerts and dashboards come from the repo. |
| Excluded | `valkey-applol-cache-0-0-data` | A cache that the kthx engine owns. |
| Excluded | `hajimari-config`, `dump-data-dump-nfs-0` | Empty. Hajimari reads its settings from a ConfigMap, and `dump` is scratch space. |
| Excluded | `pvc-nfs-provisioner-nfs-subdir-external-provisioner` | A mount handle for the NFS export. The data lives on spore. |

Velero skips a pod that is not running when the backup starts, and records a warning. A volume that the warnings name goes uncovered for that night.

`mise run backup:coverage [context]` lists each claim with its answer and fails when a claim has none. `scripts/backup-coverage.exclusions` holds each excluded claim and its reason.

## Rules

- Give a new PVC a pod annotation `backup.velero.io/backup-volumes`, or a line in `scripts/backup-coverage.exclusions` that says why it needs no backup. Run `mise run backup:coverage` before you merge.

- Keep `backup-crypt` in 1Password. Without it the GCS copy cannot be read.
- Label each backup CronJob `lolwtf.ca/backup: "true"`. `BackupJobStale` and `BackupJobFailed` watch only those.
- Give a new database an `ObjectStore` and a `ScheduledBackup`. It has no backup without them.
- Give a re-created `Cluster` a new `backup.serverName`. The kthx engine does this for a Datastore: each generation archives under its own prefix, `<name>-<8 hex characters of the row id>`. The plugin refuses a prefix that holds WAL; [Recover a re-created database](../runbooks/recover-a-re-created-database.md) has the steps.

## Where it lives

- `nix/services/garage.nix`: Garage on the anchors
- `clusters/<site>/etcd-snapshot/`: the etcd snapshots
- `clusters/offsite/garage/`: offsite's Garage
- `scripts/backup-coverage.sh`, `scripts/backup-coverage.exclusions`: the volume coverage check
- `clusters/base/platform/velero/`, `barman-cloud/`, `backups/`: Velero, the plugin and `backup-push`
- `clusters/base/platform/kthx-engine-target/backup/`: the store the kthx Datastores archive to
- `clusters/offsite/apps/restore-drill/`, `clusters/folly/apps/restore-drill/`: the restore drill
- `clusters/<site>/config/cluster-settings.yaml`: `GARAGE_S3_ENDPOINT`, `BACKUP_PUSH_SCHEDULE`
- `terraform/gcp/projects/homelab-ng/backups.tf`: the buckets
- `clusters/base/monitoring/backup-rules.yaml`, `clusters/base/monitoring/etcd-snapshot-rules.yaml`: the alerts

## Related

- [Restore a database](../runbooks/restore-a-database.md)
- [Recover a re-created database](../runbooks/recover-a-re-created-database.md)
- [Restore a volume](../runbooks/restore-a-volume.md)
- [Restore etcd on Talos](../runbooks/restore-etcd-on-talos.md)
- [Migrate Garage to three nodes](../runbooks/migrate-garage-to-three-nodes.md)
- [Restore from the GCS copy](../runbooks/restore-from-the-gcs-copy.md)
- [Migrate a local-path volume](../runbooks/migrate-a-local-path-volume.md)
