---
title: Restore etcd on Talos
description: Restore the etcd of a Talos control plane from a snapshot, when the etcd data is lost or corrupt.
---

Use this runbook when the etcd data of a control plane that runs Talos Linux is lost or corrupt. etcd is the database of the Kubernetes API server, and each cluster has one member, on its control plane. The control plane keeps etcd on its own `ETCD` partition, so the restore wipes only that partition. The image cache in `EPHEMERAL` and the `data` user volume stay. The restore returns every Kubernetes object to its state at the snapshot time, and Flux then applies `main` again. [Restore etcd](restore-etcd.md) covers a NixOS control plane.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git does not hold the etcd data.

## Before you start

- Get the cluster's admin context in `~/.talos/config`, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Sign in to `op`, and install `talosctl` and `rclone`.

`<site>` is `folly` or `offsite`. `<cp>` is `API_SERVER_IP` in `clusters/<site>/config/cluster-topology.json`.

## Get the snapshot

> [!NOTE]
> On folly, the `etcd-snapshot` CronJob in `clusters/folly/etcd-snapshot/` writes a snapshot under `etcd/<site>/` each night and keeps 14 days. A file under `etcd/<hostname>/` is from NixOS and does not restore on Talos.

1. Put the Garage remote in the environment. Use the `etcd` key of the site.

   ```bash
   export RCLONE_CONFIG_GARAGE_TYPE=s3 RCLONE_CONFIG_GARAGE_PROVIDER=Other RCLONE_CONFIG_GARAGE_REGION=garage
   export RCLONE_CONFIG_GARAGE_ENDPOINT=<GARAGE_S3_ENDPOINT>
   export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID="$(op read 'op://homelab/garage-<site>/etcd-access-key-id')"
   export RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY="$(op read 'op://homelab/garage-<site>/etcd-secret-access-key')"
   ```

   `<GARAGE_S3_ENDPOINT>` is the value in `clusters/<site>/config/cluster-settings.yaml`.

2. If Garage has lost the `etcd` bucket, follow [Restore from the GCS copy](restore-from-the-gcs-copy.md).
3. Copy the newest snapshot of the cluster to your machine.

   ```bash
   rclone lsl garage:etcd/<site>/
   rclone copyto garage:etcd/<site>/<file>.db ./etcd-snapshot.db
   ```

   Result: One `<UTC timestamp>.db` file for each snapshot, then a local `./etcd-snapshot.db`.

## Restore etcd

> [!CAUTION]
> The API server is down from step 3 until step 5. Pods on the workers keep running, but nothing changes them.

1. Read the state of etcd.

   ```bash
   talosctl --context <site> -n <cp> service etcd
   talosctl --context <site> -n <cp> etcd status
   ```

   Result: The state and health of the service, and the database size when etcd answers. If etcd is healthy, stop. A restore loses every change since the snapshot.

2. Keep a copy of the current data. If etcd does not answer, use the second command.

   ```bash
   talosctl --context <site> -n <cp> etcd snapshot ./before-restore.db
   talosctl --context <site> -n <cp> cp /var/lib/etcd/member/snap/db ./before-restore
   ```

> [!CAUTION]
> Wipe `ETCD`, not `EPHEMERAL`. A wipe of `EPHEMERAL` leaves etcd as it is and deletes the image cache.

3. Wipe the `ETCD` volume and reboot the control plane. `--graceful=false` is required, because a single member cannot leave etcd.

   ```bash
   talosctl --context <site> -n <cp> reset --system-labels-to-wipe=ETCD --reboot --graceful=false
   ```

   Result: `post check passed`. After the reboot, `talosctl -n <cp> service etcd` shows `Preparing`.

4. Bootstrap etcd from the snapshot.

   ```bash
   talosctl --context <site> -n <cp> bootstrap --recover-from=./etcd-snapshot.db
   ```

   Result: `recovering from snapshot`, with the hash, revision and key count of the snapshot.

5. Make sure that the API server answers.

   ```bash
   kubectl --context <site> get --raw /readyz
   ```

   Result: `ok`, about 20 seconds after the bootstrap.

6. Make sure that each node is `Ready` and that Flux applies `main`.

   ```bash
   kubectl --context <site> get nodes
   flux --context <site> get kustomizations
   ```

   Result: Each node `Ready`, and each Kustomization `True` at the newest revision of `main`.

7. When the cluster works, delete `./etcd-snapshot.db` and `./before-restore*`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `snapshot file integrity check failed` | The file is a copy of the database file, with no hash. | Add `--recover-skip-hash-check` to the bootstrap command. |
| etcd is `Running` after step 3, with the old data. | The reset wiped another volume. | Do step 3 again with `--system-labels-to-wipe=ETCD`. |
| etcd stays `Preparing` after step 4. | The bootstrap did not reach etcd. | Read `talosctl -n <cp> logs etcd`, and make sure that `talosctl -n <cp> get machinetype` is `controlplane`. |
| The cluster does not recover. | The snapshot is bad, or older than the damage. | Do steps 3 and 4 again with an older snapshot, or with `./before-restore.db`. |

## Related

- [Restore etcd](restore-etcd.md)
- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Backups](../platform/backups.md)
