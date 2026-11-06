---
title: Configure OpenBao's PKI
description: Give OpenBao's configuration its token, deploy it, and make sure the server serves the FML chain.
---

The root and the issuing CA of the lab live inside OpenBao on [forge](../hosts/forge.md), as [PKI](../platform/pki.md) describes. Their keys are born in the server and never leave it. `openbao-config.service` (`nix/services/openbao-config.nix`) puts the mounts, the CAs, the roles and the policies that git declares into the server. Use this runbook to give that service its token and to check its work.

`<target>` is `forge.<tailnet>`, where `<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`.

> [!WARNING]
> The configuration token is made with the root token, by hand. It is an exception to the GitOps rule: a secret git cannot hold.

## Before you start

- You need the operator key in `~/.config/age/keys.txt`, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
- Sign in to 1Password with `op`, with read access to the item `openbao-forge` in the `homelab` vault.
- forge runs an initialized OpenBao, as [Initialize OpenBao](initialize-openbao.md) describes.

## Give the configuration its token

1. On a branch, make the token.

   ```bash
   export SOPS_AGE_KEY_FILE=~/.config/age/keys.txt
   mise run openbao:config-token forge
   ```

   Result: `Done: nix/secrets/forge.sops.yaml holds the token of openbao-config.service on forge.` The token is periodic; the service renews it each day, so a forge that is off for longer than its period needs this step again.

2. In `nix/hosts/forge.nix`, make sure that `homelab.openbao.pki.enable = true`.
3. Commit `nix/secrets/forge.sops.yaml` and `nix/hosts/forge.nix`, open a pull request, and merge it.
4. Deploy forge, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.
5. Make sure that the service ran.

   ```bash
   ssh <target> systemctl status openbao-config
   ```

   Result: The unit is `inactive (dead)` with `status=0/SUCCESS`, and its log ends with `ok`. The first run logs `generated` under `root CA` and `signed` under `issuing CA certificate`.

## Check the chain

1. Read the chain the issuing CA serves.

   ```bash
   curl -s https://forge.lolwtf.ca:8200/v1/pki/folly/ca_chain | openssl crl2pkcs7 -nocrl -certfile /dev/stdin | openssl pkcs7 -print_certs -noout
   ```

   Result: Two subjects: `CN=FML folly Issuing CA, O=Folly Mountain Laboratories`, then `CN=FML Root CA, O=Folly Mountain Laboratories`.

2. Read the root.

   ```bash
   curl -s https://forge.lolwtf.ca:8200/v1/pki/root/ca/pem | openssl x509 -noout -subject -dates -ext basicConstraints
   ```

   Result: The root, self-signed, with `pathlen:2` and a `notAfter` twenty years out.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `1Password 'openbao-forge' holds no root-token` | The item is not the one `bao operator init` filled | Do [Initialize OpenBao](initialize-openbao.md) step 3 again. |
| `openbao-config.service` fails with `permission denied` | The token is expired, or its policy is behind git | Run `mise run openbao:config-token forge` again, commit, deploy. |
| `openbao-config.service` fails at `bao status` | The server is sealed or not listening | Read `journalctl -u openbao` and [Initialize OpenBao](initialize-openbao.md), "If something goes wrong". |
| `the server did not import the issuing CA certificate` | The mount's key `folly` is not the one the request named | Read `bao list pki/folly/keys` on forge. The service signs a request for the key named after the mount. |
| The chain shows a root that is not the one in `pki/root` | The root was made again, and the issuing CA was signed under the former one | Run `ssh <target> sudo systemctl start openbao-config`. The service signs the issuing CA again under the root it finds. |

## Related

- [PKI](../platform/pki.md): the chain.
- [Secrets](../platform/secrets.md#openbao): the server.
- [Initialize OpenBao](initialize-openbao.md)
