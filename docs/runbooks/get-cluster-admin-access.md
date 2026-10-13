---
title: Get cluster admin access
description: Get kubectl access to folly and offsite with eight-hour tokens through talosctl, use the break-glass certificate when tokens fail, and withdraw access.
---

Use this runbook to get `kubectl` access to the `folly` and `offsite` clusters, or to withdraw it. Each kubectl context uses an eight-hour token for the `operator` ServiceAccount in `kube-system`, which has the `cluster-admin` ClusterRole. The kubeconfig also holds a break-glass client certificate for each cluster, for when tokens fail. Both come from `talosctl kubeconfig`, with the admin talosconfig that [Issue a talosconfig](issue-a-talosconfig.md) stores in 1Password.

## Before you start

- Install the dotfiles, so that `update-kubeconfigs` and `kube-jit-token` are in `~/.local/bin`.
- You need `kubectl`, `jq`, `talosctl`, `op` and the item `talos-<site>-admin`.

`<site>` is `folly` or `offsite`.

## Get a kubeconfig

1. Add the cluster's admin context to `~/.talos/config`.

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
3. If both users fail, check the control plane.

   ```bash
   talosctl --context <site> health
   ```

## Withdraw access

Use this procedure if you lose a workstation or a talosconfig.

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
> `nix/system/user.nix` gives the `jawn` user the keys of `https://github.com/jonpulsifer.keys` (the `keys` flake input). It gives the `rowbutt` user, the host user for [Rowbutt](../apps/mate.md), the keys of `https://github.com/rowbutt.keys` (`rowbuttkeys`). Both users are in `wheel`, and `nix/profiles/fleet.nix` gives `wheel` passwordless sudo. The Talos nodes run no SSH server; these keys reach the NixOS hosts only.

6. Remove the lost SSH key from the GitHub account that holds it.
7. Update the `keys` and `rowbuttkeys` flake inputs.

   ```bash
   nix flake update keys rowbuttkeys
   ```

   Result: `• Updated input` for each input whose keys changed.

8. Merge the change through a pull request.

> [!NOTE]
> The NixOS hosts remove the key at their next auto-upgrade from `main`. A host that sets `system.autoUpgrade.enable = false` keeps the key until you deploy it.

9. Deploy each host that sets `system.autoUpgrade.enable = false`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.
10. To restore access, revert the change from step 1.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `update-kubeconfigs` prints `Failed to fetch kubeconfig from <site> with talosctl`. | The Talos API failed, or `~/.talos/config` has no context `<site>`. | Run `talosctl --context <site> version`, or do step 1 of [Get a kubeconfig](#get-a-kubeconfig). |
| The script connects to a wrong address. | The checkout that the script is linked from has an old `clusters/<site>/config/cluster-topology.json`. | Pull the checkout, or set `INFRA_DIR` to an up-to-date one. |
| kubectl prints `kube-jit-token: minting as <site>-breakglass failed`. | The admin certificate expired. | Run `update-kubeconfigs`. |
| The `operator` binding comes back after you delete it. | Flux applies `clusters/base/operator-rbac.yaml`. | Remove it in git, as [Withdraw access](#withdraw-access) describes. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [Issue a talosconfig](issue-a-talosconfig.md)
- [PKI](../platform/pki.md): the cluster CAs and the talosconfig certificates.
