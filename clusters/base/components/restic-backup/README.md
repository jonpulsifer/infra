# restic-backup

A kustomize Component that gives a namespace what a restic backup CronJob
needs to write to this site's staging repository. It adds two objects, both
named `restic`:

| Object | Keys |
| --- | --- |
| `Secret` `restic`, from the `ExternalSecret` `restic` | `RESTIC_PASSWORD`, `RESTIC_REST_USERNAME`, `RESTIC_REST_PASSWORD` |
| `ConfigMap` `restic` | `RESTIC_REPOSITORY` |

The `ExternalSecret` reads the 1Password items `restic-repository` and
`restic-rest-server` through the `onepassword-connect` ClusterSecretStore.
`RESTIC_REPOSITORY` is `rest:http://${RESTIC_STAGING_HOST}:8000/${CLUSTER_NAME}/`.
Each cluster's `config/cluster-settings.yaml` sets `RESTIC_STAGING_HOST`, and
`config/cluster-topology.json` sets `CLUSTER_NAME`.

## Use it

Include the Component from the kustomization that holds the CronJob, and set
`namespace:` there. The Component's objects carry no namespace of their own.

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: <namespace>
components:
  - ../../../base/components/restic-backup
resources:
  - backup.yaml
```

The Flux Kustomization that applies the directory must substitute from
`cluster-settings` and `cluster-topology`. Each cluster's `apps` and the shared
`backups` Kustomization do.

In the backup container, load both objects:

```yaml
envFrom:
  - configMapRef:
      name: restic
  - secretRef:
      name: restic
```

## Producer conventions

- Run `restic backup --host <cluster>/<namespace>/<name> --tag kind=<pg|pvc|etcd>`.
- Schedule daily between 01:00 and 04:00 with `timeZone: ${TIMEZONE}` and
  `concurrencyPolicy: Forbid`, staggered against the other producers.
- Label the CronJob `lolwtf.ca/backup: "true"`.
- Point `RESTIC_CACHE_DIR` at a writable `emptyDir` when the root filesystem
  is read-only. The `restic-push` CronJob in `../../platform/backups/` pins
  the `restic/restic` image to copy.
- Never run `forget` or `prune`. The rest-server is append-only and refuses
  them. The staging host prunes its own repository, and the `restic-push`
  CronJob in `backups` prunes the GCS copy.
- If a NetworkPolicy limits the namespace's egress, allow TCP 8000 to the
  staging host.
