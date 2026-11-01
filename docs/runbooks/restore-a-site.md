---
title: Restore a site
description: Copy a kthx quick site's files back from the noncurrent object versions that the sites bucket keeps.
---

Use this runbook when a deploy or `kthx rm` lost files of a [quick site](../apps/kthx/sites.md). The `bluenose-kthx-sites` bucket keeps three noncurrent versions of each object for 30 days, so a file can come back for that long. A site's database is not in the bucket.

## Before you start

- Sign in to `gcloud` as an account that may write the `bluenose-kthx-sites` bucket.
- Know the site's name and the time of the deploy to undo.

## Restore the files

1. List every version of the site's objects.

   ```bash
   gcloud storage ls --all-versions --long 'gs://bluenose-kthx-sites/<name>/**'
   ```

   Result: each line is a version, with its time and a `#<generation>` suffix.

2. For each file to restore, pick the newest version from before the deploy.

3. Copy that version over the live object.

   ```bash
   gcloud storage cp 'gs://bluenose-kthx-sites/<name>/<path>#<generation>' 'gs://bluenose-kthx-sites/<name>/<path>'
   ```

4. If `kthx rm` deleted the site, restore its marker `<name>/.kthx` last. The copy keeps the owner in its metadata.

5. Make sure the site serves the restored files.

   ```bash
   curl -s "https://<name>.kthx.dev/?cachebust=$(date +%s)"
   ```

   Result: the restored page, within about 10 seconds of the copy.

> [!NOTE]
> After `kthx rm`, the kthx server drops the site's database within 10 minutes. [Restore a database](restore-a-database.md) brings back the `kthx-db` cluster, with every site's later writes lost.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `ls` shows no older version | The version is past 30 days, or was the fourth noncurrent one | Deploy the site again from its source. |
| The site answers its API with `404` | The marker is not restored | Restore `<name>/.kthx`. |
| `cp` answers `403` | The account may not write the bucket | Sign in as an account with object write access. |

## Related

- [Quick sites](../apps/kthx/sites.md)
- [Restore a database](restore-a-database.md)
