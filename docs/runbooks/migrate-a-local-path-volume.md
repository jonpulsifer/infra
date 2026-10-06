---
title: Migrate a local-path volume
description: Move a PersistentVolumeClaim from a hostPath volume to a local volume under the same claim name, so that Velero can back it up.
---

Use this runbook for a claim whose volume is a hostPath volume. Velero skips a claim bound to a hostPath volume. The `local-path` StorageClass creates `local` volumes for new claims, and each earlier claim keeps its hostPath volume. The procedure copies the files to a temporary claim, recreates the original claim on a `local` volume, and copies the files back. [Backups](../platform/backups.md) lists the claims that need it.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git holds no data, only the declaration of the claim. Keep the original volume until the workload and its backup pass verification.

## Before you start

- Get `kubectl` access, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Use `jq` and the `velero` CLI from the mise toolchain.
- Know the claim, its namespace, its workload and the Flux object that applies the workload.

`<site>` is `folly` or `offsite`. `<size>` is the size of the claim.

## Migrate the claim

1. Read the volume of the claim.

   ```bash
   kubectl get pvc <pvc> -n <namespace> --context <site> -o jsonpath='{.spec.volumeName}{"\n"}'
   ```

   Result: The PersistentVolume name, `pvc-<uid>`.

2. Make sure that the volume is a hostPath volume.

   ```bash
   kubectl get pv <pv> --context <site> -o jsonpath='{.spec.hostPath.path}{"\n"}'
   ```

   Result: A directory. If the output is empty, the volume is `local`, and the claim needs no migration.

3. Save the claim without its binding.

   ```bash
   kubectl get pvc <pvc> -n <namespace> --context <site> -o json | jq 'del(.status, .spec.volumeName, .metadata.uid, .metadata.resourceVersion, .metadata.creationTimestamp, .metadata.finalizers, .metadata.managedFields, .metadata.annotations["pv.kubernetes.io/bind-completed"], .metadata.annotations["pv.kubernetes.io/bound-by-controller"], .metadata.annotations["volume.kubernetes.io/selected-node"])' > pvc.json
   ```

   Result: A `pvc.json` file.

4. Stop the workload. Suspend the Flux object, scale the workload to zero, and wait until its pods end.

   ```bash
   flux suspend helmrelease <release> -n <namespace> --context <site>
   kubectl scale <deployment|statefulset>/<workload> -n <namespace> --replicas 0 --context <site>
   kubectl wait --for=delete pod -l <selector> -n <namespace> --timeout=5m --context <site>
   ```

5. Create the temporary claim.

   ```bash
   kubectl create -n <namespace> --context <site> -f - <<'YAML'
   apiVersion: v1
   kind: PersistentVolumeClaim
   metadata:
     name: <pvc>-migrate
   spec:
     accessModes: [ReadWriteOnce]
     storageClassName: local-path
     resources:
       requests:
         storage: <size>
   YAML
   ```

6. Copy the files into the temporary claim. The pod mounts `<from>` at `/from` and `<to>` at `/to`. Here `<from>` is `<pvc>` and `<to>` is `<pvc>-migrate`.

   ```bash
   kubectl create -n <namespace> --context <site> -f - <<'YAML'
   apiVersion: v1
   kind: Pod
   metadata:
     name: migrate-copy
   spec:
     restartPolicy: Never
     containers:
       - name: copy
         image: docker.io/library/alpine:3
         command:
           - sh
           - -c
           - |
             set -eu
             cp -a /from/. /to/
             cd /from
             find . -type f -print0 > /tmp/from.files
             xargs -0 sha256sum < /tmp/from.files > /tmp/from.unsorted
             sort /tmp/from.unsorted > /tmp/from.sha
             cd /to
             find . -type f -print0 > /tmp/to.files
             xargs -0 sha256sum < /tmp/to.files > /tmp/to.unsorted
             sort /tmp/to.unsorted > /tmp/to.sha
             diff -u /tmp/from.sha /tmp/to.sha > /dev/null
             echo "File checksums match"
         volumeMounts:
           - {name: from, mountPath: /from, readOnly: true}
           - {name: to, mountPath: /to}
     volumes:
       - name: from
         persistentVolumeClaim: {claimName: <from>}
       - name: to
         persistentVolumeClaim: {claimName: <to>}
   YAML
   kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/migrate-copy -n <namespace> --timeout=30m --context <site>
   ```

   Result: `pod/migrate-copy condition met`.

7. Verify the checksums of the two claims. Delete the copy pod.

   ```bash
   kubectl logs migrate-copy -n <namespace> --context <site>
   kubectl delete pod migrate-copy -n <namespace> --context <site>
   ```

   Result: `File checksums match`. If the copy fails, keep both claims and inspect the pod before continuing.

8. Retain the original volume, then delete and recreate its claim from `pvc.json`. Use the volume name from step 1.

   ```bash
   kubectl patch pv <pv> --type=merge -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}' --context <site>
   kubectl delete pvc <pvc> -n <namespace> --context <site>
   kubectl create -f pvc.json -n <namespace> --context <site>
   ```

9. Copy the files back. Run steps 6 and 7 again with `<from>` as `<pvc>-migrate` and `<to>` as `<pvc>`.

   Result: The pod is `Succeeded`. The original claim is bound to a new volume.

10. Make sure that the new volume is a `local` volume.

    ```bash
    kubectl get pv $(kubectl get pvc <pvc> -n <namespace> --context <site> -o jsonpath='{.spec.volumeName}') --context <site> -o jsonpath='{.spec.local.path}{"\n"}'
    ```

    Result: A directory.

11. Resume the Flux object. Flux scales the workload to its declared replicas.

    ```bash
    flux resume helmrelease <release> -n <namespace> --context <site>
    ```

12. Verify the workload and its backup, as the next section describes, before deleting the temporary claim and `pvc.json`.

    ```bash
    kubectl delete pvc <pvc>-migrate -n <namespace> --context <site>
    ```

    The original PV stays `Released`, with its files on the node. Keep it until the recovery window closes; reclaim it separately after confirming the new copy.

## Check the backup

1. Start a backup from the schedule.

   ```bash
   velero backup create <name> --from-schedule daily --wait --kubecontext <site>
   ```

   Result: `Backup completed with status: Completed`.

2. Make sure that the backup holds the volume.

   ```bash
   velero backup describe <name> --details --kubecontext <site>
   ```

   Result: A `Pod Volume Backups` list with the claim's volume and the phase `Completed`.

> [!NOTE]
> A StatefulSet recreates a missing claim from its `volumeClaimTemplates`, which gives an empty volume. Step 8 recreates the claim first. A Recreate Deployment stops its old pod before it starts a new one, so the claim has one user.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `migrate-copy` is `Pending`. | The temporary claim waits for the pod, or the pod violates the namespace policy. | Run `kubectl describe pod migrate-copy`. Add the securityContext that the namespace requires. |
| The new claim is `Pending` after step 8. | The StorageClass binds a claim when a pod mounts it. | Go on with step 9. |
| The backup has no `Pod Volume Backups` entry. | The pod has no `backup.velero.io/backup-volumes` annotation, or the volume is hostPath. | Do step 10 again. Read the annotation in the pod template. |
| The files have the wrong owners. | The copy did not keep them. | Run the copy pod as root with `cp -a`. |

## Related

- [Backups](../platform/backups.md)
- [Restore a volume](restore-a-volume.md)
