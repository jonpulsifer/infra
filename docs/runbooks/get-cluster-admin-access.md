---
title: Get cluster admin access
description: Get kubectl access to folly and offsite with eight-hour tokens through talosctl or SSH, use the break-glass certificate when tokens fail, and withdraw access.
---

Use this runbook to get `kubectl` access to the `folly` and `offsite` clusters, or to withdraw it. Each kubectl context uses an eight-hour token for the `operator` ServiceAccount in `kube-system`, which has the `cluster-admin` ClusterRole. The kubeconfig also holds a break-glass client certificate for each cluster, for when tokens fail.

| Path | For a cluster | Certificate from | Token minted |
| --- | --- | --- | --- |
| Talos | Named by a context in `~/.talos/config` | `talosctl kubeconfig` | Locally, as the break-glass user |
| SSH | With no such context | `sudo kubectl` on the control plane | Over SSH |

Both control planes run NixOS, so both clusters take the SSH path.

## Before you start

- Install the dotfiles, so that `update-kubeconfigs` and `kube-jit-token` are in `~/.local/bin`.
- You need `kubectl` and `jq`.
- For the SSH path, you need SSH access as `jawn` to the control planes, [optiplex](../hosts/optiplex.md) and [retrofit](../hosts/retrofit.md).
- For the Talos path, you need `talosctl`, `op` and the item that [Issue a talosconfig](issue-a-talosconfig.md) creates.

`<site>` is `folly` or `offsite`.

## Get a kubeconfig

1. If the cluster runs Talos, add its admin context to `~/.talos/config`.

   ```bash
   talosctl config remove <site> --noconfirm   # an old context; merge renames a duplicate
   op document get talos-<site>-admin --vault homelab --out-file /dev/shm/talos-<site>
   talosctl config merge /dev/shm/talos-<site> && rm /dev/shm/talos-<site>
   ```

2. Write the kubeconfig.

   ```bash
   update-kubeconfigs
   ```

   Result: `[SUCCESS] Successfully updated kubeconfig at <path>`, and the contexts `folly` and `offsite`. The old file is at `~/.kube/config.backup.<time>`.

3. Make sure that the token works on each cluster.

   ```bash
   kubectl --context <site> get nodes
   ```

   Result: Each node shows `Ready`.

## Use the break-glass certificate

If `kube-jit-token` fails, do this procedure.

> [!NOTE]
> The break-glass user is an `O=system:masters` client certificate. The API server checks it with a different authenticator from tokens, so it works when the ServiceAccount, its binding or the token API fails.

1. Run the kubectl command that failed with `--user <site>-breakglass`.

   ```bash
   kubectl --context <site> --user <site>-breakglass get nodes
   ```

   Result: Each node shows `Ready`.

2. If the certificate has expired, run `update-kubeconfigs` again.
3. If both users fail on the SSH path, run kubectl on the control plane.

   ```bash
   ssh optiplex.lolwtf.ca sudo kubectl get nodes   # folly
   ssh retrofit.lolwtf.ca sudo kubectl get nodes   # offsite
   ```

   Result: Each node shows `Ready`.

4. If both users fail on the Talos path, check the control plane.

   ```bash
   talosctl --context <site> health
   ```

## Withdraw access

Use this procedure if you lose a workstation, an SSH key or a talosconfig.

> [!WARNING]
> A lost workstation also holds the break-glass certificates and the talosconfig. Nothing can revoke them. Only a CA rotation withdraws them, as [PKI](../platform/pki.md) describes.

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
| The same message says `with talosctl`. | The Talos API failed. A NixOS control plane has none. | Run `talosctl --context <site> version`, or remove a NixOS cluster's context. |
| The script connects to a wrong address. | The checkout that the script is linked from has an old `clusters/<site>/config/cluster-topology.json`. | Pull the checkout, or set `INFRA_DIR` to an up-to-date one. |
| kubectl prints `kube-jit-token: minting through <address> failed`. | SSH or `sudo` on the control plane failed. | Use the break-glass certificate. |
| kubectl prints `kube-jit-token: minting as <site>-breakglass failed`. | The admin certificate expired. | Run `update-kubeconfigs`. |
| The `operator` binding comes back after you delete it. | Flux applies `clusters/base/operator-rbac.yaml`. | Remove it in git, as [Withdraw access](#withdraw-access) describes. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [Issue a talosconfig](issue-a-talosconfig.md)
- [PKI](../platform/pki.md): the cluster CAs and the talosconfig certificates.
