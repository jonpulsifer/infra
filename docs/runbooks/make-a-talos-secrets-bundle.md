---
title: Make a Talos secrets bundle
description: Generate a cluster's Talos secrets bundle with its imported service-account key, store it in 1Password, and pin its new Kubernetes CA in the cutover pull request.
---

Use this runbook during [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md). The secrets bundle holds every key and CA of a Talos cluster. `talosctl gen secrets` makes a new, self-signed Kubernetes CA. The bundle imports only the service-account signing key, so the issuer and its JWKS do not change. The OpenTofu root in `clusters/<site>/talos/` reads the bundle from 1Password.

The owner runs this runbook, because it reads the signing key out of the cluster's current bundle, the Secure Note `talos-<site>-secrets`.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the bundle is a secret that git does not hold. Keep the bundle on `/dev/shm`, and never commit it.

## Before you start

- Install `talosctl`, `yq`, `jq` and `op`, and sign in to the `homelab` vault.
- Run the commands from the repository checkout, so that mise resolves the tools. A `cd` into `/dev/shm` leaves them behind.

`<site>` is `folly` or `offsite`, and `<checkout>` is a checkout of the cutover branch.

## Make the bundle

1. Make the bundle with the cluster's signing key.

   ```bash
   umask 077; T=$(mktemp -d -p /dev/shm talos.XXXX)
   talosctl gen secrets --talos-version v1.14 -o $T/secrets.yaml
   KEY=$(op read "op://homelab/talos-<site>-secrets/notesPlain" | yq -r '.certs.k8sserviceaccount.key') \
     yq -i '.certs.k8sserviceaccount.key = strenv(KEY)' $T/secrets.yaml
   ```

2. Replace the Secure Note `talos-<site>-secrets`.

   ```bash
   op item delete talos-<site>-secrets --vault homelab
   op item template get "Secure Note" \
     | jq --rawfile n $T/secrets.yaml '.title="talos-<site>-secrets" | .fields |= map(if .id=="notesPlain" then .value=$n else . end)' \
     | op item create --vault homelab - --format json | jq -r .id
   ```

   Result: The UUID of the new item.

3. In the cutover pull request, set `secrets_item_uuid` in `clusters/<site>/talos/talos.tf` to the UUID.

## Pin the new CA

Atlantis, Rowbutt and the kthx engine trust the cluster's API server through `clusters/<site>/config/kubernetes-ca.pem`.

1. In the cutover pull request, replace the pin with the new CA certificate.

   ```bash
   yq -r '.certs.k8s.crt' $T/secrets.yaml | base64 -d > <checkout>/clusters/<site>/config/kubernetes-ca.pem
   ```

2. In the cutover pull request, write the kthx engine's CA bundle: offsite's pin, then folly's.

   ```bash
   cd <checkout>; f=clusters/offsite/apps/spindrift/ca-bundle.yaml
   { sed -n '1,/^  ca.crt: |$/p' "$f"; cat clusters/offsite/config/kubernetes-ca.pem clusters/folly/config/kubernetes-ca.pem | awk 'NF {print "    " $0}'; } > "$f.tmp"
   mv "$f.tmp" "$f"; cd -
   ```

3. Commit both files to the cutover pull request.

## Finish

1. Issue the admin talosconfig from `$T`, as [Issue a talosconfig](issue-a-talosconfig.md) describes.
2. Delete `$T`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `op read` prints `isn't an item`. | The item name is wrong, or the `op` session is a service account without a vault. | Use the exact title, and pass `--vault homelab` to `op item` commands. |
| `mise ERROR No version is set for shim`. | The shell left the checkout, so mise has no project tools. | Run the commands from the checkout and address `$T` by path. |
| The Atlantis plan of `clusters/<site>/talos` fails with `Create the talos-<site>-secrets Secure Note`. | `secrets_item_uuid` is the placeholder. | Do step 3 of [Make the bundle](#make-the-bundle). |

## Related

- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Issue a talosconfig](issue-a-talosconfig.md)
- [PKI](../platform/pki.md)
