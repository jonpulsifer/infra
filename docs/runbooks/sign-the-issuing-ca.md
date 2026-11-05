---
title: Sign the issuing CA
description: Give OpenBao's configuration its token, take the issuing CA's request out of forge, sign it with the FML root key, and commit the certificate.
---

The issuing CA of the lab lives inside OpenBao on [forge](../hosts/forge.md), directly under the FML root, as [PKI](../platform/pki.md) describes. Its key is born in the server and never leaves it. `openbao-config.service` (`nix/services/openbao-config.nix`) puts the mount, the roles and the policies that git declares into the server, and leaves the CA's certificate request on forge. Use this runbook to give that service its token, and to sign the request with the root key at a root ceremony.

`<target>` is `forge.<tailnet>`, where `<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`.

> [!WARNING]
> The root key signs by hand, at a ceremony, and the configuration token is made with the root token. Both are exceptions to the GitOps rule: the root key is offline, and the token is a secret git cannot hold.

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

   Result: The unit is `inactive (dead)` with `status=0/SUCCESS`, and its log ends with `ok`.

## Take the request out of forge

1. Copy the request into the tree.

   ```bash
   ssh <target> sudo cat /var/lib/openbao-config/folly-issuing-ca.csr > terraform/pki/csr/folly-issuing-ca.csr
   ```

2. Read it.

   ```bash
   openssl req -in terraform/pki/csr/folly-issuing-ca.csr -noout -subject -verify
   ```

   Result: The subject is `CN=FML folly Issuing CA, O=Folly Mountain Laboratories`, and the request verifies.

3. Commit the request on a branch. The request is public, so it goes through a pull request like any file.

## Sign the request at the ceremony

1. On the ceremony host, with the root key as a PEM file, sign the request.

   ```bash
   mise run pki:sign-ca -- -root-key <root key PEM> -csr terraform/pki/csr/folly-issuing-ca.csr -out terraform/pki/certs/folly-issuing-ca.pem
   ```

   Result: `==> signed CN=FML folly Issuing CA,O=Folly Mountain Laboratories`, with `pathLen 1` and a `notAfter` five years out. The command refuses a key that does not match `terraform/pki/certs/fml-root.pem`.

2. Check the chain.

   ```bash
   mise run pki:verify
   ```

   Result: An `==> issuing` section lists `folly-issuing-ca.pem` under `fml-root.pem`, and the last line begins with `ok`.

3. Commit `folly-issuing-ca.pem` under `terraform/pki/certs/`, open a pull request, and merge it.
4. Deploy forge.

   Result: `openbao-config.service` imports the certificate and makes it the mount's default issuer. Its log has `set <issuer id> as the default issuer`.

5. Make sure that the server serves the chain.

   ```bash
   curl -s https://forge.lolwtf.ca:8200/v1/pki/folly/ca_chain | openssl crl2pkcs7 -nocrl -certfile /dev/stdin | openssl pkcs7 -print_certs -noout
   ```

   Result: Two subjects: the issuing CA, then the FML root.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `1Password 'openbao-forge' holds no root-token` | The item is not the one `bao operator init` filled | Do [Initialize OpenBao](initialize-openbao.md) step 3 again. |
| `openbao-config.service` fails with `permission denied` | The token is expired, or its policy is behind git | Run `mise run openbao:config-token forge` again, commit, deploy. |
| `openbao-config.service` fails at `bao status` | The server is sealed or not listening | Read `journalctl -u openbao` and [Initialize OpenBao](initialize-openbao.md), "If something goes wrong". |
| The CSR file is missing on forge | The key exists but the file was lost | Run `ssh <target> sudo systemctl start openbao-config`. The service writes a new request for the same key. |
| `the root key does not match fml-root.pem` | The ceremony reconstituted a different key | Stop. The root in the tree is the one every node trusts. |
| `the server did not import` the certificate | The certificate is not for the key in the server | Sign the request the server wrote, not an older one. |

## Related

- [PKI](../platform/pki.md): the chain.
- [Secrets](../platform/secrets.md#openbao): the server.
- [Initialize OpenBao](initialize-openbao.md)
