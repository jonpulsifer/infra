#!/usr/bin/env bash
# Offline root CA ceremony:
#   1. Build a single-purpose container with step, cosign, ykman, shamir-mnemonic
#   2. Verify the Smallstep CLI artifact via cosign (Sigstore provenance)
#   3. Generate an Ed25519 root CA (cert + key) with step
#   4. Extract the 32-byte root seed and split it into SLIP-0039 shards (2-of-3)
#   5. Import the root key + cert onto a YubiKey PIV slot (hardware anchor)
#   6. Issue an Ed25519 intermediate CA signed by the (now hardware-backed) root
#   7. Bundle the intermediate key + cert into ./export/intermediate.pem — the
#      form vault_pki_secret_backend_config_ca.pem_bundle consumes to make the
#      offline-generated intermediate the active CA on a Vault PKI mount.
#   8. Scrub the root private key + raw seed from disk — shards + YubiKey are the
#      only recovery paths. Intermediate key/cert land in ./export/ for transit
#      into Vault (terraform/vault/pki-fml.tf via TF_VAR_pki_intermediate_pem_bundle).
#
# Run on an air-gapped host with a YubiKey 5.7+ (PIV Ed25519 support) plugged
# into a USB port. Never on a networked machine that has live cluster/Vault
# credentials. See ./README.md.

set -euo pipefail

# ==============================================================================
# CONFIGURATION
# ==============================================================================
: "${STEP_VERSION:=0.30.6}"
: "${ROOT_CA_NAME:=Folly Mountain Laboratories Root CA}"
: "${INTERMEDIATE_CA_NAME:=Folly Mountain Laboratories Intermediate CA}"
: "${KEY_TYPE:=OKP}"
: "${CURVE:=Ed25519}"
: "${ROOT_EXPIRY_HOURS:=131400h}"        # ~15 years
: "${INTERMEDIATE_EXPIRY_HOURS:=17520h}" # 2 years
: "${PIV_SLOT:=9c}"                      # 9c = PIV Digital Signature slot
: "${SHAMIR_THRESHOLD:=2}"
: "${SHAMIR_SHARES:=3}"
: "${DOCKER_IMAGE:=pki-offline-ceremony:latest}"

export STEP_VERSION ROOT_CA_NAME INTERMEDIATE_CA_NAME KEY_TYPE CURVE
export ROOT_EXPIRY_HOURS INTERMEDIATE_EXPIRY_HOURS PIV_SLOT
export SHAMIR_THRESHOLD SHAMIR_SHARES

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_DIR="${REPO_ROOT}/pki/export"

# ==============================================================================
# HOST PREP
# ==============================================================================
sanitize_host_environment() {
  echo "[*] Stopping host pcscd so the container can grab the smart card reader..."
  sudo systemctl stop pcscd pcscd.socket 2>/dev/null || true
  mkdir -p "${EXPORT_DIR}"
}

