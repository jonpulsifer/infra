---
title: Get cluster admin access
description: Get kubectl access to folly and offsite with the admin certificate from talosctl, and withdraw access.
---

Use this runbook to get `kubectl` access to the `folly` and `offsite` clusters, or to withdraw it. `talosctl kubeconfig` writes a kubeconfig whose one user is the cluster's admin client certificate, which is in `system:masters`. It comes from the admin talosconfig that [Issue a talosconfig](issue-a-talosconfig.md) stores in 1Password.

## Before you start

- You need `kubectl`, `talosctl`, `op` and the item `talos-<site>-admin`.

`<site>` is `folly` or `offsite`.

## Get a kubeconfig

1. Add the cluster's admin context to `~/.talos/config`.

   ```bash
   talosctl config remove <site> --noconfirm   # an old context; merge renames a duplicate
   op document get talos-<site>-admin --vault homelab --out-file /dev/shm/talos-<site>
   talosctl config merge /dev/shm/talos-<site> && rm /dev/shm/talos-<site>
   ```

2. Write the kubeconfig for the cluster.

   ```bash
   talosctl --context <site> kubeconfig --merge=false ~/.kube/<site>.yaml
   ```

   Result: The file `~/.kube/<site>.yaml` exists.

3. Make sure that the certificate works.

   ```bash
   export KUBECONFIG=~/.kube/<site>.yaml
   kubectl get nodes
   ```

   Result: Each node shows `Ready`.

Run the command again to renew an expired certificate. If it fails, check the control plane.

```bash
talosctl --context <site> health
```

## Withdraw access

Use this procedure if you lose a workstation or a talosconfig.

> [!WARNING]
> A lost workstation holds the admin certificates and the talosconfig. Nothing can revoke them. Only a CA rotation withdraws them, as [PKI](../platform/pki.md) describes.

1. Run `talosctl rotate-ca` on each cluster, as [PKI](../platform/pki.md) describes.
2. Issue a new talosconfig, as [Issue a talosconfig](issue-a-talosconfig.md) describes.

> [!NOTE]
> `nix/system/user.nix` gives the `jawn` user the keys of `https://github.com/jonpulsifer.keys` (the `keys` flake input). It gives the `rowbutt` user, the host user for [Rowbutt](../apps/mate.md), the keys of `https://github.com/rowbutt.keys` (`rowbuttkeys`). Both users are in `wheel`, and `nix/profiles/fleet.nix` gives `wheel` passwordless sudo. The Talos nodes run no SSH server; these keys reach the NixOS hosts only.

3. Remove the lost SSH key from the GitHub account that holds it.
4. Update the `keys` and `rowbuttkeys` flake inputs.

   ```bash
   nix flake update keys rowbuttkeys
   ```

   Result: `• Updated input` for each input whose keys changed.

5. Merge the change through a pull request.

> [!NOTE]
> The NixOS hosts remove the key at their next auto-upgrade from `main`. A host that sets `system.autoUpgrade.enable = false` keeps the key until you deploy it.

6. Deploy each host that sets `system.autoUpgrade.enable = false`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `talosctl kubeconfig` fails. | The Talos API failed, or `~/.talos/config` has no context `<site>`. | Run `talosctl --context <site> version`, or do step 1 of [Get a kubeconfig](#get-a-kubeconfig). |
| kubectl prints `You must be logged in to the server`. | The admin certificate expired. | Run step 2 of [Get a kubeconfig](#get-a-kubeconfig) again. |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [Issue a talosconfig](issue-a-talosconfig.md)
- [PKI](../platform/pki.md): the cluster CAs and the talosconfig certificates.
