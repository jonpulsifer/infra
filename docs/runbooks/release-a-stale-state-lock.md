---
title: Release a stale state lock
description: Make sure an OpenTofu state lock is stale, then release it and plan the root again.
---

Use this runbook when a `tofu plan` or `tofu apply` comment on a pull request fails with a lock error, and the Atlantis pod that took the lock is gone. Atlantis holds a state lock for the length of a plan or apply. A pod killed mid-command leaves the lock behind, because the `gcs` backend sets no lock TTL.

> [!WARNING]
> This runbook deletes a GCS lock object by hand. It is an exception to the GitOps rule because a lock object has no expiry, and only a delete releases it. Run it only when the owner asks, and only after you rule out a command that still runs.

## Before you start

- Read the lock's `ID`, `Path` and `Created` time from the "Lock Info" block in the pull request comment where the plan or apply failed.
- Your Google account needs object delete rights on the state bucket that the root's `backend "gcs"` block names in its `versions.tf`. A root whose backend block also sets `impersonate_service_account`, such as `terraform/gcp/projects/bluenose`, needs you to impersonate that account too.
- Run `gcloud auth login` if you have not signed in interactively.

## Release the lock

1. Get the start time of the Atlantis pod.

   ```bash
   kubectl --context offsite -n atlantis get pod atlantis-0 -o jsonpath='{.status.startTime}'
   ```

   Result: the pod's start time, in UTC.

   If the lock's `Created` time is before the pod's start time, a pod that is gone took the lock, and it is stale. If `Created` is at or after the start time, the running pod may still hold it; stop, and read its logs instead.

2. Check the pod for a running `tofu` process.

   ```bash
   kubectl --context offsite -n atlantis exec atlantis-0 -c atlantis -- ps -eo pid,etime,args
   ```

   Result: the process list.

   If a `tofu` command appears, wait for it to finish. Do not release the lock while a `tofu` process runs.

> [!NOTE]
> OpenTofu's `gcs` backend uses the lock object's generation number as its ID. `tofu force-unlock` deletes the object with that generation as a precondition, and the next step reproduces the same delete without a local `tofu init`.

3. Release the lock.

   ```bash
   gcloud storage rm <path> --if-generation-match=<ID>
   ```

   Result: no output.

4. Ask Atlantis to plan the root again.

   ```text
   atlantis plan -d <root>
   ```

   Result: a new `Ran Plan for` comment on the pull request.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `gcloud storage rm` fails with `412 conditionNotMet`. | A newer lock replaced the one you read; the generation changed. | Read the `Lock Info` from the latest failed comment, and start over. |

## Related

- [Apply an OpenTofu change](apply-an-opentofu-change.md): the normal path for a root change.
- [OpenTofu and Atlantis](../platform/opentofu.md): the roots, the state and the Atlantis server.
