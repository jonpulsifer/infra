---
title: NetBox
description: The record of every machine in the lab, on capsule, reachable only over the tailnet.
---

NetBox is the lab's asset and lifecycle record: each machine, its place, its cabling and its status. It runs on [capsule](../hosts/capsule.md) from the NixOS `services.netbox` module, outside both clusters. The owner edits it in the UI.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `netbox` | The UI and REST API, on gunicorn with three workers | capsule, `[::1]:8001` |
| `netbox-rq` | Background jobs | capsule |
| PostgreSQL 17 | The `netbox` database | capsule, on its Unix socket |
| Redis `netbox` | Cache and job queue | capsule, on its Unix socket |
| nginx | Serves `/static/` and proxies gunicorn | capsule, `127.0.0.1:8080` |
| `netbox-serve` | Tailscale serve: TLS on port 443 of capsule's tailnet address, proxied to nginx | capsule |
| `netbox-backup` | Nightly database dump and media archive to Garage | capsule, 03:15 Halifax |

## Use it

Open `https://capsule.<tailnet>`, which the [tailnet grants](network/remote-access.md#grants) open to the owner. Sign in as `admin` with the password in the 1Password item `netbox-folly`. Create API tokens under the user's profile.

## Backups

`netbox-backup` streams `pg_dump --format=custom` and a tarball of `/var/lib/netbox/media` to `netbox/<UTC time>/` in folly's [Garage cluster](backups.md#garage-cluster), and deletes objects older than 30 days. On success it writes `lab_backup_last_success_timestamp_seconds{source="netbox"}`, which `HostBackupStale` watches. `backup-push` copies only `velero`, `cnpg` and `etcd` to GCS, so the `netbox` bucket has no off-site copy.

To restore, stop `netbox.service`, run `pg_restore --clean --if-exists -d netbox` as `netbox`, and unpack the tarball into `/var/lib/netbox`.

## Rules

- Change `services.netbox.package` on purpose, after a backup. `netbox.service` runs the migrations on its first start after a version change, and NetBox has no downgrade.
- Keep PostgreSQL's pinned major version. A new major version needs a dump and restore.
- Keep nginx on loopback. Tailscale serve is the only way in, and the bootstrap VLAN must never reach NetBox.
- Keep `netbox/secret-key` and `netbox/api-token-pepper`. A new pepper invalidates every API token, and a new secret key ends every session.
- `ALLOWED_HOSTS` is the host's tailnet name, so another anchor serves NetBox at a new address.

## Operate

| Alert | Meaning |
| --- | --- |
| `CapsuleNetboxDown` | NetBox, its worker, PostgreSQL, Redis or the Tailscale serve unit is not active |
| `HostBackupStale` with `source="netbox"` | No backup has succeeded for a day and two hours |

## Where it lives

- `nix/services/netbox.nix`: NetBox, nginx, Tailscale serve, the superuser bootstrap and the backup
- `nix/secrets/capsule.sops.yaml`: `netbox/` and `garage/keys/netbox/`
- `nix/services/garage.nix`: the `netbox` bucket and key, which spore's SOPS file holds for the bootstrap
- `clusters/folly/monitoring/capsule.yaml`: `CapsuleNetboxDown`

## Related

- [Backups](backups.md)
- [Secrets](secrets.md)
- [Hardware inventory](../reference/inventory.md)
