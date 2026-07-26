---
name: sops-secrets
description: Work with sops-nix and the age keys this repo uses to encrypt per-host secrets. Use when adding a new SOPS-managed host, generating or rotating a harmonia binary-cache key, decrypting a sops file, re-encrypting with a new recipient, or chasing "sops: command not found / no matching key / decryption failed" errors. The dev-machine operator key is in 1Password (homelab vault) and at ~/.config/age/keys.txt — NOT at the sops binary's default of ~/.config/sops/age/keys.txt.
metadata:
  runbook: docs/pages/Runbooks___SOPS Secrets and Age Keys.md
---

# sops-secrets

SOPS-encrypted per-host secrets in this repo (`nix/secrets/<host>.sops.yaml`),
plus the harmonia binary-cache keypair pair (`<host>.sops.yaml` private +
`<host>-harmonia-cache.pub` public). The sops operator keypair is in
1Password and at `~/.config/age/keys.txt`; the per-host keypair is **derived
from each host's ed25519 SSH host key** (`ssh-to-age` on
`/etc/ssh/ssh_host_ed25519_key.pub`), so a compromised host only exposes
secrets scoped to itself.

Canonical public runbook: `docs/pages/Runbooks___SOPS Secrets and Age Keys.md`.
Layer background: `docs/pages/Architecture___Secrets and PKI.md`.

## Where the keys live (the part that's easy to mis-spend an hour on)

| Key | Where | Notes |
| --- | ----- | ----- |
| Operator age **private** (encrypts/decrypts in the dev shell) | `~/.config/age/keys.txt` (mode 600) | Public half: `age1lpfxcn6qwrgtxzymzcxqu20cppsrhmgcpma59sc8ahq9t0w67d3sj8e3e6`. The `age` binary's own config dir, NOT the sops binary's default of `~/.config/sops/age/keys.txt`. |
| Operator age **public** | Listed in every `.sops.yaml` under `sops.age[*].enc` recipients | Encoded inside the encrypted file. |
| Operator age (1Password) | 1Password homelab vault, item **"sops homelab age key"** | The plaintext `AGE-SECRET-KEY-1A...` lives here. If `~/.config/age/keys.txt` is missing, copy from this item. |
| Per-host age **public** (decryption recipient on the host itself) | `nix/secrets/<host>.sops.yaml` `sops.age[*]` list | Derived from the host's ed25519 host key via `ssh-to-age`. NOT present until the host has booted once. |
| Per-host ed25519 SSH host key | `/etc/ssh/ssh_host_ed25519_key.pub` on the host itself | First-boot-generated; never in the repo. |
| Harmonia binary-cache **private** | `<host>.sops.yaml` under `harmonia-cache-key` | Decrypted to `/run/secrets/harmonia-cache-key` on the host by sops-nix. |
| Harmonia binary-cache **public** | `nix/secrets/<host>-harmonia-cache.pub` (committed in the clear) | What clients pin in `nix.settings.trusted-public-keys`. |

If `sops -d <file>` complains "no matching creation rules" or
"failed to load age identities", one of those rows is the thing that's
broken. Don't go searching the filesystem for the key — start with
`op item get "sops homelab age key" --vault homelab` and put it at
`~/.config/age/keys.txt`.

## Quick decrypt / encrypt

```bash
# Decrypt
SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops -d nix/secrets/<host>.sops.yaml

# Edit (decrypts to a temp file, re-encrypts on save)
SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops nix/secrets/<host>.sops.yaml

# Re-encrypt in place after manual edits
SOPS_AGE_KEY_FILE=~/.config/age/keys.txt sops -e -i nix/secrets/<host>.sops.yaml
```

If `sops` isn't on `PATH`, run it through the nix dev shell:
`nix develop -c sops -d nix/secrets/<host>.sops.yaml`. The
`op` CLI is a normal binary; the age key is plain text so no
`op` round-trip is needed for routine decrypt.

## Adding a new SOPS-managed host

