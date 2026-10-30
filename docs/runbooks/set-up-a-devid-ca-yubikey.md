---
title: Make a YubiKey a DevID CA
description: Generate a DevID CA key on the YubiKey of an anchor, have Atlantis certify it under the FML intermediate, and write the certificate into the card.
---

Use this runbook to make the YubiKey on spore or capsule a hardware DevID CA, as [PKI](../platform/pki.md#devid-cas) describes. Do it once for each anchor: the YubiKey 5 goes in spore, and the YubiKey 4c goes in capsule.

`<host>` is `spore` or `capsule`, and `<target>` is `<host>.<tailnet>`. `<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because only a process on the anchor can program the YubiKey. The script refuses a card whose PIV applet holds a key, and resets nothing.

## Before you start

- You need the operator key in `~/.config/age/keys.txt`, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
- Sign in to 1Password with `op`, with write access to the `homelab` vault.
- You need Google credentials that read the `terraform/pki` state.
- `<host>` sets `homelab.devidCa.yubikey.enable`, and runs a configuration from `main` that sets it.
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

4. In `nix/hosts/<host>.nix`, set `homelab.devidCa.yubikey.serial` to that serial.
5. Commit the CSR, `nix/secrets/<host>.sops.yaml` and `nix/hosts/<host>.nix`, and open a pull request.

## Certify the key

> [!NOTE]
> The pull request changes no `.tf` file, so Atlantis does not plan it by itself.

1. Comment `atlantis plan -d terraform/pki` on the pull request.

   Result: a plan that adds `tls_locally_signed_cert.devid_ca_yubikey["<host>"]` and changes nothing else.

2. Comment `atlantis apply`. Atlantis applies the plan and merges the pull request.
3. Deploy `<host>`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes. sops-nix then writes the PIN for the `devid-ca` group.

## Install the certificate

1. Initialize the `terraform/pki` root with its state.

   ```bash
   tofu -chdir=terraform/pki init
   ```

2. On a new branch from `main`, install the certificate.

   ```bash
   mise run devid:yubikey:install <host>
   ```

   Result: `Verified OK`, the token label `YubiKey PIV #<serial>`, and a `pki:verify` line that starts with `ok`.

3. Commit `folly-devid-ca-<host>.pem` and the bundle `folly-devid-ca.pem` in `terraform/pki/certs/`, and open a pull request.
4. Merge the pull request after the `pki:verify` check passes.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `ykman` is not found | `<host>` runs a configuration without the YubiKey module | Deploy `<host>` from `main`. |
| `ykman list` prints nothing | pcscd cannot see the card, or the CCID interface is off | Put the YubiKey in again. Run `ssh <target> sudo ykman config usb --enable CCID`. |
| `the PIV applet holds a key or certificate` | The card holds an earlier key | If nothing on the card is needed, run `ssh <target> sudo ykman piv reset`, and run init again. |
| `firmware ... must not generate RSA2048 keys` | The firmware is in the ROCA range | Use a different YubiKey. |
| Init fails after it stored the secrets | The card refused a step | Run `ykman piv reset` on `<host>`. Delete the 1Password item `devid-ca-<host>` and the `devid-ca` keys of the SOPS file. Run init again. |
| Install says that no certificate is issued | Atlantis has not applied the CSR | Apply the pull request with Atlantis. |
| `the YubiKey on <host> is not serial ...` | The serial in `nix/hosts/<host>.nix` is wrong | Correct the serial from `ssh <target> sudo ykman list`. |
| `pki:verify` reports the bundle | `folly-devid-ca.pem` misses a CA | Run `mise run devid:bundle`, and commit the result. |

## Related

- [PKI](../platform/pki.md)
- [Manage SOPS secrets](manage-sops-secrets.md)
- [Apply an OpenTofu change](apply-an-opentofu-change.md)
