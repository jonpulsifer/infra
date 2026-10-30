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

Atlantis on offsite reaches the API over HTTP on port 8080 at capsule's Anchor network address, which the `nest_k8s_to_capsule_netbox` policy and capsule's firewall admit from offsite's node, VIP and pod ranges.

To add a node, add its entry to `clusters/folly/inventory/nodes.yaml` in a pull request; Atlantis applies it as a `planned` device. [Provision a node](../runbooks/provision-a-node.md) has the steps.

## Data

`terraform/netbox/folly` applies the nodes file: each node's device, address, cable and declared custom fields, the node models' device types, every custom field and choice set on `dcim.device`, and the event rule `fleet-controller-device-update`, which posts every device update to the fleet controller's webhook on spore, at the address in `clusters/folly/config/anchor-topology.json`. The webhook's secret, the value the controller verifies, is set in NetBox by hand. `mise run netbox:seed` imports the site, the prefixes, the anchors and the switch from the repo, and tags what it writes `managed-by: git-seed`. It also writes the nodes, custom fields and webhook this root declares, from the export. [Hardware inventory](../reference/inventory.md) covers the nodes file, the export and the drift check.

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
- `terraform/netbox/folly`: the nodes, the custom fields and the webhook
- `scripts/netbox-seed.sh` and `scripts/netbox-export.sh`: the seed and the export
- `nix/secrets/capsule.sops.yaml`: `netbox/` and `garage/keys/netbox/`
- `nix/services/garage.nix`: the `netbox` bucket and key, which spore's SOPS file holds for the bootstrap
- `clusters/folly/monitoring/capsule.yaml`: the alerts

## Related

- [Backups](backups.md)
- [Secrets](secrets.md)
- [Hardware inventory](../reference/inventory.md)
