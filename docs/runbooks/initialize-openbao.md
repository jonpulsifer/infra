---
title: Initialize OpenBao
description: Put the unseal key into forge's YubiKey, initialize the server, store its recovery keys and root token, and make sure a restart unseals it.
---

OpenBao on forge is the lab's online CA and secrets server, as [Secrets](../platform/secrets.md#openbao) describes. It unseals itself with an RSA key in the YubiKey in forge's USB port. Use this runbook to program a new card, and to initialize a server that starts with empty storage, for example a new anchor or a lost `/var/lib/openbao`.

`<host>` is the anchor, `forge` today, and `<target>` is `<host>.<tailnet>`. `<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`.

> [!WARNING]
> This procedure changes live state by hand. It is an exception to the GitOps rule because only a process on the anchor can program the YubiKey, and because `bao operator init` makes the recovery keys and root token, which git cannot hold.

## Before you start

- You need the operator key in `~/.config/age/keys.txt`, as [Manage SOPS secrets](manage-sops-secrets.md) describes.
- Sign in to 1Password with `op`, with write access to the `homelab` vault.
- `<host>` sets `homelab.yubikey.enable`, and runs a configuration from `main` that sets it.
- The PIV applet of the YubiKey holds no key and has the factory PIN, PUK and management key.

## Put the unseal key into the card

1. Put the YubiKey in a USB port of `<host>`.
2. Make sure that the anchor sees one YubiKey.

   ```bash
   ssh <target> sudo ykman list
   ```

   Result: one line that names the YubiKey and its serial.

3. On a branch, program the card.

   ```bash
   export SOPS_AGE_KEY_FILE=~/.config/age/keys.txt
   mise run openbao:yubikey:init <host>
   ```

   Result: `Done: slot 9d of YubiKey <serial> on <host> holds the unseal key, and ykcs11 decrypts with it.` The first run also creates the 1Password item `openbao-unseal-key`; a later run on another anchor imports the same key, so every Raft voter unseals.

4. In `nix/hosts/<host>.nix`, set `homelab.yubikey.serial` to that serial and `homelab.openbao.enable = true`.
5. Commit `nix/secrets/<host>.sops.yaml` and `nix/hosts/<host>.nix`, open a pull request, and merge it.
6. Deploy `<host>`, as [Deploy a NixOS host](deploy-a-nixos-host.md) describes.

   Result: `ssh <target> bao status` prints `Initialized false` and `Sealed true` for a new server. `Seal Type` is `pkcs11`.

## Initialize the server

1. Make sure that the server is not initialized.

   ```bash
   ssh <target> bao status
   ```

   Result: The `Initialized` row shows `false`.

> [!NOTE]
> An initialized server has data. This procedure is for an empty one. If the `Initialized` row shows `true`, stop.

> [!WARNING]
> The next command shows the only copy of the recovery keys and the root token. Do not run it through an agent, or in a terminal that logs its output.

2. Initialize the server.

   ```bash
   ssh -t <target> bao operator init -recovery-shares=5 -recovery-threshold=3
   ```

   Result: The command prints `Recovery Key 1` to `Recovery Key 5` and `Initial Root Token`.

3. Put the recovery keys and the root token in the 1Password item `openbao-forge` in the `homelab` vault.
4. Clear the terminal and its scrollback.
5. Make sure that the server is unsealed. Do step 1 again.

   Result: The `Initialized` row shows `true`, and the `Sealed` row shows `false`.

## Make sure a restart unseals the server

1. Restart the unit.

   ```bash
   ssh <target> sudo systemctl restart openbao
   ```

2. Wait for the server, then read its status.

   ```bash
   ssh <target> bao status
   ```

   Result: The `Sealed` row shows `false` with nobody typing a key.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `ykman` is not found | `<host>` runs a configuration without the YubiKey module | Deploy `<host>` from `main`. |
| `ykman list` prints nothing | pcscd cannot see the card, or the CCID interface is off | Put the YubiKey in again. Run `ssh <target> sudo ykman config usb --enable CCID`. |
| `the PIV applet holds a key or certificate` | The card holds an earlier key | If nothing on the card is needed, run `ssh <target> sudo ykman piv reset`, and run init again. |
| Init fails after it stored the secrets | The card refused a step | Run `ykman piv reset` on `<host>`. Delete the 1Password item `yubikey-<host>` and the `yubikey` keys of the SOPS file. Run init again. The `openbao-unseal-key` item stays. |
| `ykcs11 did not decrypt what the public key encrypted` | ykcs11 does not see the key, or OAEP failed on the card | Run `pkcs11-tool --module /etc/yubikey/libykcs11.so --list-objects` on `<host>`. Slot 9d must list a private key with id 03 and a certificate. |
| `bao status` says `Sealed true` after a restart | The seal cannot use the card | Read `journalctl -u openbao`. Make sure that pcscd runs, that `ykman piv info` on `<host>` lists slot 9d, and that the PIN in the SOPS file is the card's. |
| `bao operator init` fails with `already initialized` | The server has data | Stop. Do not initialize the server. |
| The unit fails before it listens | The ACME certificate for `<host>.lolwtf.ca` is not there yet | Read `journalctl -u acme-<host>.lolwtf.ca`. The Cloudflare token is `acme/cloudflare-token` in the host's SOPS file. |

## Related

- [Secrets](../platform/secrets.md#openbao): the server and its seal.
- [PKI](../platform/pki.md): what it issues.
- [Manage SOPS secrets](manage-sops-secrets.md)
