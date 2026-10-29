---
title: NetBox
description: The record of every machine in the lab, on capsule, reachable only over the tailnet.
---

NetBox is the lab's asset and lifecycle record: each machine, its place, its cabling and its status. It runs on [capsule](../hosts/capsule.md) from the NixOS `services.netbox` module, outside both clusters. The owner edits it in the UI.

## Parts

Every part runs on capsule.

| Part | Job |
| --- | --- |
| `netbox` | The UI and REST API, on gunicorn at `[::1]:8001` |
| `netbox-rq` | Background jobs |
| PostgreSQL 17 | The `netbox` database, on its Unix socket |
| Redis `netbox` | Cache and job queue, on its Unix socket |
| nginx | Serves `/static/` and proxies gunicorn at `127.0.0.1:8080` |
| `netbox-serve` | Tailscale serve: TLS on capsule's tailnet address, proxied to nginx |
| `netbox-backup` | Nightly database dump and media archive to Garage, 03:15 Halifax |
| `netbox-drift` | Hourly check of folly's nodes against NetBox |

## Use it

Open `https://capsule.<tailnet>`, which the [tailnet grants](network/remote-access.md#grants) open to the owner. Sign in as `admin` with the password in the 1Password item `netbox-folly`. Scripts use the write-enabled token `netbox/api-token` in `nix/secrets/capsule.sops.yaml`, also `api-token` in that item.

To add a node, run `mise run netbox:declare <node> <serial> <mac> <switch port> <address>`. It declares the device as `planned`, with its interface, MAC, cable and primary address, then renders the inventory export. [Provision a node](../runbooks/provision-a-node.md#declare-the-device) has the options.

## Data

`mise run netbox:seed` imports folly's devices, cables, prefixes, custom fields and choice sets from the repo, sets each node's `talos_class` and `bmc_type`, and tags what it writes `managed-by: git-seed`. It sets a node's status only when it creates the device, and its class and BMC type only when the device is new or the field is empty. It also seeds the event rule `fleet-controller-device-update`, which posts every device update to the fleet controller's webhook on spore, at the address in `clusters/folly/config/anchor-topology.json`. The operator exports `NETBOX_WEBHOOK_SECRET`, the secret the controller verifies, before the run. A second run changes nothing. [Hardware inventory](../reference/inventory.md) covers the export and the drift check.

## Backups

`netbox-backup` streams `pg_dump --format=custom` and a tarball of `/var/lib/netbox/media` to `netbox/<UTC time>/` in folly's [Garage cluster](backups.md#garage-cluster), and deletes objects older than 30 days. On success it writes `lab_backup_last_success_timestamp_seconds{source="netbox"}`. The `netbox` bucket has no off-site copy.

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
| `NetboxNodeDrift`, `NetboxExportDiffers`, `NetboxDriftCheckStale` | See [Drift](../reference/inventory.md#drift) |

## Where it lives

- `nix/services/netbox.nix`: NetBox, nginx, Tailscale serve, the superuser bootstrap and the backup
- `nix/services/netbox-drift.nix`: the drift check
- `scripts/netbox-seed.sh` and `scripts/netbox-export.sh`: the seed and the export
- `nix/secrets/capsule.sops.yaml`: `netbox/` and `garage/keys/netbox/`
- `nix/services/garage.nix`: the `netbox` bucket and key, which spore's SOPS file holds for the bootstrap
- `clusters/folly/monitoring/capsule.yaml`: the alerts

## Related

- [Backups](backups.md)
- [Secrets](secrets.md)
- [Hardware inventory](../reference/inventory.md)
