---
title: Restore etcd
description: Restore the etcd of a cluster's control plane from a snapshot in Garage, when the etcd data is lost or corrupt.
---

Use this runbook when the etcd data of a control plane is lost or corrupt. etcd is the database of the Kubernetes API server. Each cluster has one etcd member, on [optiplex](../hosts/optiplex.md) for folly and on [retrofit](../hosts/retrofit.md) for offsite. The restore returns every Kubernetes object to its state at the snapshot time. Flux then applies `main` again. [Backups](../platform/backups.md) describes the snapshots.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git does not hold the etcd data.

## Before you start

- Get SSH access to the control plane, with `sudo`.
- Sign in to `op`.

`<site>` is `folly` or `offsite`. `<control-plane>` is `optiplex` or `retrofit`.

## Get the snapshot

1. Put the Garage remote in the environment. Use the `etcd` key of the site.

   ```bash
   export RCLONE_CONFIG_GARAGE_TYPE=s3 RCLONE_CONFIG_GARAGE_PROVIDER=Other RCLONE_CONFIG_GARAGE_REGION=garage
   export RCLONE_CONFIG_GARAGE_ENDPOINT=<GARAGE_S3_ENDPOINT>
   export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID="$(op read 'op://homelab/garage-<site>/etcd-access-key-id')"
   export RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY="$(op read 'op://homelab/garage-<site>/etcd-secret-access-key')"
   ```

   `<GARAGE_S3_ENDPOINT>` is the value in `clusters/<site>/config/cluster-settings.yaml`.

2. If Garage has lost the `etcd` bucket, follow [Restore from the GCS copy](restore-from-the-gcs-copy.md).

3. List the snapshots of the control plane.

   ```bash
   rclone lsl garage:etcd/<control-plane>/
   ```

   Result: One `<UTC timestamp>.db` file for each daily snapshot of the last 14 days.

4. Copy the newest snapshot to your machine.

   ```bash
   rclone copyto garage:etcd/<control-plane>/<file>.db ./etcd-snapshot.db
   ```

5. Copy the file to the control plane.

   ```bash
   scp ./etcd-snapshot.db <control-plane>.lolwtf.ca:/tmp/etcd-snapshot.db
   ```

## Restore etcd

> [!CAUTION]
> The API server of the cluster is down from step 3 until step 8. Pods continue to run, but nothing changes them.

1. Sign in to the control plane.

   ```bash
   ssh <control-plane>.lolwtf.ca
   ```

2. Read the etcd member settings.

   ```bash
   systemctl show etcd -p Environment
   ```

   Result: The values of `ETCD_NAME`, `ETCD_INITIAL_CLUSTER`, `ETCD_INITIAL_CLUSTER_TOKEN`, `ETCD_INITIAL_ADVERTISE_PEER_URLS` and `ETCD_DATA_DIR`.

3. Stop the API server and etcd.

   ```bash
   sudo systemctl stop kube-apiserver etcd
   ```

4. Move the current data directory aside.

   ```bash
   sudo mv /var/lib/etcd /var/lib/etcd.before-restore
   ```

5. Restore the snapshot into a new data directory. Use the values from step 2.

   ```bash
   sudo nix shell nixpkgs#etcd -c etcdutl snapshot restore /tmp/etcd-snapshot.db \
     --data-dir /var/lib/etcd \
     --name <ETCD_NAME> \
     --initial-cluster <ETCD_INITIAL_CLUSTER> \
     --initial-cluster-token <ETCD_INITIAL_CLUSTER_TOKEN> \
     --initial-advertise-peer-urls <ETCD_INITIAL_ADVERTISE_PEER_URLS>
   ```

   Result: A log line that the restore wrote the snapshot to `/var/lib/etcd`.

6. Give the data directory to the `etcd` user.

   ```bash
   sudo chown -R etcd:etcd /var/lib/etcd
   sudo chmod 700 /var/lib/etcd
   ```

7. Start etcd and the API server.

   ```bash
   sudo systemctl start etcd kube-apiserver
   ```

8. From your machine, make sure that the API server answers.

   ```bash
   kubectl get nodes --context <site>
   ```

   Result: Each node of the cluster, `Ready` within a few minutes.

9. Make sure that Flux applies `main` again.

   ```bash
   flux get kustomizations --context <site>
   ```

   Result: Each Kustomization `True`, at the newest revision of `main`.

10. When the cluster works, delete `/var/lib/etcd.before-restore` and `/tmp/etcd-snapshot.db` on the control plane.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `snapshot file integrity check failed` | The file is a copy of the data directory, with no hash. | Add `--skip-hash-check` to the restore command. |
| etcd does not start, with `permission denied` in `journalctl -u etcd`. | The data directory is not owned by `etcd`. | Do step 6 again. |
| etcd does not start, with `member ... has already been bootstrapped`. | A value from step 2 is wrong. | Delete `/var/lib/etcd`, then do step 5 again with the values from step 2. |
| The cluster does not recover after the restore. | The snapshot is bad, or older than the damage. | Stop etcd and the API server. Move `/var/lib/etcd.before-restore` back to `/var/lib/etcd`, then try an older snapshot. |

## Related

- [Backups](../platform/backups.md)
- [Kubernetes](../platform/kubernetes.md)
- [Deploy a NixOS host](deploy-a-nixos-host.md)
- [Restore etcd on Talos](restore-etcd-on-talos.md)
