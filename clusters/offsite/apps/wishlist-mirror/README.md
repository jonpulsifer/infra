# wishlist-mirror on offsite

The database behind the offsite copy of [wishin.app](https://wishin.app). The
app itself is a kthx built app: its `service` Component on offsite runs in the
engine's `app-wishlist` namespace and reads this database through its
`DATABASE_URL`. Production stays on Vercel and Neon. Flux applies this
directory from `clusters/offsite/apps/kustomization.yaml`.

| File | What it declares |
| --- | --- |
| `namespace.yaml` | The namespace, at the `restricted` Pod Security level. |
| `cluster.yaml` | The template of the CNPG Cluster `wishlist`, imported from Neon. The refresh job creates it; Flux does not. |
| `cronjob.yaml` | The nightly refresh: delete the Cluster and import it again. |
| `rbac.yaml` | What the refresh job may do: manage the one Cluster. |
| `network-policy.yaml` | Who reaches the database: the operator, the exporter scrape and `app-wishlist`. |
| `external-secret.yaml` | The read-only Neon role `offsite` and its password, from 1Password. |
| `neon-endpoint.sops.yaml` | The Neon endpoint, kept out of the public repository. |
| `wishlist-app.sops.yaml` | The mirror's own credentials, fixed so `DATABASE_URL` survives each refresh. |

## The mirror is disposable

Every night at 04:00 Halifax the refresh replaces the database with a fresh
import of production, so nothing written to the mirror survives. The import
deletes production's sessions and the Google tokens stored at link time, so
the mirror holds no live credentials. It has no backups because Neon is the
source. A failed import leaves no database until the next good run, and
`KubeJobFailed` alerts on it.

Run a refresh now:

```bash
kubectl --context offsite -n wishlist-mirror create job --from=cronjob/wishlist-refresh refresh-now
```