# ==============================================================================
# CONTAINER IMAGE
# ==============================================================================
generate_docker_image() {
  echo "[*] Building ephemeral ceremony container..."
  local ctx
  ctx="$(mktemp -d)"
  cat >"${ctx}/Dockerfile" <<'EOF'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg pcscd pcsc-tools \
      yubikey-manager python3 python3-pip python3-venv \
      srm \
    && rm -rf /var/lib/apt/lists/*

# Cosign (Sigstore) — pinned to a release that ships a static linux-amd64 binary
RUN curl -fsSL -o /usr/local/bin/cosign \
      https://github.com/sigstore/cosign/releases/download/v2.5.3/cosign-linux-amd64 \
    && chmod 0755 /usr/local/bin/cosign

# Python tooling: SLIP-0039 sharding + Ed25519 seed extraction
RUN python3 -m venv /opt/pki-env \
    && /opt/pki-env/bin/pip install --no-cache-dir \
      "shamir-mnemonic[cli]" cryptography

# step CLI is downloaded at runtime so its provenance can be verified with cosign
ENV PATH="/opt/pki-env/bin:${PATH}"
WORKDIR /pki
# Empty entrypoint so docker run <script> execs the script directly.
ENTRYPOINT []
EOF
  docker build -t "${DOCKER_IMAGE}" "${ctx}"
  rm -rf "${ctx}"
}

# ==============================================================================
# INNER CEREMONY (runs inside the container)
# ==============================================================================
write_inner_script() {
  cat >"${EXPORT_DIR}/inner_ceremony.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail

: "${STEP_VERSION:?STEP_VERSION is required}"
: "${ROOT_CA_NAME:?}"
: "${INTERMEDIATE_CA_NAME:?}"
: "${KEY_TYPE:?}"
: "${CURVE:?}"
: "${ROOT_EXPIRY_HOURS:?}"
: "${INTERMEDIATE_EXPIRY_HOURS:?}"
: "${PIV_SLOT:?}"
: "${SHAMIR_THRESHOLD:?}"
: "${SHAMIR_SHARES:?}"

EXPORT_DIR="/pki/export"
mkdir -p "${EXPORT_DIR}"

echo "[*] Starting pcscd inside the container..."
mkdir -p /var/run/pcscd
pcscd --disable-polkit >/dev/null 2>&1 &
sleep 1

# --------------------------------------------------------------
verify_step_cli() {
  local ver="${STEP_VERSION}"
  local tarball="step_linux_${ver}_amd64.tar.gz"
  local bundle="step_linux_${ver}_amd64.tar.gz.sigstore.json"
  # smallstep publishes to dl.smallstep.com, not github.com/<repo>/releases/download
  local base="https://dl.smallstep.com/gh-release/cli/gh-release-header/v${ver}"
  echo "[*] Downloading Smallstep CLI ${ver}..."
  curl -fsSLO "${base}/${tarball}"
  curl -fsSLO "${base}/${bundle}"

  echo "[*] Verifying step provenance with cosign..."
  cosign verify-blob \
    --bundle "${bundle}" \
    --certificate-identity-regexp 'https://github\.com/smallstep/workflows/.*' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "${tarball}"

  tar -xf "${tarball}"
  install -m 0755 "step_${ver}/bin/step" /usr/local/bin/step
  rm -rf "step_${ver}" "${tarball}" "${bundle}"
  step version
}

# --------------------------------------------------------------
# Generate the root CA. step generates a fresh Ed25519 key internally;
# we capture it to disk so we can shard the seed and import to hardware.
generate_root_ca() {
  echo "[*] Generating root CA [${ROOT_CA_NAME}]..."
  step certificate create "${ROOT_CA_NAME}" \
    "${EXPORT_DIR}/root.crt" "${EXPORT_DIR}/root.key" \
    --profile root-ca \
    --kty "${KEY_TYPE}" --crv "${CURVE}" \
    --not-after "${ROOT_EXPIRY_HOURS}" \
    --no-password --insecure
}

# --------------------------------------------------------------
# Pull the 32-byte Ed25519 seed out of the root.key PEM and split it into
# SLIP-0039 shards. --master-secret is MANDATORY: without it shamir create
# generates its own random secret and the shards wouldn't recover the root key.
shard_root_seed() {
  echo "[*] Extracting root seed and sharding into SLIP-0039 (${SHAMIR_THRESHOLD}-of-${SHAMIR_SHARES})..."
  local seed_hex
  seed_hex="$(python3 - <<'PY'
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
with open("/pki/export/root.key", "rb") as f:
    priv = serialization.load_pem_private_key(f.read(), password=None)
if not isinstance(priv, ed25519.Ed25519PrivateKey):
    raise SystemExit("root.key is not Ed25519 — refuse to shard")
# OpenSSH + Raw encoding yields the raw 32-byte seed for Ed25519.
seed = priv.private_bytes(
    encoding=serialization.Encoding.Raw,
    format=serialization.PrivateFormat.OpenSSH,
    encryption_algorithm=serialization.NoEncryption(),
)
print(seed.hex())
PY
)"
  printf '%s' "${seed_hex}" > "${EXPORT_DIR}/root_seed.hex"

  echo
  echo "[!] CAUTION — transcribe the following SLIP-0039 shards now."
  echo "[!] Store each shard with a different trusted party."
  echo "------------------------------------------------------------"
  shamir create "${SHAMIR_THRESHOLD}of${SHAMIR_SHARES}" \
    --master-secret="${seed_hex}"
  echo "------------------------------------------------------------"
  echo "[*] After confirming all shards are recorded, press Enter to continue."
  read -r _
}

# --------------------------------------------------------------
# Anchor the root on a YubiKey PIV slot. Requires YubiKey 5.7+ for Ed25519 PIV.
import_to_yubikey() {
  echo "[*] YubiKey device info:"
  ykman piv info

  # NOTE: a custom management key is intentionally NOT set here by default.
  # The default PIV management key is well-known, so if you want to enforce
  # one, run on a fully air-gapped host and uncomment:
  #   ykman piv access change-management-key --generate
  # (Subsequent piv keys/certificates import commands will then prompt for it
  # — capture it securely, it's the recovery path for re-keying the slot.)

  echo "[*] Importing root key into PIV slot ${PIV_SLOT}..."
  ykman piv keys import "${PIV_SLOT}" "${EXPORT_DIR}/root.key"

  echo "[*] Importing root cert into PIV slot ${PIV_SLOT}..."
  ykman piv certificates import "${PIV_SLOT}" "${EXPORT_DIR}/root.crt"
}

# --------------------------------------------------------------
# Issue an intermediate CA signed by the (hardware-anchored) root. The
# intermediate's .key + .crt ship to Vault (terraform/vault/pki-fml.tf).
issue_intermediate() {
  echo "[*] Issuing intermediate CA [${INTERMEDIATE_CA_NAME}]..."
  step certificate create "${INTERMEDIATE_CA_NAME}" \
    "${EXPORT_DIR}/intermediate.crt" "${EXPORT_DIR}/intermediate.key" \
    --profile intermediate-ca \
    --kty "${KEY_TYPE}" --crv "${CURVE}" \
    --ca "${EXPORT_DIR}/root.crt" --ca-key "${EXPORT_DIR}/root.key" \
    --not-after "${INTERMEDIATE_EXPIRY_HOURS}" \
    --no-password --insecure
}

# --------------------------------------------------------------
# Concatenate intermediate key + cert into a single PEM bundle. This is the
# form vault_pki_secret_backend_config_ca.pem_bundle consumes when Terraform
# imports the offline-generated CA into the Vault PKI mount as its active CA.
bundle_intermediate() {
  echo "[*] Writing intermediate.pem for Vault import..."
  cat "${EXPORT_DIR}/intermediate.key" "${EXPORT_DIR}/intermediate.crt" \
    > "${EXPORT_DIR}/intermediate.pem"
  chmod 0600 "${EXPORT_DIR}/intermediate.pem"
}

# --------------------------------------------------------------
# The root private key now lives ONLY on the YubiKey + in the shards.
# Scrub every disk copy. Use srm when available, fall back to shred/rm.
scrub_root_key() {
  if command -v srm >/dev/null 2>&1; then
    srm -f "${EXPORT_DIR}/root.key" "${EXPORT_DIR}/root_seed.hex" 2>/dev/null || true
  else
    shred -u "${EXPORT_DIR}/root.key" "${EXPORT_DIR}/root_seed.hex" 2>/dev/null \
      || rm -f "${EXPORT_DIR}/root.key" "${EXPORT_DIR}/root_seed.hex"
  fi
  echo "[+] Scrubbed root.key + raw seed from disk."
  echo "[+] Outputs in ${EXPORT_DIR}:"
  ls -l "${EXPORT_DIR}"
}

verify_step_cli
generate_root_ca
shard_root_seed
import_to_yubikey
issue_intermediate
bundle_intermediate
scrub_root_key
INNER
  chmod +x "${EXPORT_DIR}/inner_ceremony.sh"
}

# ==============================================================================
# RUN THE CEREMONY IN THE CONTAINER
# ==============================================================================
run_ceremony() {
  echo "[*] Launching container with USB passthrough..."
  docker run -it --rm \
    --device /dev/bus/usb \
    --privileged \
    -v "${EXPORT_DIR}:/pki/export" \
    -e STEP_VERSION -e ROOT_CA_NAME -e INTERMEDIATE_CA_NAME \
    -e KEY_TYPE -e CURVE \
    -e ROOT_EXPIRY_HOURS -e INTERMEDIATE_EXPIRY_HOURS \
    -e PIV_SLOT -e SHAMIR_THRESHOLD -e SHAMIR_SHARES \
    --name pki-ceremony \
    "${DOCKER_IMAGE}" \
    /pki/export/inner_ceremony.sh
}

# ==============================================================================
# CLEANUP ON HOST
# ==============================================================================
cleanup_host() {
  rm -f "${EXPORT_DIR}/inner_ceremony.sh"
  sudo systemctl start pcscd 2>/dev/null || true
  echo
  echo "[+] Ceremony complete. Operational artifacts in: ${EXPORT_DIR}/"
  echo "[+] Intermediate .key/.crt are ready to import into Vault's PKI mount"
  echo "    (terraform/vault/pki-fml.tf). Keep root.crt for chain bundling."
  echo "[+] REMINDER: the root private key lives ONLY on the YubiKey + in your"
  echo "    SLIP-0039 shards. Lose both and the root is unrecoverable."
}

# ==============================================================================
# MAIN
# ==============================================================================
sanitize_host_environment
generate_docker_image
write_inner_script
run_ceremony
cleanup_host
