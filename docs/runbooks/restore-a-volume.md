---
title: Restore a volume
description: Restore a local-path or NFS volume from a restic kind=pvc snapshot on the host that stores it.
---

Use this runbook to restore the files of a PersistentVolumeClaim from a `kind=pvc` snapshot. restic runs as root on the host that stores the volume, so the files keep their owners. A `local-path` volume is a directory on its node, and a folly NFS volume is a directory on [spore](../hosts/spore.md). [Backups](../platform/backups.md) describes the snapshots.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git holds no data, only the declaration of the volume.

## Before you start

- Get `kubectl` access, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Get SSH access to the host that stores the volume, with `sudo`.
- Have the 1Password items `restic-repository` and `restic-rest-server` open.

`<site>` is `folly` or `offsite`. The staging host is `spore` for folly and `oldschool` for offsite.

## Find the volume

1. Read the name of the PersistentVolume.

   ```bash
   kubectl get pvc <pvc> -n <namespace> --context <site> -o jsonpath='{.spec.volumeName}{"\n"}'
   ```

   Result: The PersistentVolume name, `pvc-<uid>`.

2. Read the directory and the node of a `local-path` volume.

   ```bash
   kubectl get pv <pv> --context <site> -o jsonpath='{.spec.hostPath.path}{"\n"}{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}{"\n"}'
   ```

   Result: A directory under `/mnt/disks`, then the node name.

3. If step 2 printed no directory, read the NFS path.

   ```bash
   kubectl get pv <pv> --context <site> -o jsonpath='{.spec.nfs.path}{"\n"}'
   ```

   Result: A directory under the spore export. Restore it on spore.

## Restore the volume

1. Stop the app that mounts the volume. Suspend its HelmRelease or Kustomization, then scale it to zero.

   ```bash
   flux suspend helmrelease <release> -n <namespace> --context <site>
   kubectl scale deployment <app> -n <namespace> --replicas 0 --context <site>
   ```

2. Make sure that no pod mounts the claim.

   ```bash
   kubectl get pods -n <namespace> --context <site> -o wide
   ```

   Result: No pod of the app.

3. Open a root shell with restic on the host from [Find the volume](#find-the-volume).

   ```bash
   ssh -t <host>.lolwtf.ca sudo nix shell nixpkgs#restic
   ```

4. Type the repository key and the rest-server login. The values stay out of the shell history.

   ```bash
   read -rs RESTIC_PASSWORD && export RESTIC_PASSWORD
   read -rs RESTIC_REST_PASSWORD && export RESTIC_REST_PASSWORD
   export RESTIC_REST_USERNAME=restic
   export RESTIC_REPOSITORY="rest:http://<staging-host>.lolwtf.ca:8000/<site>/"
   ```

5. List the snapshots of the volume.

   ```bash
   restic snapshots --tag kind=pvc --host <site>/<namespace>/<name>
   ```

   Result: A table of snapshots. `Paths` is the directory that the backup pod mounted.

6. Move the current files aside.

   ```bash
   mv <directory> <directory>.before-restore
   ```

7. Restore the snapshot into the directory. `<path>` is the `Paths` value from step 5.

   ```bash
   restic restore <snapshot-id>:<path> --target <directory>
   ```

   Result: `Summary: Restored <n> files/dirs`.

8. Make sure that the directory mode matches the old directory.

   ```bash
   stat -c '%a %U:%G' <directory> <directory>.before-restore
   ```

   Result: The same mode and owner on both lines.

9. Exit the shell, then resume the release.

   ```bash
   flux resume helmrelease <release> -n <namespace> --context <site>
   ```

10. When the app works, delete `<directory>.before-restore` on the host.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `Fatal: wrong password or no key found` | The typed key is not the `restic-repository` password. | Type the password again. |
| `unexpected HTTP response (401)` | The rest-server login is wrong. | Type the `restic-rest-server` password again. |
| The staging host is down. | The repository is not reachable. | On your machine, open the GCS repository, as [Open a repository](restore-a-database.md#open-a-repository) describes. Restore there, copy the files to the host with `scp`, and set their owners with `chown`. |
| The app pod is `Pending` after the resume. | The `local-path` volume is bound to its node. | Make sure that the node is `Ready`. |
| The app cannot write its files. | The restored directory has the wrong mode. | Run `chmod` with the mode of `<directory>.before-restore`. |

## Related

- [Backups](../platform/backups.md)
- [Restore a database](restore-a-database.md)
- [Kubernetes](../platform/kubernetes.md)
