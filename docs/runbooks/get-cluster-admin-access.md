---
title: Get kubectl access
description: Get kubectl access to folly and offsite by signing in at Google or Tailscale, keep the admin certificate from talosctl for break-glass, and withdraw access.
---

Use this runbook to get `kubectl` access to the `folly` and `offsite` clusters, or to withdraw it. `mise run kube:login <site>` adds the cluster, a user that signs in at Google, or at tsidp on the tailnet, through kubelogin and the context `<site>` to `~/.kube/config`, the way `gcloud container clusters get-credentials` does for GKE. The API server maps the signed-in account to the user `google:<email>` or `tailscale:<login>`, and `clusters/base/cluster-access-rbac.yaml` says what that user may do. The admin client certificate from `talosctl kubeconfig`, which is in `system:masters`, stays for break-glass.

`<site>` is `folly` or `offsite`, and `<provider>` is `google`, the default, or `tailscale`.

## Before you start

- You need `kubectl`, `kubelogin`, `jq` and `op`, which `mise install` provides, and a browser on the same machine.
- For Google, your account is in the hosted domain that `clusters/base/config/kube-login.json` names. For Tailscale, your machine is on the tailnet, signed in as you.
- A binding in `clusters/base/cluster-access-rbac.yaml` names `<provider>:<your email or login>`.
- The 1Password item that file names, `kube-login-<provider>`, holds the OAuth client's secret in `credential`, and the file holds its `client_id`. [Kubernetes](../platform/kubernetes.md#people) says where each client comes from.

## Sign in

1. Add the cluster to your kubeconfig.

   ```bash
   mise run kube:login <site> --provider <provider>
   ```

   Result: `context <site> is current in ~/.kube/config`, with the user `<provider>@<site>`. With `KUBECONFIG` set to one file, the script writes that file instead.

2. Use it. The first call opens a browser at the provider.

   ```bash
   kubectl get nodes
   ```

   Result: each node shows `Ready`. kubelogin keeps the tokens under `~/.kube/cache/oidc-login` and refreshes them, so the browser opens again only when the refresh token lapses. After a change to the exec arguments, `kubectl oidc-login clean` drops the old cache and the next call signs in once.

## Break-glass: the admin certificate

Use the admin certificate when an identity provider, the API server's authenticator or RBAC is what you are fixing. You need `talosctl` and the item `talos-<site>-admin`.

1. Add the cluster's admin context to `~/.talos/config`.

   ```bash
   talosctl config remove <site> --noconfirm   # an old context; merge renames a duplicate
   op document get talos-<site>-admin --vault homelab --out-file /dev/shm/talos-<site>
   talosctl config merge /dev/shm/talos-<site> && rm /dev/shm/talos-<site>
   ```

2. Write the kubeconfig for the cluster.

   ```bash
   talosctl --context <site> kubeconfig --merge=false ~/.kube/<site>-admin.yaml
   ```

   Result: The file `~/.kube/<site>-admin.yaml` exists, and `kubectl get nodes` with it lists each node. Run the command again to renew an expired certificate. If it fails, check the control plane with `talosctl --context <site> health`.

## Withdraw access

A signed-in person loses access when their binding leaves `clusters/base/cluster-access-rbac.yaml`, through a pull request. Suspending their Google account stops their next refresh, and their cached tokens expire within the hour. Removing someone from the tailnet does not stop a tsidp refresh, which works over Funnel, until tsidp restarts: `sudo systemctl restart tsidp` on spore drops every refresh token.

A lost workstation also holds the admin certificates and the talosconfig, which nothing can revoke. Only a CA rotation withdraws them, as [PKI](../platform/pki.md) describes.

> [!CAUTION]
> On folly, a Kubernetes CA rotation strands each worker [fleetd](../apps/fleetd.md) installed: Talos deletes a kubelet certificate that no accepted CA signed, and the kubelet then bootstraps with the token the Talos root gives it, which no Secret holds. A lost talosconfig alone needs only the Talos CA rotated. After a Kubernetes CA rotation, replace `clusters/<site>/config/kubernetes-ca.crt` from the new admin kubeconfig, so that `kube:login` trusts the new CA.

1. Run `talosctl rotate-ca` on each cluster, as [PKI](../platform/pki.md) describes.
2. Issue a new talosconfig, as [Issue a talosconfig](issue-a-talosconfig.md) describes.

> [!NOTE]
> `nix/system/user.nix` gives the `jawn` user the keys of `https://github.com/jonpulsifer.keys` (the `keys` flake input). It gives the `rowbutt` user, the host user for [Rowbutt](../apps/mate.md), the keys of `https://github.com/rowbutt.keys` (`rowbuttkeys`). Both users are in `wheel`, and `nix/profiles/` gives `wheel` sudo without a password.

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
| `kube:login` says the file names no `<provider>` `client_id` | The OAuth client is not declared yet | Put its ID in `clusters/base/config/kube-login.json` and its secret in the 1Password item, as [Kubernetes](../platform/kubernetes.md#people) says |
| The browser shows `redirect_uri_mismatch` | Google: the OAuth client is not a Desktop client. Tailscale: the tsidp client lacks the redirect URI | Google: create a Desktop client. Tailscale: add `http://localhost:8000` and `http://localhost:18000` to the client in tsidp's admin UI |
| tsidp answers `not allowed over funnel` or does not resolve | Your machine is off the tailnet | Connect to the tailnet and sign in again |
| kubectl prints `Unauthorized` after a sign-in | The API server does not trust the issuer or the account: the client ID in the file is not the one the token names, the account is outside the hosted domain, the API server cannot fetch tsidp's keys over Funnel, or the Talos root has not applied the file | Read the API server's log with `talosctl --context <site> logs kube-apiserver`, then plan and apply `clusters/<site>/talos` |
| kubectl prints `forbidden` | No binding names `<provider>:<email or login>` | Add it to `clusters/base/cluster-access-rbac.yaml` |
| kubectl prints `You must be logged in to the server` with the admin kubeconfig | The admin certificate expired | Run step 2 of [Break-glass](#break-glass-the-admin-certificate) again |
| The browser opens on most calls, and a call made a second later works | The exec arguments carry more than one `--oidc-auth-request-extra-params`: kubelogin hashes its cache key from a map, so the key differs between calls | Run `mise run kube:login <site>` again; the script passes one |
| `x509: certificate signed by unknown authority` | `clusters/<site>/config/kubernetes-ca.crt` is not the cluster's CA, after a CA rotation | Replace it from the new admin kubeconfig |

## Related

- [Kubernetes](../platform/kubernetes.md)
- [Issue a talosconfig](issue-a-talosconfig.md)
- [PKI](../platform/pki.md): the cluster CAs and the talosconfig certificates.
