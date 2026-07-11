# pki/ — Offline Root CA Ceremony

An air-gap-friendly ceremony that mints an Ed25519 root CA + signed
intermediate, designed to feed HashiCorp Vault's PKI mount so Vault becomes
the active issuer of leaf certs for the homelab (k8s cert-manager, NixOS host
identity, etc.). The root can be anchored either to a YubiKey (default) or to
an age-encrypted file on disk — see [Storage mode](#storage-mode-yubikey-vs-disk).

## Hybrid architecture (offline root → Vault intermediate → Terraform plumbs)

This is deliberately split across the trust boundary:

1. **Offline (this script, air-gapped host):**
   - mints the Ed25519 **root** keypair
   - shards the root seed via SLIP-0039 (2-of-3) for offline recovery
   - anchors the root private key — onto a YubiKey PIV slot (hardware anchor,
     default) or as an age-encrypted file on disk (`STORAGE_MODE=disk`)
   - issues the **intermediate** signed by the root
   - scrubs the plaintext root key from disk; the root private key lives
     **only** on the YubiKey + in the shards (or, in disk mode, only in the
     age-encrypted `root.key.age` + shards file)

   The intermediate leaves with you in `pki/export/intermediate.pem`
   (key+cert concatenated). Its private key is *the* trust you carry into
   Vault — protect it in transit.

2. **Terraform (`terraform/vault/pki-fml.tf`):**
   - declares the `pki` mount + issuance roles + URL config (unchanged)
   - **imports the offline intermediate** as the active CA on the mount via
     `vault_pki_secret_backend_config_ca`, gated on the optional
     `pki_intermediate_pem_bundle` variable:
     ```bash
     TF_VAR_pki_intermediate_pem_bundle="$(cat pki/export/intermediate.pem)" \
       terraform -chdir=terraform/vault plan
     TF_VAR_pki_intermediate_pem_bundle="$(cat pki/export/intermediate.pem)" \
       terraform -chdir=terraform/vault apply
     ```
     Without the var, `vault_pki_secret_backend_config_ca.offline_intermediate`
     is `count = 0` — Atlantis applies / CI `validate` keep working pre-ceremony.
   - the intermediate private key now lives in Vault storage **and** Terraform
     state (acceptable tradeoff — root stays hardware-only)

3. **Vault (active issuer, populated by Terraform):**
   - signs leaf-cert CSRs from cert-manager (k8s) and NixOS host-fetch flows
   - the existing `fml` and `lolwtf` roles already define the allowed DNS zones
   - rotation = re-run the offline ceremony + replay step 2 with a fresh bundle

4. **Distribution (next PRs):**
   - `root.crt` (public) commits to the repo as the system trust anchor for
     NixOS hosts and k8s — a small NixOS module can drop it into
     `/etc/ssl/certs/` and run `update-ca-certificates`
   - cert-manager on folly/offsite gets an `Issuer` pointing at the Vault PKI
     mount (via AppRole creds already wired in `terraform/vault/`)
   - NixOS host-identity certs can `curl` Vault's `/v1/pki/issue/<role>` at
     boot using the ddnsd-style AppRole flow already present

## Why a script + Terraform, not one or the other?

- **Terraform alone can't** drive the offline ceremony: USB passthrough to a
  YubiKey (or age encryption to disk), human transcription of SLIP-0039
  shards, and Sigstore provenance verification of `step` are all out-of-band
  operations no provider supports.
- **The offline script alone can't** own the *plumbing* — Vault mount + roles +
  URL config + AppRole issuance policies are exactly what Terraform is for.
  The script handshake-rolls the certs; Terraform owns everything that's
  safe to retry in CI/Atlantis.
- **State boundary**: root private key never enters Terraform state (offline
  only). Only the intermediate private key does — that's the Hybrid compromise
  you opt into when you set `pki_intermediate_pem_bundle`.

## Layout

```
pki/
  offline-root-ceremony.sh   # host driver — builds container, runs ceremony
  README.md                  # this file
  export/                    # generated at runtime (gitignored)
    inner_ceremony.sh         # written by the host driver, exec'd in container
    root.crt                  # public root cert (kept)
    intermediate.crt          # signed intermediate (→ Vault)
    intermediate.key          # intermediate private key (→ Vault, secret)
    root.key.age              # disk mode only — age-encrypted root key
    root_seed_shards.txt.age  # disk mode only — age-encrypted SLIP-0039 shards
```

## What the ceremony does

1. Builds a one-shot Ubuntu container with `step`, `cosign`, `ykman`,
   `shamir-mnemonic[cli]`, `cryptography`, `secure-delete`, and `age`.
2. Downloads Smallstep CLI from `dl.smallstep.com` and verifies its
   Sigstore bundle with cosign.
3. Generates an Ed25519 root CA (`step certificate create --profile root-ca`).
4. Extracts the 32-byte root seed from the PKCS8 PEM and shards it via
   SLIP-0039 **using `--master-secret=HEX`** — otherwise `shamir create`
   generates its own random secret and the shards would not recover the root.
   In `STORAGE_MODE=yubikey` (default) the human transcribes the shards
   before continuing; in `STORAGE_MODE=disk` they're encrypted straight to
   `root_seed_shards.txt.age`.
5. Anchors the root private key + cert: imports into PIV slot `9c` on a
   YubiKey (`yubikey` mode), or encrypts `root.key` to `root.key.age` with
   `age` (`disk` mode).
6. Issues an Ed25519 intermediate CA signed by the root.
7. Scrubs plaintext `root.key` and the raw seed from disk. The root private
   key now exists **only** on the YubiKey + in the shards (or, in disk mode,
   only in `root.key.age` + `root_seed_shards.txt.age`).

## Storage mode: YubiKey vs. disk

`STORAGE_MODE` picks how the root private key and SLIP-0039 shards are
anchored after generation. Default is `yubikey`.

| | `yubikey` (default) | `disk` |
|---|---|---|
| Root key | Imported to YubiKey PIV slot `9c` | Encrypted to `root.key.age` with `age` |
| Shards | Printed for hand transcription, distributed to trusted parties | Encrypted to `root_seed_shards.txt.age`, kept together |
| Hardware needed | YubiKey 5.7+, USB passthrough | None |
| Recovery needs | 2-of-3 shards, or the YubiKey | The age identity file |

Disk mode trades the hardware anchor and human-distributed shards for a
single age identity file under your own custody — simpler to run, but a
single point of compromise if that identity file and `export/` end up in the
same place. Prefer `yubikey` for the real production root; `disk` is useful
for lab/test roots or when a YubiKey isn't available.

To use it, generate an age keypair **ahead of time**, on the air-gapped host,
and keep `identity.txt` offline (a password manager, an encrypted USB stick —
anywhere other than `pki/export/`, which this script treats as disposable):

```bash
age-keygen -o identity.txt
# Public key: age1...   <- this is DISK_ENCRYPTION_RECIPIENT
```

```bash
STORAGE_MODE=disk \
DISK_ENCRYPTION_RECIPIENT="age1..." \
./pki/offline-root-ceremony.sh
```

## Requirements

- Air-gapped host with Docker.
- `STORAGE_MODE=yubikey` (default) additionally needs:
  - A USB-attached **YubiKey 5.7 or later** for PIV Ed25519 support. Verify
    with `ykman info` (look for "Form factor" + firmware ≥ 5.7).
  - `sudo` to start/stop host `pcscd` (so the container can grab the card
    reader). No host smart card daemon running (`pcscd` is stopped on the
    host, started inside the container).
- `STORAGE_MODE=disk` additionally needs an age recipient key generated ahead
  of time (see [Storage mode](#storage-mode-yubikey-vs-disk)) — no YubiKey,
  USB passthrough, or `sudo` required.

## Running

```bash
# from the repo root — defaults baked in (STORAGE_MODE=yubikey); override env vars to taste
./pki/offline-root-ceremony.sh

# overrides
STEP_VERSION=0.30.6 \
ROOT_CA_NAME="My Homelab Root CA" \
SHAMIR_THRESHOLD=2 SHAMIR_SHARES=3 \
./pki/offline-root-ceremony.sh

# disk storage mode instead of a YubiKey
STORAGE_MODE=disk DISK_ENCRYPTION_RECIPIENT="age1..." \
./pki/offline-root-ceremony.sh
```

In `yubikey` mode you will be prompted to transcribe the SLIP-0039 shards
before the YubiKey import step. Do not press Enter until every shard is
recorded somewhere offline. In `disk` mode the shards are encrypted
automatically — nothing to transcribe.

## After the ceremony

1. **Hand the intermediate to Vault via Terraform** (the hybrid hook in
   `terraform/vault/pki-fml.tf`). Pass the bundle as a sensitive TF_VAR so
   the intermediate key never lands in git:
   ```bash
   TF_VAR_pki_intermediate_pem_bundle="$(cat pki/export/intermediate.pem)" \
     terraform -chdir=terraform/vault plan   # sanity check
   TF_VAR_pki_intermediate_pem_bundle="$(cat pki/export/intermediate.pem)" \
     terraform -chdir=terraform/vault apply  # orvia the Atlantis PR flow
   ```
   This calls `vault_pki_secret_backend_config_ca.offline_intermediate`, which
   writes the bundle to `pki/config/ca` — making the offline-generated CA the
   active signer on the mount. Existing roles (`fml`, `lolwtf`) then issue leaf
   certs signed by your hardware-rooted chain.

2. **Verify chain trust end-to-end:**
   ```bash
   curl -s http://127.0.0.1:8200/v1/pki/ca_chain | step certificate inspect
   ```

3. **Distribute `export/root.crt` as the trust anchor** — it's public; commit
   it where relying parties will pick it up (k8s ConfigMap, a NixOS module
   writing to `/etc/ssl/certs/`, etc.).

4. **Shards**: in `yubikey` mode, store each of the three shards with a
   different trusted party. Any two re-derive the root seed (`shamir
   recover`), which can be re-imported to a replacement YubiKey if the
   original is lost. One shard alone leaks nothing about the root. In `disk`
   mode the shards live together, encrypted, in `export/root_seed_shards.txt.age`
   — back that file (and `root.key.age`) up somewhere durable, e.g. alongside
   the age identity in a password manager.

5. **Scrub the bundle from the laptop** once Vault owns the CA:
   ```bash
   srm -f pki/export/intermediate.pem pki/export/intermediate.key 2>/dev/null \
     || shred -u pki/export/intermediate.pem pki/export/intermediate.key
   ```
   (Keep `intermediate.crt` + `root.crt` for chain bundling.)

## Recovery

### From shards, re-key a YubiKey (`yubikey` mode)

```bash
shamir recover        # enter 2 of the 3 shards → master secret hex
# the hex IS the 32-byte Ed25519 seed; wrap as PKCS8:
python3 -c '
import binascii, sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
seed = binascii.unhexlify(sys.argv[1])
priv = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
print(priv.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption()
).decode())
' <recovered-hex> > root.key
ykman piv keys import 9c root.key
ykman piv certificates import 9c root.crt
```

### From the age-encrypted files (`disk` mode)

The root key doesn't need reconstructing from shards in this mode — it's
already on disk, just encrypted:

```bash
age -d -i identity.txt -o root.key pki/export/root.key.age
age -d -i identity.txt -o root_seed_shards.txt pki/export/root_seed_shards.txt.age
```

`root.key` is ready to use directly (e.g. as `--ca-key` for a follow-up
intermediate ceremony). The decrypted shards are a redundant recovery path if
`root.key.age` itself is ever lost or corrupted while the age identity
survives — feed 2 of the 3 into `shamir recover` as above. Note both files
are encrypted to the *same* age identity, so losing the identity itself takes
out both paths at once; back it up as carefully as you would a root key.
Shred the plaintext `root.key` / `root_seed_shards.txt` again once you're
done with them.

## Operational notes

- The script deliberately **does not** rotate the PIV management key. The
  default management key is well-known; if you want hardware-only signing
  semantics for the root, set a custom mgmt key (`ykman piv access
  change-management-key --generate`) on an air-gapped host *after* the
  ceremony and capture it securely — it's the recovery path for re-keying
  the slot.
- `--touch=always` for the PIV slot is out of scope for `piv keys import`;
  configure touch policy via `ykman piv keys set-touch` (YubiKey 5.7+).
- Intermediate expiry is 2 years; root expiry is ~15 years. Re-issuance of
  an intermediate can be done in a follow-up ceremony using the root on the
  YubiKey (or `root.key.age` in disk mode).
- `STORAGE_MODE=disk` is a deliberately weaker trust model than `yubikey`:
  the root key and shards both collapse to "whoever holds the age identity
  file," rather than requiring physical possession of a hardware token or
  collusion between separate shard holders. Fine for a lab/test root; think
  twice before using it for the root that Vault's production PKI mount
  ultimately chains to.