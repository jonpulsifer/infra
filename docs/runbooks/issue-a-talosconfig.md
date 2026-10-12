---
title: Issue a talosconfig
description: Mint the owner's os:admin talosconfig for a Talos cluster and Rowbutt's os:reader one, and store each in 1Password.
---

Use this runbook when a cluster moves to Talos, and before a talosconfig certificate expires. A talosconfig is the client certificate and endpoints that `talosctl` uses to reach the Talos API. Its certificate lasts one year. Today only folly runs Talos, so each item below holds folly alone.

| 1Password item | Type and file name | Holds |
| --- | --- | --- |
| `talos-<site>-secrets` | Secure Note | The cluster's secrets bundle, which Atlantis reads |
| `talos-<site>-admin` | Document, `talosconfig` | The owner's `os:admin` talosconfig, with one context named `<site>` |
| `talos-rowbutt-reader` | Document, `talosconfig` | Rowbutt's `os:reader` talosconfig, with a context for each Talos cluster |

`<site>` is `folly` or `offsite`, and `<checkout>` is a checkout of this repository.

## Before you start

- You need `talosctl`, `jq`, `yq` and `op`, signed in to the `homelab` vault.
- The item `talos-<site>-secrets` exists.

## Issue the admin talosconfig

> [!WARNING]
> The Talos API cannot revoke a client certificate. Keep the files out of the repository, and delete them after the upload.

1. Go to a new directory under `/dev/shm`.
2. Mint the `os:admin` file from the cluster's secrets bundle.

   ```bash
   topology=<checkout>/clusters/<site>/config/cluster-topology.json
   op read "op://homelab/talos-<site>-secrets/notesPlain" > secrets.yaml
   talosctl gen config --with-secrets secrets.yaml --output-types talosconfig -o admin \
     <site> "https://$(jq -r .data.API_SERVER_HOSTNAME "$topology"):6443"
   ```

   Result: `Created admin`.

3. Set its endpoint and node to `API_SERVER_IP`.

   ```bash
   ip=$(jq -r .data.API_SERVER_IP "$topology")
   talosctl --talosconfig admin --context <site> config endpoint "$ip"
   talosctl --talosconfig admin --context <site> config node "$ip"
   ```

4. If the item `talos-<site>-admin` exists, delete it.
5. Store the file as the Document `talos-<site>-admin`.

   ```bash
   op document create admin --title talos-<site>-admin --file-name talosconfig --vault homelab
   ```

6. Delete the directory.
7. Add the context to your workstation, as [Get cluster admin access](get-cluster-admin-access.md#get-a-kubeconfig) describes.

## Issue the Rowbutt talosconfig

1. Go to a new directory under `/dev/shm`.
2. For each cluster that runs Talos, mint an `os:reader` file with your admin context, and merge it into `reader`. `config new` names its context `reader@<site>`, so rename it to `<site>` before the merge.

   ```bash
   ip=$(jq -r .data.API_SERVER_IP <checkout>/clusters/<site>/config/cluster-topology.json)
   talosctl --context <site> config new --roles os:reader --crt-ttl 8760h reader-<site>
   yq -i '.context = "<site>" | .contexts = {"<site>": .contexts["reader@<site>"]}' reader-<site>
   talosctl --talosconfig reader config merge reader-<site>
   talosctl --talosconfig reader --context <site> config endpoint "$ip"
   ```

3. Make sure that `reader` has one context for each cluster that runs Talos.

   ```bash
   talosctl --talosconfig reader config contexts
   ```

   Result: One row for each such cluster, named `folly` or `offsite`.

4. If the item `talos-rowbutt-reader` exists, delete it.
5. Store `reader` as the Document `talos-rowbutt-reader`.

   ```bash
   op document create reader --title talos-rowbutt-reader --file-name talosconfig --vault homelab
   ```

6. Delete the directory.
7. Make sure that the ExternalSecret has synced. It refreshes every hour.

   ```bash
   kubectl --context offsite -n mate get externalsecret mate-sandbox-talos
   ```

   Result: `STATUS` is `SecretSynced`.

8. Restart mate, which reads the file when it starts.

   ```bash
   kubectl --context offsite -n mate rollout restart deploy/mate
   ```

   Result: `deployment.apps/mate restarted`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| mate logs `the sandbox talosconfig could not be read`, with `grants os:admin`. | The Document holds a certificate with a role other than `os:reader`. | Issue the Rowbutt talosconfig again. Then rotate the OS CA with `talosctl rotate-ca`, because the stored certificate cannot be revoked. |
| mate logs `no sandbox talosconfig yet`. | The Secret `mate-sandbox-talos` is absent. | Make sure that the item exists and the ExternalSecret has synced. |
| `config contexts` shows `<site>-1`. | The merge renamed a context that was already in the file. | Start again in a new directory. |

## Related

- [Get cluster admin access](get-cluster-admin-access.md)
- [PKI](../platform/pki.md): the talosconfig certificates.
- [How Rowbutt works](../apps/mate/how-it-works.md#credentials): the sandbox talosconfig.
