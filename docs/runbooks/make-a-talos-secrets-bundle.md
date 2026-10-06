---
title: Make a Talos secrets bundle
description: Generate a cluster's Talos secrets bundle with its imported service-account key, store it in 1Password, and pin its new Kubernetes CA in the cutover pull request.
---

Use this runbook during [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md). The secrets bundle holds every key and CA of a Talos cluster. `talosctl gen secrets` makes a new, self-signed Kubernetes CA. The bundle imports only the service-account signing key, so the issuer and its JWKS do not change. The OpenTofu root in `clusters/<site>/talos/` reads the bundle from 1Password.

The owner runs this runbook, because it decrypts the signing key. Run it before the pull request that removes the cluster's hosts merges, because that pull request deletes the key's SOPS file.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the bundle is a secret that git does not hold. Keep the bundle on `/dev/shm`, and never commit it.

## Before you start

- Install `talosctl`, `sops`, `yq`, `jq` and `op`, and sign in to the `homelab` vault.
- Set `SOPS_AGE_KEY_FILE` to the operator key, as [Manage SOPS secrets](manage-sops-secrets.md) describes.

`<site>` is `folly` or `offsite`, and `<control-plane>` is its control plane, `optiplex` or `retrofit`. `<checkout>` is a checkout of the cutover branch.

## Make the bundle

1. Make the bundle with the cluster's signing key.

   ```bash
   umask 077; cd "$(mktemp -d -p /dev/shm talos.XXXX)"
   talosctl gen secrets --talos-version v1.14 -o secrets.yaml
   KEY=$(sops -d --extract '["k8s-sa-signing-key"]' <checkout>/nix/secrets/<control-plane>.sops.yaml | base64 -w0) \
     yq -i '.certs.k8sserviceaccount.key = strenv(KEY)' secrets.yaml
   ```

2. Store it as the Secure Note `talos-<site>-secrets`.

   ```bash
   op item template get "Secure Note" \
     | jq --rawfile n secrets.yaml '.title="talos-<site>-secrets" | .fields |= map(if .id=="notesPlain" then .value=$n else . end)' \
     | op item create --vault homelab --template - --format json | jq -r .id
   ```

   Result: The UUID of the item.

3. In the cutover pull request, set `secrets_item_uuid` in `clusters/<site>/talos/talos.tf` to the UUID.

## Pin the new CA

Atlantis, Rowbutt and the kthx engine trust the cluster's API server through `clusters/<site>/config/kubernetes-ca.pem`.

1. In the cutover pull request, replace the pin with the new CA certificate. The pin is a symlink until then, so remove it first.

   ```bash
   rm <checkout>/clusters/<site>/config/kubernetes-ca.pem
   yq -r '.certs.k8s.crt' secrets.yaml | base64 -d > <checkout>/clusters/<site>/config/kubernetes-ca.pem
   ```

2. In the cutover pull request, write the kthx engine's CA bundle: offsite's CA, then folly's. `<offsite-ca>` is `terraform/pki/certs/offsite-ca-chain.pem` while offsite runs NixOS, and `clusters/offsite/config/kubernetes-ca.pem` after.

   ```bash
   cd <checkout>; f=clusters/offsite/apps/spindrift/ca-bundle.yaml
   { sed -n '1,/^  ca.crt: |$/p' "$f"; cat <offsite-ca> clusters/folly/config/kubernetes-ca.pem | awk 'NF {print "    " $0}'; } > "$f.tmp"
   mv "$f.tmp" "$f"; cd -
   ```

3. Commit both files to the cutover pull request.

## Finish

1. Issue the admin talosconfig, as [Issue a talosconfig](issue-a-talosconfig.md) describes.
2. Delete the directory under `/dev/shm`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `sops` fails with `failed to load age identities`. | `SOPS_AGE_KEY_FILE` is not set. | Set it, as [Manage SOPS secrets](manage-sops-secrets.md) describes. |
| `git diff` shows a change to `terraform/pki/certs/<site>-ca-bundle.pem`. | The pin was written through its symlink. | Restore that file from `main`, then do step 1 of [Pin the new CA](#pin-the-new-ca). |
| The Atlantis plan of `clusters/<site>/talos` fails with `Create the talos-<site>-secrets Secure Note`. | `secrets_item_uuid` is the placeholder. | Do step 3 of [Make the bundle](#make-the-bundle). |

## Related

- [Rebuild a cluster on Talos](rebuild-a-cluster-on-talos.md)
- [Issue a talosconfig](issue-a-talosconfig.md)
- [PKI](../platform/pki.md)
