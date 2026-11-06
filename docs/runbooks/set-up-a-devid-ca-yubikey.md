---
title: Make a YubiKey a DevID CA
description: Generate a DevID CA key on the YubiKey of an anchor, have OpenBao's issuing CA certify it, and write the certificate into the card.
---

Use this runbook to make the YubiKey on spore or capsule a hardware DevID CA, as [PKI](../platform/pki.md#devid-cas) describes. Do it once for each anchor: the YubiKey 5 goes in spore, and the YubiKey 4c goes in capsule.

`<host>` is `spore` or `capsule`, and `<target>` is `<host>.<tailnet>`. `<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because only a process on the anchor can program the YubiKey. The script refuses a card whose PIV applet holds a key, and resets nothing.

## Before you start

- You need the operator key in `~/.config/age/keys.txt`, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
- Sign in to 1Password with `op`, with write access to the `homelab` vault, and read access to the item `openbao-forge`.
- forge runs OpenBao with its PKI, as [Configure OpenBao's PKI](configure-openbao-pki.md) describes.
- `<host>` sets `homelab.yubikey.enable`, and runs a configuration from `main` that sets it.
- The PIV applet of the YubiKey holds no key and has the factory PIN, PUK and management key.

## Generate the key

1. Put the YubiKey in a USB port of `<host>`.
2. Make sure that the anchor sees one YubiKey.

   ```bash
   ssh <target> sudo ykman list
   ```

   Result: one line that names the YubiKey and its serial.

3. On a branch, initialize the key.

   ```bash
   export SOPS_AGE_KEY_FILE=~/.config/age/keys.txt
   mise run devid:yubikey:init <host>
   ```

   Result: `Done: terraform/pki/csr/folly-devid-ca-<host>.csr holds the CSR of folly-devid-ca-<host>.` and the serial of the YubiKey.

4. In `nix/hosts/<host>.nix`, set `homelab.yubikey.serial` to that serial.
5. Commit the CSR, `nix/secrets/<host>.sops.yaml` and `nix/hosts/<host>.nix`, and open a pull request.

## Certify the key

1. Read the CSR. The issuing CA makes a CA of whatever request it is given.

   ```bash
   openssl req -in terraform/pki/csr/folly-devid-ca-<host>.csr -noout -subject -verify
   ```

   Result: `CN=folly-devid-ca-<host>, O=Folly Mountain Laboratories`, and the request verifies.

2. On the same branch, sign it.

   ```bash
   mise run devid:yubikey:sign <host>
   ```

   Result: a `pki:verify` line that starts with `ok`, then `Done: terraform/pki/certs/folly-devid-ca-<host>.pem and ... hold the CA certificate`. The certificate lasts five years, or the rest of the issuing CA's term.

3. Write the ConfigMap that `tpm-reattest` checks against.

   ```bash
   bash scripts/render-spire-devid-ca.sh
   ```

4. Commit `folly-devid-ca-<host>.pem`, `folly-devid-ca-<host>-chain.pem` and the bundle `folly-devid-ca.pem` in `terraform/pki/certs/`, and `clusters/folly/apps/spire/devid-ca.yaml`. Open the pull request, and merge it after the `pki:verify` check passes.
5. Deploy `<host>`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes. sops-nix then writes the PIN for the `yubikey` group. Deploy spore too when `<host>` is not spore, so its SPIRE server and fleetd read the new files.

## Install the certificate

1. Install the committed certificate into the card.

   ```bash
   mise run devid:yubikey:install <host>
   ```

   Result: `Verified OK`, the token label `YubiKey PIV #<serial>`, and `Done: slot 9c of YubiKey <serial> on <host> holds ...`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `ykman` is not found | `<host>` runs a configuration without the YubiKey module | Deploy `<host>` from `main`. |
| `ykman list` prints nothing | pcscd cannot see the card, or the CCID interface is off | Put the YubiKey in again. Run `ssh <target> sudo ykman config usb --enable CCID`. |
| `the PIV applet holds a key or certificate` | The card holds an earlier key | If nothing on the card is needed, run `ssh <target> sudo ykman piv reset`, and run init again. |
| `firmware ... must not generate RSA2048 keys` | The firmware is in the ROCA range | Use a different YubiKey. |
| Init fails after it stored the secrets | The card refused a step | Run `ykman piv reset` on `<host>`. Delete the 1Password item `devid-ca-<host>` and the `yubikey` keys of the SOPS file. Run init again. |
| `does not exist; run sign first` | The certificate is not in the tree | Run `mise run devid:yubikey:sign <host>` and commit it. |
| `the server returned no certificate` | forge's OpenBao refused the request | Read the output of the task; `1Password 'openbao-forge' holds no root-token` means the item is not the one `bao operator init` filled. |
| `the YubiKey on <host> is not serial ...` | The serial in `nix/hosts/<host>.nix` is wrong | Correct the serial from `ssh <target> sudo ykman list`. |
| `pki:verify` reports the bundle | `folly-devid-ca.pem` misses a CA | Run `mise run devid:bundle`, and commit the result. |

## Related

- [PKI](../platform/pki.md)
- [Manage SOPS secrets](manage-sops-secrets.md)
- [Configure OpenBao's PKI](configure-openbao-pki.md)
