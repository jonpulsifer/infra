---
title: Migrate Garage to three nodes
description: Move folly's backup store from the one-node Garage on spore to a replication factor 3 cluster on spore, capsule and forge.
---

Use this runbook once, to move folly's Garage store from spore alone to the three [anchors](../platform/backups.md#garage-cluster). Garage does not support a changed replication factor on a running cluster, so the migration builds a new cluster on a new data directory and refills it. The old store stays on disk as the rollback.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because Garage holds the layout in its own metadata. Backups stop for the minutes between the spore deploy and the refill.

## Before you start

- `nix/hosts/capsule.nix` and `nix/hosts/forge.nix` set `homelab.garage.clustered = true` and are deployed. Each runs an empty Garage that no one has connected to spore.
- Each node stores every object. The cluster holds as much as the smallest node. Check that spore's current data fits in 80 GB with room to grow.

  ```bash
  ssh spore.lolwtf.ca sudo du -sh /nfs/data/garage/data
  ```

- Sign in to `op`. `garage-folly` in 1Password holds the bucket keys.
- On the nodes, run `garage` as `sudo env GARAGE_CONFIG_FILE=/etc/garage.toml garage ...`.

## Stage a copy

1. Run `rclone` on forge, which has the disk. Pass each key over stdin so it stays out of argv.

   ```bash
   for b in velero cnpg etcd; do
     { op read "op://homelab/garage-folly/$b-access-key-id"; op read "op://homelab/garage-folly/$b-secret-access-key"; } |
       ssh forge.lolwtf.ca "read -r id; read -r secret; mkdir -p /var/tmp/garage-stage; RCLONE_CONFIG_OLD_TYPE=s3 RCLONE_CONFIG_OLD_PROVIDER=Other RCLONE_CONFIG_OLD_REGION=garage RCLONE_CONFIG_OLD_ENDPOINT=http://spore.lolwtf.ca:3900 RCLONE_CONFIG_OLD_ACCESS_KEY_ID=\$id RCLONE_CONFIG_OLD_SECRET_ACCESS_KEY=\$secret nix run nixpkgs#rclone -- sync old:$b /var/tmp/garage-stage/$b"
   done
   ```

## Cut spore over

1. In `nix/hosts/spore.nix`, set the `homelab.garage` block to `dataDir = "/nfs/data/garage-ha"` and `clustered = true`. Open a PR and merge it.
2. Repeat the `sync` in [Stage a copy](#stage-a-copy) to pick up the last writes, then deploy spore as [Deploy a NixOS host](deploy-a-nixos-host.md) says.

   Result: `garage.service` runs on spore with an empty store. `garage-bootstrap` logs that the layout has fewer than three nodes and exits.

3. Connect the nodes. Each prints `<id>@<address>:3901`.

   ```bash
   ssh spore.lolwtf.ca sudo env GARAGE_CONFIG_FILE=/etc/garage.toml garage node connect "$(ssh capsule.lolwtf.ca sudo env GARAGE_CONFIG_FILE=/etc/garage.toml garage node id -q)"
   ssh spore.lolwtf.ca sudo env GARAGE_CONFIG_FILE=/etc/garage.toml garage node connect "$(ssh forge.lolwtf.ca sudo env GARAGE_CONFIG_FILE=/etc/garage.toml garage node id -q)"
   ```

4. On spore, assign one zone to each node, review and apply the layout. Take the node ids from `garage status`.

   ```bash
   garage layout assign -z spore -c 80G <spore-id>
   garage layout assign -z capsule -c 80G <capsule-id>
   garage layout assign -z forge -c 80G <forge-id>
   garage layout show
   garage layout apply --version 1
   ```

5. Create the keys, buckets and grants.

   ```bash
   sudo systemctl restart garage-bootstrap
   ```

   Result: `garage key list` shows `velero`, `cnpg`, `etcd` and `push` with their old access key ids, so no client changes.

6. Refill from forge, with the same loop as the stage but `sync /var/tmp/garage-stage/$b new:$b` and the endpoint of spore.

## Verify

- `garage status` shows three nodes up, and `garage layout show` shows no staged changes.
- `garage stats -a` shows a resync queue of 0 after the refill.
- Run the Velero `daily` Schedule and one CNPG `ScheduledBackup` by hand. The CNPG WAL archive restarts with a gap, so the new base backup restores.
- Stop `garage.service` on forge. A backup still writes. Start it again.

## Clients

Every client names `GARAGE_S3_ENDPOINT` in `clusters/folly/config/cluster-settings.yaml`, which points at spore. Each anchor serves S3 on the same port, so clients keep working while spore is up and lose the endpoint, not the data, when it is down. A name that resolves to all three anchors is the follow-up.

## Roll back

Revert the spore PR and deploy. The old store at `/nfs/data/garage` resumes with the data it had at cutover. After the cluster has run a week, remove it and `/var/tmp/garage-stage` on forge.
