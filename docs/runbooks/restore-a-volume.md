---
title: Restore a volume
description: Restore the files of a volume from a Velero backup in Garage, or from the encrypted GCS copy, when the volume is lost or damaged.
---

Use this runbook to restore a PersistentVolumeClaim from a Velero backup. Velero restores the claim, its pod and the files that the node agent backed up with kopia. Only a pod with the annotation `backup.velero.io/backup-volumes` has a copy of its volumes. [Backups](../platform/backups.md) describes the schedule and the retention.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git holds no data, only the declaration of the volume.

## Before you start

- Get `kubectl` access, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Use the `velero` CLI from the mise toolchain. Pass `--kubecontext <site>` to each `velero` command.
- If Garage has lost the `velero` bucket, follow [Restore from the GCS copy](restore-from-the-gcs-copy.md). Then wait one minute for Velero to read the bucket.

`<site>` is `folly` or `offsite`.

## Restore the volume

1. Find the newest completed backup of the schedule `daily`.

   ```bash
   velero backup get --selector velero.io/schedule-name=daily --kubecontext <site>
   ```

   Result: Backup names of the form `daily-<timestamp>`.

2. Make sure that the backup holds the volume.

   ```bash
   velero backup describe <backup> --details --kubecontext <site>
   ```

   Result: A `Pod Volume Backups` list with the volume and the phase `Completed`.

3. Stop the app that mounts the volume. Suspend its HelmRelease or Kustomization, then scale it to zero.

   ```bash
   flux suspend helmrelease <release> -n <namespace> --context <site>
   kubectl scale deployment <app> -n <namespace> --replicas 0 --context <site>
   ```

4. Delete the claim. Velero skips an object that exists.

   ```bash
   kubectl delete pvc <pvc> -n <namespace> --context <site>
   ```

   Result: `persistentvolumeclaim "<pvc>" deleted`.

5. Restore the pod, the claim and the volume. Do not use `--selector`. Include `persistentvolumes`, or the claim stays `Pending`.

   ```bash
   velero restore create --from-backup <backup> --include-namespaces <namespace> --include-resources pods,persistentvolumeclaims,persistentvolumes --wait --kubecontext <site>
   ```

   Result: `Restore completed with status: Completed`.

6. Make sure that the restore filled the volume.

   ```bash
   velero restore describe <restore> --details --kubecontext <site>
   ```

   Result: A `Pod Volume Restores` list with the phase `Completed`.

7. Resume the release.

   ```bash
   flux resume helmrelease <release> -n <namespace> --context <site>
   ```

8. Make sure that the restored pod is `Running` and has the files. Name the container, because the pod keeps the `restore-wait` init container.

   ```bash
   kubectl exec <pod> -c <container> -n <namespace> --context <site> -- ls <mount-path>
   ```

9. Delete the restored pod. The Deployment pod must not share the claim with it.

   ```bash
   kubectl delete pod <pod> -n <namespace> --context <site>
   ```

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `velero backup get` lists no backups. | The BackupStorageLocation is unavailable. | Run `velero backup-location get --kubecontext <site>`. Make sure that Garage answers. |
| The backup has no `Pod Volume Backups`. | The pod has no annotation, or its PVC is bound to a hostPath volume. | Follow [Migrate a local-path volume](migrate-a-local-path-volume.md). Restore an older backup that has the volume. |
| The restore is `PartiallyFailed`. | An object exists, or a plugin is missing. | Run `velero restore logs <restore> --kubecontext <site>`. Delete the object that exists, then restore again. |
| The restore stays `InProgress`, and `velero restore delete` waits. | The restored pod does not run, so its PodVolumeRestore never ends. | Run `kubectl -n velero patch podvolumerestore <pvr> --type merge -p '{"spec":{"cancel":true}}'`. |
| The restored pod is `Init` for a long time. | The init container restores the volume. | Wait. Read `kubectl logs <pod> -c restore-wait -n <namespace>`. |

## Restore beside the live volume

Use this procedure to test a backup while the app runs. It leaves the live volume as it is.

> [!WARNING]
> A resource modifier patch that fails does not block the object. Velero creates the object unmodified and reports only a namespace error at the end. Use `test` operations. Make sure that the pod spec is right after creation.

1. Restore into a new namespace. Include the same three resources as step 5.

   ```bash
   velero restore create --from-backup <backup> --include-namespaces <namespace> --namespace-mappings <namespace>:drill-<namespace> --include-resources pods,persistentvolumeclaims,persistentvolumes --resource-modifier-configmap <modifiers> --wait --kubecontext <site>
   ```

2. Put a resource modifier ConfigMap in the `velero` namespace first. The rules drop scarce resources such as `gpu.intel.com/i915` from limits and requests. They drop hostPath mounts of live data. They set the container command to `sleep infinity`.

3. Do not patch `/metadata/ownerReferences`. Velero removes it, and the patch fails.

4. Make sure that the restored claim is `Bound` to a new volume. Compare the files with the live pod.

5. Delete the namespace `drill-<namespace>`. If a restore stays `InProgress`, use the troubleshooting row above.

## Related

- [Backups](../platform/backups.md)
- [Restore a database](restore-a-database.md)
- [Migrate a local-path volume](migrate-a-local-path-volume.md)
