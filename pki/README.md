# pki/ — Offline Root CA Ceremony

An air-gap-friendly ceremony that mints a hardware-anchored Ed25519 root CA
+ signed intermediate, designed to feed HashiCorp Vault's PKI mount so Vault
becomes the active issuer of leaf certs for the homelab (k8s cert-manager,
NixOS host identity, etc.).

## Hybrid architecture (offline root → Vault intermediate → Terraform plumbs)

This is deliberately split across the trust boundary:

1. **Offline (this script, air-gapped host + YubiKey):**
   - mints the Ed25519 **root** keypair
   - shards the root seed via SLIP-0039 (2-of-3) for offline recovery
   - imports the root private key onto a YubiKey PIV slot — the hardware anchor
   - issues the **intermediate** signed by the root
   - scrubs the root key from disk; the root private key lives **only** on the
     YubiKey + in the shards

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
  YubiKey, human transcription of SLIP-0039 shards, and Sigstore provenance
  verification of `step` are all out-of-band operations no provider supports.
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
```

## What the ceremony does

1. Builds a one-shot Ubuntu container with `step`, `cosign`, `ykman`,
   `shamir-mnemonic[cli]`, `cryptography`, and `srm`.
2. Downloads Smallstep CLI from `dl.smallstep.com` and verifies its
   Sigstore bundle with cosign.
3. Generates an Ed25519 root CA (`step certificate create --profile root-ca`).
4. Extracts the 32-byte root seed from the PKCS8 PEM and shards it via
   SLIP-0039 **using `--master-secret=HEX`** — otherwise `shamir create`
   generates its own random secret and the shards would not recover the root.
   The human is prompted to transcribe the shards before continuing.
5. Imports the root private key and cert into PIV slot `9c` on a YubiKey.
6. Issues an Ed25519 intermediate CA signed by the root.
7. Scrubs `root.key` and the raw seed from disk. The root private key now
   exists **only** on the YubiKey + in the shards.

## Requirements

- Air-gapped host with Docker and a USB-attached YubiKey.
- **YubiKey 5.7 or later** for PIV Ed25519 support. Verify with
  `ykman info` (look for "Form factor" + firmware ≥ 5.7).
- `sudo` to start/stop host `pcscd` (so the container can grab the card reader).
- No host smart card daemon running (`pcscd` is stopped on the host, started
  inside the container).

## Running

```bash
# from the repo root — defaults baked in; override env vars to taste
./pki/offline-root-ceremony.sh

# overrides
STEP_VERSION=0.30.6 \
ROOT_CA_NAME="My Homelab Root CA" \
SHAMIR_THRESHOLD=2 SHAMIR_SHARES=3 \
./pki/offline-root-ceremony.sh
```

You will be prompted to transcribe the SLIP-0039 shards before the YubiKey
import step. Do not press Enter until every shard is recorded somewhere
offline.

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

4. **Shards**: store each of the three shards with a different trusted party.
   Any two re-derive the root seed (`shamir recover`), which can be re-imported
   to a replacement YubiKey if the original is lost. One shard alone leaks
   nothing about the root.

5. **Scrub the bundle from the laptop** once Vault owns the CA:
   ```bash
   srm -f pki/export/intermediate.pem pki/export/intermediate.key 2>/dev/null \
     || shred -u pki/export/intermediate.pem pki/export/intermediate.key
   ```
   (Keep `intermediate.crt` + `root.crt` for chain bundling.)

## Recovery (re-key a YubiKey from shards)

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
  YubiKey.