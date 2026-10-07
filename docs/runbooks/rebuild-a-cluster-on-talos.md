---
title: Rebuild a cluster on Talos
description: Replace a cluster's NixOS nodes with Talos Linux, bootstrap a fresh etcd, install Cilium and Flux, and restore the data that has a backup.
---

Use this runbook to move a cluster from NixOS to Talos Linux with a fresh etcd and a new, self-signed Kubernetes CA. The service-account signing key is imported, so the issuer, GCP workload identity and cross-cluster federation stay the same.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because no controller runs until Flux does. The owner applies `clusters/<site>/talos/` and `clusters/<site>/bootstrap/` once, and Atlantis owns them from the next pull request.

## Before you start

> [!NOTE]
> The cluster's Tailscale Connector, `clusters/<site>/networking/tailscale-connectors/connector.yaml`, advertises `K8S_NODE_CIDR` and `LB_RANGE`. Those routes stop when the cluster stops.

- Run `mise run devshell`, and sign in to `op`.
- Set `OP_ACCOUNT` to your 1Password sign-in address. The `onepassword` provider of `clusters/<site>/talos/` and `clusters/<site>/bootstrap/` then uses the desktop app.

  ```bash
  export OP_ACCOUNT=<sign-in address>
  ```

- Set `SOPS_AGE_KEY_FILE` to the operator key, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
- You need write access to objects in the `homelab-ng` state bucket.
- On folly, the `monitoring-crds` Flux Kustomization must be ready: `flux --context folly get kustomization monitoring-crds -n flux-system`.
- `clusters/offsite/apps/atlantis/kubeconfig-hook.sh` and Rowbutt must read the CA only from `clusters/<site>/config/kubernetes-ca.pem`, not `terraform/pki/certs/`.
- On folly, `MATE_SANDBOX_LAB_JUMP` in `clusters/offsite/apps/mate/deployment.yaml` on `main` must not name a folly node, and that change must be deployed. A Talos node runs no sshd, so Rowbutt loses its Lab Net SSH when that node leaves NixOS.
- If your machine takes the Connector's routes, route both ranges through the local LAN, or run `tailscale set --accept-routes=false`.
- Open the cutover pull request as a draft: the Talos root, the Talos values in `clusters/<site>/networking/cilium/helm-release.yaml` and `clusters/<site>/config/cluster-settings.yaml`, and a new `serverName` for each CloudNativePG `Cluster`.

`<site>` is `folly` or `offsite`, and `<checkout>` is a checkout of the cutover branch. `<cp>` is `API_SERVER_IP` in `clusters/<site>/config/cluster-topology.json`.

## Freeze the cluster

1. Freeze the writers and take the last backups, as [Freeze the cluster](move-a-clusters-data-through-a-talos-rebuild.md#freeze-the-cluster) describes.

## Make the secrets bundle

The owner does this section, because it decrypts the signing key.

1. Make the bundle and pin its CA in the cutover pull request, as [Make a Talos secrets bundle](make-a-talos-secrets-bundle.md) describes. It sets `secrets_item_uuid` and issues the admin talosconfig.

## Install the control plane

1. Create the Image Factory schematic, and read its ID.

   ```bash
   cd <checkout>
   tofu -chdir=clusters/<site>/talos init
   tofu -chdir=clusters/<site>/talos apply -target=module.talos.talos_image_factory_schematic.this
   tofu -chdir=clusters/<site>/talos output -raw schematic_id
   ```

2. Boot the control plane into the Talos installer, as [Install Talos on a node](install-talos-on-a-node.md) describes.
3. Mark the cutover pull request ready, and wait for the Atlantis plan comment. Then merge it with the admin bypass. No NixOS control plane is left to apply it, and `atlantis/apply` stays pending because the plan has creates. Do not comment `atlantis apply`.

   ```bash
   gh pr ready <number>
   gh pr merge <number> --admin --merge
   ```

4. Apply the control plane, and create etcd.

   ```bash
   tofu -chdir=clusters/<site>/talos apply -lock-timeout=10m \
     -target=module.talos.talos_machine.controlplane -target=module.talos.talos_cluster.this
   ```

   Result: `talos_cluster.this: Creation complete`.

5. If `talos_cluster` times out, bootstrap etcd by hand. Then do step 4 again.

   ```bash
   talosctl --context <site> -n <cp> bootstrap
   ```

## Join the workers

1. Boot each worker into the Talos installer, as [Install Talos on a node](install-talos-on-a-node.md) describes.
2. Apply the root.

   ```bash
   tofu -chdir=clusters/<site>/talos apply -lock-timeout=10m
   ```

   Result: `Apply complete!`. Each node registers `NotReady` about one minute later.

## Install Cilium and Flux

1. Write the kubeconfig, install Cilium and bootstrap Flux, as [Install Cilium and Flux on Talos](install-cilium-and-flux-on-talos.md) describes.

## Restore the data

1. Restore the databases, the volumes and the kthx Apps, as [Restore the data](move-a-clusters-data-through-a-talos-rebuild.md#restore-the-data) describes.

## Finish

1. Rebase each open pull request. Atlantis reads the CA pin from the pull request's checkout.
2. Do the checks in [Verify a Talos cluster](verify-a-talos-cluster.md).
3. Comment `atlantis plan -d clusters/<site>/talos` on a pull request.

   Result: `No changes`.

4. After the first Talos snapshot, delete the NixOS ones under the old control plane's hostname. Set the Garage remote as [Restore etcd on Talos](restore-etcd-on-talos.md#get-the-snapshot) does.

   ```bash
   rclone purge garage:etcd/<control-plane>/
   ```

5. In a pull request, remove the cluster's hosts from `nix/hosts/default.nix` and its CA files from `terraform/pki/certs/`. Keep `<site>-sa-signer.pem`, which the JWKS reads.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The plan fails with `Create the talos-<site>-secrets Secure Note`. | `secrets_item_uuid` is the placeholder. | Make the bundle. |
| A local `tofu apply` fails with `Error acquiring the state lock`. | An Atlantis plan holds the lock. | Wait for the plan comment, then apply again. If no plan runs, do [Release a stale state lock](release-a-stale-state-lock.md). |
| Atlantis, Rowbutt or the kthx engine fails TLS to the API server. | `kubernetes-ca.pem` holds the old CA, or a pull request predates it. | Pin the new CA, as [Make a Talos secrets bundle](make-a-talos-secrets-bundle.md#pin-the-new-ca) describes, or rebase the pull request. |

## Related

- [Make a Talos secrets bundle](make-a-talos-secrets-bundle.md)
- [Install Talos on a node](install-talos-on-a-node.md)
- [Install Cilium and Flux on Talos](install-cilium-and-flux-on-talos.md)
- [Move a cluster's data through a Talos rebuild](move-a-clusters-data-through-a-talos-rebuild.md)
- [Verify a Talos cluster](verify-a-talos-cluster.md)
- [Restore etcd on Talos](restore-etcd-on-talos.md)
- [OpenTofu](../platform/opentofu.md)