The chicken-and-egg is that the host's ed25519 doesn't exist until it
boots for the first time, but sops-nix can't decrypt the secret on that
first boot without the host's age recipient in the file. The flow is
**two-stage**: the operator key is the only recipient at first, the host
key gets added on second-deploy.

1. Add a `creation_rule` to `.sops.yaml`:
   ```yaml
   - path_regex: nix/secrets/<host>\.sops\.ya?ml
     key_groups:
       - age:
           - age1lpfxcn6qwrgtxzymzcxqu20cppsrhmgcpma59sc8ahq9t0w67d3sj8e3e6  # operator
   ```
   Comment explains the second-stage add. Don't list the host's pubkey
   here — it doesn't exist yet.
2. Generate the secret material (e.g. harmonia keypair):
   ```bash
   nix-store --generate-binary-cache-key <host>.lolwtf.ca-1 \
     /tmp/<host>-cache.priv /tmp/<host>-cache.pub
   ```
3. Write the plaintext:
   ```yaml
   # nix/secrets/<host>.sops.yaml (plaintext; sops will encrypt in place)
   harmonia-cache-key: |
     <host>.lolwtf.ca-1:<priv base64>
   ```
4. Encrypt against the rule (the path matching is what binds the rule):
   ```bash
   sops -e -i nix/secrets/<host>.sops.yaml
   ```
5. Commit the encrypted file + the `.pub` (in the clear, on a global
   gitignore override: `git add -f nix/secrets/<host>-harmonia-cache.pub`).
6. Boot the host with a configuration that does not declare load-bearing
   secrets from the operator-only file. The boot generates its ed25519 host key.
7. **After the host's first successful boot**, grab its ed25519, derive
   the age pubkey, and add it as a second recipient:
   ```bash
   ssh <host>.lolwtf.ca cat /etc/ssh/ssh_host_ed25519_key.pub | ssh-to-age
   # returns an age1... string

   sops -r --add-age age1... nix/secrets/<host>.sops.yaml
   ```
   Wire the host's flake entry: `imports = [ ./nix/system/sops.nix ];
   sops.defaultSopsFile = ./nix/secrets/<host>.sops.yaml;
   sops.secrets."harmonia-cache-key" = { };`. Commit the re-encrypted file
   and configuration together. From here, sops-nix on the host can decrypt
   without the operator key on the host filesystem.

An operator-only file is buildable but not decryptable by the host. The
operator key stays in the recipient list; the host key is additive. A full
wipe that replaces `/etc/ssh/ssh_host_ed25519_key` requires repeating stage 2
with the new recipient before the host can decrypt the existing file.

## Decryption failure triage

`sops` errors are usually one of these — fix in order:

1. **"failed to load age identities"** — no `keys.txt` at
   `~/.config/sops/age/keys.txt` (sops binary default) or
   `SOPS_AGE_KEY_FILE` set. Either symlink the real key:
   `ln -sf ~/.config/age/keys.txt ~/.config/sops/age/keys.txt`
   (creates the parent dir), or set the env var.
2. **"no matching creation rules found"** — the file's path doesn't
   match any `path_regex` in `.sops.yaml`, OR the file was created
   against a different rule's recipient list (the encryption time
   matters more than the current `.sops.yaml`). Recreate the file
   against the current rule.
3. **"Failed to get the data key required to decrypt"** — your key
   isn't a recipient of this file. Confirm with
   `rg '^ +recipient:' <file>` (reads unencrypted recipient metadata)
   and check yours is there.
4. **`sops-nix` activation error on a host** — host's ed25519-derived
   age pubkey isn't in the file. Run the two-stage flow above to add
   it; the operator-only configuration cannot activate load-bearing secrets.

## When to put a new secret in 1Password

If a secret is a long-lived operational thing (the operator age key, a
harmonia cache private, a cloud account key, or a durable Tailscale OAuth
enrollment credential), commit a 1Password item for it as part of the same
PR. Per-host session tokens, short-lived OAuth codes, and expiring Tailscale
auth keys live only in the relevant `*.sops.yaml`. Naming convention:
`<thing> (<host>, if scoped)` — e.g. "sops homelab age key",
"forge harmonia cache key", "unifi-terraform (offsite)".
