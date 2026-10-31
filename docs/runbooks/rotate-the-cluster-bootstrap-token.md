---
title: Rotate the cluster bootstrap token
description: Replace folly's cluster-wide Kubernetes bootstrap token in the Talos secrets bundle, apply it to the nodes that carry it, and delete the old token.
---

Use this runbook to replace folly's cluster-wide bootstrap token, the `secrets.bootstraptoken` of the Talos secrets bundle. The control plane and shale carry it as `cluster.token`, and the control plane's Talos creates it in `kube-system` as `bootstrap-token-<id>`. A disk, an image or a config written with the token can ask for a kubelet certificate until the token is rotated, and the owner decides whether to approve it. The workers that [fleetd](../apps/fleetd.md) installs carry `nojoin.0000000000000000` and do not change. Rotate the token when a disk, an image or a config that holds it leaves your control.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because the bundle is a secret that git does not hold, and Talos never deletes a token it created.

## Before you start

- Install `yq`, `jq` and `op`, and sign in to the `homelab` vault.
- Get `kubectl` access to folly, as [Get cluster admin access](get-cluster-admin-access.md) describes.
- Open a pull request, as [Apply an OpenTofu change](apply-an-opentofu-change.md) describes. Its `atlantis apply` applies the new token and merges it.
- Run the commands from the repository checkout, so that mise resolves the tools.

## Replace the token in the bundle

1. Read the bundle, and write down the old token ID.

   ```bash
   umask 077; T=$(mktemp -d -p /dev/shm talos.XXXX)
   op read "op://homelab/talos-folly-secrets/notesPlain" > $T/secrets.yaml
   OLD=$(yq -r '.secrets.bootstraptoken' $T/secrets.yaml | cut -d. -f1); echo $OLD
   ```

   Result: Six characters, the ID of the token that `kube-system` holds as `bootstrap-token-<id>`.

2. Put a new random token in the bundle.

   ```bash
   NEW=$(LC_ALL=C tr -dc a-z0-9 </dev/urandom | head -c 22 | sed 's/^....../&./') \
     yq -i '.secrets.bootstraptoken = strenv(NEW)' $T/secrets.yaml
   ```

3. Write the bundle back to the Secure Note `talos-folly-secrets`.

   ```bash
   op item get talos-folly-secrets --vault homelab --format json \
     | jq --rawfile n $T/secrets.yaml '.fields |= map(if .id=="notesPlain" then .value=$n else . end)' \
     | op item edit talos-folly-secrets --vault homelab >/dev/null
   ```

4. Delete `$T`.

## Apply the new token

1. On the pull request, comment the plan command for the Talos root.

   ```text
   atlantis plan -d clusters/folly/talos
   ```

   Result: The plan updates the `talos_machine` of the control plane and shale. It changes no fleetd-installed worker.

2. Apply the plan.

   ```text
   atlantis apply
   ```

   Result: `Ran Apply for` and the merge. The apply reboots no node, since the installer image does not change.

3. Make sure that the control plane created the new token.

   ```bash
   kubectl --context folly -n kube-system get secrets --field-selector type=bootstrap.kubernetes.io/token
   ```

   Result: `bootstrap-token-<new id>`, the old token, and any token fleetd holds for an install in progress.

## Delete the old token

1. Delete the old token.

   ```bash
   kubectl --context folly -n kube-system delete secret bootstrap-token-$OLD
   ```

   Result: kubectl names the old token's Secret. The API server refuses the old token from then on. A running kubelet renews with its own certificate, so every node keeps running.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The plan changes a fleetd-installed worker, or a node's installer image. | The pull request changes more than the token. | Do not apply. Take the other change out of the pull request, and plan again. |
| No `bootstrap-token-<new id>` appears. | The control plane did not apply its new config. | Comment `atlantis plan -d clusters/folly/talos` again. If the plan still changes the control plane, apply it. |
| A node that joins later stays `NotReady` with a pending CSR. | The controller manager approves no bootstrap request on folly. | Approve it, as [Install Talos on a node](install-talos-on-a-node.md#approve-the-nodes-first-certificate) describes. |

## Related

- [fleetd](../apps/fleetd.md)
- [Talos Linux](../platform/kubernetes/talos.md)
- [Make a Talos secrets bundle](make-a-talos-secrets-bundle.md)
- [Install Talos on a node](install-talos-on-a-node.md)
