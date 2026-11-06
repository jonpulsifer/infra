---
title: Restore OpenBao
description: Bring OpenBao, and with it the whole FML PKI, back onto a new forge from a Raft snapshot and the escrowed unseal key.
---

OpenBao on [forge](../hosts/forge.md) holds the FML root, the issuing CA and every secret the server keeps, as [Secrets](../platform/secrets.md#openbao) describes. `openbao-snapshot.service` writes a Raft snapshot into the Garage bucket `openbao` each night, and `backup-push` copies it to GCS, as [Backups](../platform/backups.md) says. A snapshot opens only with the seal key that wrapped it: the RSA key in the 1Password item `openbao-unseal-key`. Use this runbook when forge, its disk or its YubiKey is gone.

`<target>` is `forge.<tailnet>`, where `<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`.

> [!WARNING]
> `snapshot restore -force` replaces everything in the server, including its recovery keys and root token, with the snapshot's. The 1Password item `openbao-forge` from the first initialization is the one that opens the restored server.

## Before you start

- A forge that runs its configuration from `main`, with a YubiKey in its USB port, as [Deploy a NixOS host](deploy-a-nixos-host.md) and [Initialize OpenBao](initialize-openbao.md) describe.
- Sign in to 1Password with `op`, with read access to `openbao-unseal-key`, `openbao-forge` and `garage-folly` in the `homelab` vault.
- The operator key in `~/.config/age/keys.txt`, as [Manage SOPS secrets](manage-sops-secrets.md) describes.

## Put the seal key into the card

1. If the YubiKey is new, do [Initialize OpenBao](initialize-openbao.md), "Put the unseal key into the card". The script imports the escrowed key, so the new card unseals what the old one did.
2. If the host is new, give the server its configuration token and SPIRE, cert-manager and the snapshot their secrets again, as [Configure OpenBao's PKI](configure-openbao-pki.md) describes. The tokens in the snapshot belong to the old server, and the AppRole secret IDs do too.

## Restore the snapshot

1. Take the newest snapshot out of Garage, or out of GCS when Garage is gone too.

   ```bash
   { op read "op://homelab/garage-folly/openbao-access-key-id"; op read "op://homelab/garage-folly/openbao-secret-access-key"; } |
     ssh <target> 'read -r id; read -r secret; RCLONE_CONFIG_GARAGE_TYPE=s3 RCLONE_CONFIG_GARAGE_PROVIDER=Other RCLONE_CONFIG_GARAGE_REGION=garage RCLONE_CONFIG_GARAGE_ENDPOINT=http://s3.lolwtf.ca:3900 RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID=$id RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY=$secret rclone copy "garage:openbao/$(RCLONE_CONFIG_GARAGE_TYPE=s3 RCLONE_CONFIG_GARAGE_PROVIDER=Other RCLONE_CONFIG_GARAGE_REGION=garage RCLONE_CONFIG_GARAGE_ENDPOINT=http://s3.lolwtf.ca:3900 RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID=$id RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY=$secret rclone lsf garage:openbao | sort | tail -n 1)" /var/tmp/openbao-restore/'
   ```

   Result: one `.snap` file in `/var/tmp/openbao-restore/` on forge.

2. Initialize the empty server, as [Initialize OpenBao](initialize-openbao.md), "Initialize the server" says. Keep its output only until the restore ends: the snapshot brings the old recovery keys back.
3. Restore, with the root token that the initialization printed.

   ```bash
   ssh <target>
   export BAO_ADDR=https://forge.lolwtf.ca:8200
   bao login
   bao operator raft snapshot restore -force /var/tmp/openbao-restore/*.snap
   rm -r /var/tmp/openbao-restore
   ```

   Result: `bao status` says `Initialized true` and `Sealed false`, and the server now answers to the root token and recovery keys in `openbao-forge`.

4. Make sure that the PKI is back.

   ```bash
   curl -s https://forge.lolwtf.ca:8200/v1/pki/folly/ca_chain | openssl crl2pkcs7 -nocrl -certfile /dev/stdin | openssl pkcs7 -print_certs -noout
   ```

   Result: `CN=FML folly Issuing CA`, then `CN=FML Root CA`.

5. Run the configuration, which renews its token and reapplies what git declares.

   ```bash
   ssh <target> sudo systemctl start openbao-config
   ```

   Result: the unit's log ends with `ok`. If it fails with `permission denied`, make the token again as [Configure OpenBao's PKI](configure-openbao-pki.md) says.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `restore` fails with `could not decrypt` or the server seals after it | The card holds a different seal key than the one that wrapped the snapshot | Import the key from `openbao-unseal-key` again. A snapshot made under another seal key cannot be read. |
| `bao login` refuses the root token after the restore | The restore replaced it with the snapshot's | Use the root token in `openbao-forge`, or generate one with three recovery keys from that item. |
| SPIRE on spore or cert-manager on folly logs `permission denied` from forge | Their AppRole secret IDs or the kubernetes auth config belong to the old server | Make the secret IDs again, and run `openbao-config` once. |

## Related

- [Initialize OpenBao](initialize-openbao.md)
- [Configure OpenBao's PKI](configure-openbao-pki.md)
- [Backups](../platform/backups.md)
