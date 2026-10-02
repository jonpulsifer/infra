---
title: Backups
description: How restic backs up the lab's databases, volumes and etcd to a staging repository at each site, and copies it to GCS on a schedule.
---

Backups are restic snapshots of the lab's databases, volumes and etcd. restic is a backup tool that encrypts and deduplicates each snapshot. Each site writes to a staging repository at that site, and a CronJob copies it to GCS.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Backup CronJobs | Dump a database or read a volume, then back it up to staging | App namespaces, labelled `lolwtf.ca/backup: "true"` |
| Staging repository | An append-only restic rest-server on TCP 8000 | [spore](../hosts/spore.md) at `/folly`, [oldschool](../hosts/oldschool.md) at `/offsite` |
| `restic-push` | Copies staging to GCS, then prunes the GCS copy | The `backups` namespace of each cluster |
| GCS buckets | Hold the off-site copy | `homelab-ng-backups-folly` and `homelab-ng-backups-offsite` |
| Staging prune | Prunes the staging repository | A systemd timer on the staging host |
| `restore-drill` | Restores the latest kthx database from GCS and checks it | The `backups` namespace on offsite |

A snapshot has the host `<cluster>/<namespace>/<name>` and the tag `kind=pg`, `kind=pvc` or `kind=etcd`.

## Schedule

Times are America/Halifax.

| Step | folly | offsite |
| --- | --- | --- |
| Backup CronJobs | Daily, 01:00 to 04:00 | Daily, 01:00 to 04:00 |
| `restic-push` | Wednesday 05:00 | Daily 05:00 |
| Staging prune | Wednesday 07:00 | Daily 07:00 |
| `restore-drill` | None | The 1st of the month, 06:00 |

folly's uplink is Starlink, so folly sends a week of snapshots to GCS in one window.

## Retention

Staging keeps 14 daily and 4 weekly snapshots. GCS keeps 7 daily, 8 weekly and 12 monthly snapshots.

## Credentials

The 1Password item `restic-repository` holds the key of every repository. The item `restic-rest-server` holds the rest-server login. An ExternalSecret writes both to the Secret `restic` in each backup namespace. The staging hosts read them from SOPS. `restic-push` reaches its bucket as the GCP account `backups-<site>`, through [workload identity](pki.md#workload-identity).

## Rules

- Keep the `restic-repository` password in 1Password. No backup can be read without it.
- Never run `forget` or `prune` from a backup CronJob. The append-only rest-server refuses them.
- Put the label `lolwtf.ca/backup: "true"` on each backup CronJob. `BackupJobStale` and `BackupJobFailed` watch only those CronJobs.
- Keep folly's staging retention longer than a week. The Wednesday push copies only what staging holds.

## Where it lives

- `clusters/base/platform/`: the `backups` namespace and `restic-push`
- `clusters/offsite/apps/restore-drill/`: the restore drill
- `terraform/gcp/projects/homelab-ng/`: the buckets and GCP accounts
- `nix/hosts/spore.nix` and `nix/hosts/oldschool.nix`: the rest-servers and prune timers
- `clusters/base/monitoring/`: the backup alerts

## Related

- [Restore a database](../runbooks/restore-a-database.md)
- [Restore a volume](../runbooks/restore-a-volume.md)
- [Restore etcd](../runbooks/restore-etcd.md)
