---
title: Restore from the GCS copy
description: Copy a Garage bucket back from the encrypted GCS copy of its site, when Garage has lost the bucket.
---

Use this runbook when the Garage of a site has lost the bucket that a restore needs. `backup-push` keeps an encrypted copy of each bucket in GCS. The restore runbooks send you here. The tools come from the repo's mise toolchain.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because git holds no backup data.

## Before you start

- Sign in to `op` and `gcloud`.
- Know the site, `folly` or `offsite`, and the bucket: `velero`, `cnpg` or `etcd`. The Garage key of the bucket has the same name.
- Read `GARAGE_S3_ENDPOINT` in `clusters/<site>/config/cluster-settings.yaml`.

## Copy the bucket

1. Put the crypt remote in the environment. The values stay out of the shell history.

   ```bash
   export RCLONE_CONFIG_GCS_TYPE="google cloud storage" RCLONE_CONFIG_GCS_ENV_AUTH=true RCLONE_CONFIG_GCS_BUCKET_POLICY_ONLY=true
   export RCLONE_CONFIG_CRYPT_TYPE=crypt RCLONE_CONFIG_CRYPT_REMOTE="gcs:homelab-ng-backups-<site>/garage"
   export RCLONE_CONFIG_CRYPT_PASSWORD="$(op read 'op://homelab/backup-crypt/rclone-password' | rclone obscure -)"
   export RCLONE_CONFIG_CRYPT_PASSWORD2="$(op read 'op://homelab/backup-crypt/rclone-salt' | rclone obscure -)"
   gcloud auth application-default login
   export GOOGLE_PROJECT_ID=homelab-ng
   ```

2. Put the Garage remote in the environment.

   ```bash
   export RCLONE_CONFIG_GARAGE_TYPE=s3 RCLONE_CONFIG_GARAGE_PROVIDER=Other RCLONE_CONFIG_GARAGE_REGION=garage
   export RCLONE_CONFIG_GARAGE_ENDPOINT=<endpoint>
   export RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID="$(op read 'op://homelab/garage-<site>/<bucket>-access-key-id')"
   export RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY="$(op read 'op://homelab/garage-<site>/<bucket>-secret-access-key')"
   ```

3. Copy the bucket into Garage.

   ```bash
   rclone copy crypt:<bucket> garage:<bucket> --progress
   ```

   Result: A transfer summary with no errors.

## Copy from inside the cluster

Use this procedure for a large copy, or when your machine sits behind Starlink, which the copy would cross twice. The `backup-push` CronJob in `backups` already holds the GCS credential, the crypt remote and a Garage key, so a Job cloned from it does the copy with `rclone copy` reversed. Its `push` key reads the buckets only, so grant it write access for the copy and withdraw it after.

1. Grant the `push` key write access to each bucket.

   ```bash
   for b in velero cnpg etcd; do kubectl --context <site> -n garage exec garage-0 -c garage -- /garage bucket allow --read --write "$b" --key push; done
   ```

2. Create the Job from the CronJob's pod template, with the copy reversed.

   ```bash
   kubectl --context <site> -n backups get cronjob backup-push -o json | jq '{apiVersion: "batch/v1", kind: "Job", metadata: {name: "garage-refill", namespace: "backups"}, spec: {backoffLimit: 0, ttlSecondsAfterFinished: 86400, template: (.spec.jobTemplate.spec.template | .spec.containers[0].env += [{name: "RCLONE_CONFIG_GARAGE_NO_CHECK_BUCKET", value: "true"}] | .spec.containers[0].command = ["sh", "-c", "set -eu\nRCLONE_CONFIG_CRYPT_PASSWORD=$(printf %s \"$CRYPT_PASSWORD\" | rclone obscure -)\nRCLONE_CONFIG_CRYPT_PASSWORD2=$(printf %s \"$CRYPT_SALT\" | rclone obscure -)\nexport RCLONE_CONFIG_CRYPT_PASSWORD RCLONE_CONFIG_CRYPT_PASSWORD2\nfor bucket in velero cnpg etcd; do\n  rclone copy \"crypt:$bucket\" \"garage:$bucket\" --stats 1m --stats-one-line --stats-log-level NOTICE\n  rclone cryptcheck \"garage:$bucket\" \"crypt:$bucket\"\ndone\n"])}}' | kubectl --context <site> create -f -
   kubectl --context <site> -n backups wait --for=condition=complete job/garage-refill --timeout=1h
   ```

   Result: `job.batch/garage-refill condition met`, and the Job's log ends with `0 differences found` for each bucket.

3. Withdraw the write access.

   ```bash
   for b in velero cnpg etcd; do kubectl --context <site> -n garage exec garage-0 -c garage -- /garage bucket deny --write "$b" --key push; done
   ```

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `rclone` prints `didn't find section in config file`. | An environment variable is missing. | Set the remote variables again. |
| `rclone` prints a decryption error. | The crypt password or salt is wrong. | Read both from the `backup-crypt` item again. |
| `rclone` prints a 403. | The Garage key is for another bucket. | Use the key that has the name of the bucket. |

## Related

- [Backups](../platform/backups.md)
- [Restore a database](restore-a-database.md)
- [Restore a volume](restore-a-volume.md)
- [Restore etcd on Talos](restore-etcd-on-talos.md)
