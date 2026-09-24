---
title: Get cluster admin access
description: Get kubectl access to folly and offsite with eight-hour tokens, use the break-glass certificate when tokens fail, and withdraw access through git.
---

Use this runbook to get `kubectl` access to the `folly` and `offsite` clusters, or to withdraw it. Each kubectl context uses an eight-hour token for the `operator` ServiceAccount in `kube-system`, which has the `cluster-admin` ClusterRole. `kube-jit-token` mints the token over SSH on the control plane when kubectl needs one. The kubeconfig also holds a break-glass client certificate for each cluster, an emergency credential that works when tokens fail.

## Before you start

- You need SSH access as `jawn` to the control planes, [optiplex](../hosts/optiplex.md) and [retrofit](../hosts/retrofit.md).
- Install the dotfiles, so that `update-kubeconfigs` and `kube-jit-token` are in `~/.local/bin`.
- You need `kubectl` and `jq`.

`<site>` is `folly` or `offsite`.

## Get a kubeconfig

1. Write the kubeconfig.

   ```bash
   update-kubeconfigs
   ```

   Result: `[SUCCESS] Successfully updated kubeconfig at <path>`, and the contexts `folly` and `offsite`. The old file is at `~/.kube/config.backup.<time>`.

2. Make sure that the token works on each cluster.

   ```bash
   kubectl --context <site> get nodes
   ```

   Result: Each node shows `Ready`.

## Use the break-glass certificate

If `kube-jit-token` fails, do this procedure.

> [!NOTE]
> The break-glass user is the `O=system:masters` client certificate of the control plane. The API server checks it with a different authenticator from tokens, so it works when the ServiceAccount, its binding or the token API fails.

1. Run the kubectl command that failed with `--user <site>-breakglass`.

   ```bash
   kubectl --context <site> --user <site>-breakglass get nodes
   ```

   Result: Each node shows `Ready`.

2. If the certificate has expired, run `update-kubeconfigs` again.
3. If both users fail, run kubectl on the control plane.

   ```bash
   ssh optiplex.lolwtf.ca sudo kubectl get nodes   # folly
   ssh retrofit.lolwtf.ca sudo kubectl get nodes   # offsite
   ```

   Result: Each node shows `Ready`.

## Withdraw access

Use this procedure if you lose a workstation or an SSH key that can reach the control planes.

> [!WARNING]
> A lost workstation also holds the break-glass certificates. The API server cannot revoke a certificate. Only a rotation of the cluster CA withdraws them, as [PKI](../platform/pki.md) describes.

> [!NOTE]
> The `config` Flux Kustomization applies `clusters/base/operator-rbac.yaml` to both clusters. If you delete the binding with `kubectl`, Flux creates it again.

1. Remove `operator-rbac.yaml` from `resources` in `clusters/base/kustomization.yaml`.
2. Merge the change through a pull request.
3. On each cluster, fetch the merge commit with the break-glass user.

   ```bash
   flux --context <site> --user <site>-breakglass reconcile source git infra -n flux-system
   ```

   Result: `✔ fetched revision refs/heads/main@sha1:<sha>`.

4. Apply the `config` Flux Kustomization.

   ```bash
   flux --context <site> --user <site>-breakglass reconcile kustomization config -n flux-system
   ```

   Result: `✔ applied revision refs/heads/main@sha1:<sha>`.

5. Make sure that Flux deleted the ServiceAccount.

   ```bash
   kubectl --context <site> --user <site>-breakglass get serviceaccount operator -n kube-system
   ```

   Result: `Error from server (NotFound): serviceaccounts "operator" not found`.

> [!NOTE]
> `nix/system/user.nix` gives the `jawn` user the keys of `https://github.com/jonpulsifer.keys` (the `keys` flake input). It gives the `rowbutt` user, the host user for [Rowbutt](../apps/mate.md), the keys of `https://github.com/rowbutt.keys` (`rowbuttkeys`). Both users are in `wheel`, and `nix/profiles/fleet.nix` gives `wheel` passwordless sudo.

6. Remove the lost SSH key from the GitHub account that holds it.
7. Update the `keys` and `rowbuttkeys` flake inputs.

   ```bash
   nix flake update keys rowbuttkeys
   ```

   Result: `• Updated input` for each input whose keys changed.

8. Merge the change through a pull request.
9. Deploy the control planes, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.

> [!NOTE]
> The other hosts remove the key at their next auto-upgrade from `main`. A host that sets `system.autoUpgrade.enable = false` keeps the key until you deploy it.

10. Deploy each host that sets `system.autoUpgrade.enable = false`.
11. To restore access, revert the change from step 1.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `update-kubeconfigs` prints `Failed to fetch kubeconfig from <site>`. | SSH to the control plane failed. | Make sure that `ssh <address> true` works for the address that the script prints. |
| The script connects to a wrong address. | `get_cluster_ip` in `dotfiles/.local/bin/update-kubeconfigs` holds its own copy of each `API_SERVER_IP`. | Make it match `API_SERVER_IP` in `clusters/<site>/config/cluster-topology.json`. |
| kubectl prints `kube-jit-token: minting through <address> failed`. | SSH or `sudo` on the control plane failed. | Read the rest of the message. Use the break-glass certificate. |
| The `operator` binding comes back after you delete it. | Flux applies `clusters/base/operator-rbac.yaml`. | Remove it in git, as [Withdraw access](#withdraw-access) describes. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [PKI](../platform/pki.md): the cluster CAs.
