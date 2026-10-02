# garage-cnpg

A kustomize Component that gives a namespace the credentials a CloudNativePG
database needs to back up to this site's Garage. It adds one object:

| Object | Keys |
| --- | --- |
| `Secret` `garage-cnpg`, from the `ExternalSecret` `garage-cnpg` | `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY`, `REGION` |

The `ExternalSecret` reads the `cnpg-access-key-id` and
`cnpg-secret-access-key` fields of the 1Password item `garage-${CLUSTER_NAME}`
through the `onepassword-connect` ClusterSecretStore. `REGION` is `garage`.
`config/cluster-topology.json` sets `CLUSTER_NAME`.

## Use it

Include the Component from the kustomization that holds the database, and set
`namespace:` there. The Component's object carries no namespace of its own.

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: <namespace>
components:
  - ../../../base/components/garage-cnpg
resources:
  - database.yaml
```

The Flux Kustomization that applies the directory must substitute from
`cluster-topology`. Each cluster's `apps` Kustomization does.

## Producer conventions

- Add an `ObjectStore` named `garage` in the database's namespace. Its
  `destinationPath` is `s3://cnpg/<namespace>/`, its `endpointURL` is the
  `GARAGE_S3_ENDPOINT` key of `cluster-settings`, and its `s3Credentials`
  name this Secret.
- Point the `Cluster` at it with a `spec.plugins` entry for
  `barman-cloud.cloudnative-pg.io` with `isWALArchiver: true`, and add a
  `ScheduledBackup` with `method: plugin`.
- Schedule the backup daily between 01:00 and 04:00 in `${TIMEZONE}`,
  staggered against the other databases.
- Retention belongs to the `ObjectStore`'s `retentionPolicy`; a backup job
  never prunes the bucket itself.
- If a NetworkPolicy limits the namespace's egress, allow TCP 3900 to the
  Garage host.
