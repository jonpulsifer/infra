#!/usr/bin/env bash
# Puts the PKI that git declares into the OpenBao server on this host, and does nothing when it is
# already there. nix/services/openbao-config.nix runs it as openbao-config.service with a token
# credential, after the server unseals, and daily. Environment: BAO_ADDR, ROOT_MOUNT, ROOT_CN,
# ROOT_TTL, MOUNT, ISSUING_CN, ISSUING_TTL, ORG, POLICY_DIR (<name>.hcl per policy), CONFIG_POLICY.
set -euo pipefail

BAO_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/token")"
export BAO_TOKEN
key_name="${MOUNT##*/}"

# bao status exits 0 unsealed, 2 sealed, 1 unreachable.
for _ in $(seq 90); do
  bao status >/dev/null 2>&1 && break
  sleep 2
done
bao status >/dev/null
# With no token named, renew renews the caller's own.
bao token renew >/dev/null

echo "==> policies"
bao policy write openbao-config "$CONFIG_POLICY"
for f in "$POLICY_DIR"/*.hcl; do
  bao policy write "$(basename "$f" .hcl)" "$f"
done

pem_body() {
  sed -n '/^-----BEGIN CERTIFICATE-----$/,/^-----END CERTIFICATE-----$/p' | tr -d '[:space:]'
}

# pki_mount <path> <max lease TTL>: a PKI mount with its AIA URLs.
pki_mount() {
  echo "==> mount $1"
  if bao secrets list -format=json | jq -e --arg m "$1/" 'has($m)' >/dev/null; then
    bao secrets tune -max-lease-ttl="$2" "$1"
  else
    bao secrets enable -path="$1" -max-lease-ttl="$2" pki
  fi
  bao write "$1/config/urls" \
    issuing_certificates="$BAO_ADDR/v1/$1/ca" \
    crl_distribution_points="$BAO_ADDR/v1/$1/crl" >/dev/null
}

# The root is born in the server and never leaves it. The Raft store and the escrowed unseal key
# are its backup; it signs the issuing CA and nothing else.
pki_mount "$ROOT_MOUNT" "$ROOT_TTL"
echo "==> root CA"
if ! bao read "$ROOT_MOUNT/issuer/default" >/dev/null 2>&1; then
  bao write -format=json "$ROOT_MOUNT/root/generate/internal" \
    common_name="$ROOT_CN" organization="$ORG" key_name=root issuer_name=root \
    key_type=ec key_bits=384 ttl="$ROOT_TTL" max_path_length=2 \
    | jq -r '"    generated, serial " + .data.serial_number'
fi
bao write "$ROOT_MOUNT/issuer/default" usage="read-only,issuing-certificates,crl-signing" >/dev/null
root_cert="$(bao read -field=certificate "$ROOT_MOUNT/cert/ca")"
root_body="$(printf '%s\n' "$root_cert" | pem_body)"

pki_mount "$MOUNT" "$ISSUING_TTL"
echo "==> issuing CA key $key_name"
if ! bao read "$MOUNT/key/$key_name" >/dev/null 2>&1; then
  bao write -format=json "$MOUNT/intermediate/generate/internal" \
    key_name="$key_name" key_type=ec key_bits=256 \
    common_name="$ISSUING_CN" organization="$ORG" >/dev/null
  echo "    generated"
fi

echo "==> issuing CA certificate"
chain="$(bao read -format=json "$MOUNT/cert/ca_chain" 2>/dev/null | jq -r '.data.ca_chain // .data.certificate // ""' | tr -d '[:space:]' || true)"
if [[ "$chain" != *"$root_body"* ]]; then
  # A fresh request for the same key, signed by the root in the server.
  cert="$(bao write -field=csr "$MOUNT/intermediate/generate/existing" \
    key_ref="$key_name" common_name="$ISSUING_CN" organization="$ORG" \
    | bao write -field=certificate "$ROOT_MOUNT/root/sign-intermediate" csr=- \
      common_name="$ISSUING_CN" organization="$ORG" ttl="$ISSUING_TTL" \
      max_path_length=1 use_csr_values=false)"
  want="$(printf '%s\n' "$cert" | pem_body)"
  # The root is imported with it so that ca_chain reaches the root.
  imported="$(printf '%s\n%s\n' "$cert" "$root_cert" \
    | bao write -format=json "$MOUNT/intermediate/set-signed" certificate=- \
    | jq -r '.data.imported_issuers[]?')"
  issuer=""
  for id in $imported $(bao list -format=json "$MOUNT/issuers" | jq -r '.[]'); do
    if [[ "$(bao read -field=certificate "$MOUNT/issuer/$id" | pem_body)" == "$want" ]]; then
      issuer="$id"
      break
    fi
  done
  [[ -n "$issuer" ]] || {
    echo "the server did not import the issuing CA certificate" >&2
    exit 1
  }
  bao write "$MOUNT/config/issuers" default="$issuer" default_follows_latest_issuer=false >/dev/null
  bao write "$MOUNT/issuer/$issuer" issuer_name="$key_name" >/dev/null
  echo "    signed; $issuer is the default issuer"
fi
# A leaf that would outlive the CA is truncated to the CA's notAfter, not refused.
bao write "$MOUNT/issuer/default" leaf_not_after_behavior=truncate \
  usage="read-only,issuing-certificates,crl-signing" >/dev/null

echo "==> roles"
# The Kubernetes ServiceAccount token signers, one leaf a year each; the chain is cosmetic, the
# JWKS carries the public key.
bao write "$MOUNT/roles/sa-signer" \
  allowed_domains="FML K8s folly ServiceAccount token signer,FML K8s offsite ServiceAccount token signer" \
  allow_bare_domains=true allow_subdomains=false allow_glob_domains=false enforce_hostnames=false \
  allow_ip_sans=false allow_any_name=false require_cn=true use_csr_common_name=true use_csr_sans=false \
  server_flag=false client_flag=false key_usage="DigitalSignature" ext_key_usage="" \
  key_type=any ttl=8760h max_ttl=8760h organization="$ORG" >/dev/null
# Internal service names, short-lived, for cert-manager.
bao write "$MOUNT/roles/services" \
  allowed_domains="lolwtf.ca" allow_subdomains=true allow_bare_domains=false allow_glob_domains=false \
  enforce_hostnames=true allow_ip_sans=true allow_any_name=false require_cn=false \
  server_flag=true client_flag=true key_type=any ttl=72h max_ttl=168h organization="$ORG" >/dev/null

echo "ok"
