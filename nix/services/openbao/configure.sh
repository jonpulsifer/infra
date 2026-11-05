#!/usr/bin/env bash
# Puts the PKI that git declares into the OpenBao server on this host, and does nothing when it is
# already there. nix/services/openbao-config.nix runs it as openbao-config.service with a token
# credential, after the server unseals, and daily. Environment: BAO_ADDR, MOUNT, STATE_DIR,
# ISSUING_CN, ORG, MAX_TTL, ISSUING_CERT (the signed CA, or empty while the root has not signed),
# ROOT_CERT, POLICY_DIR (<name>.hcl per policy), CONFIG_POLICY.
set -euo pipefail

BAO_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/token")"
export BAO_TOKEN
csr_file="$STATE_DIR/${MOUNT##*/}-issuing-ca.csr"
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

echo "==> mount $MOUNT"
if bao secrets list -format=json | jq -e --arg m "$MOUNT/" 'has($m)' >/dev/null; then
  bao secrets tune -max-lease-ttl="$MAX_TTL" "$MOUNT"
else
  bao secrets enable -path="$MOUNT" -max-lease-ttl="$MAX_TTL" pki
fi
bao write "$MOUNT/config/urls" \
  issuing_certificates="$BAO_ADDR/v1/$MOUNT/ca" \
  crl_distribution_points="$BAO_ADDR/v1/$MOUNT/crl" >/dev/null

# The issuing CA's key is born in the server and never leaves it. Its CSR waits in $STATE_DIR
# for the root ceremony; a lost CSR is made again from the same key.
echo "==> issuing CA key $key_name"
if ! bao read "$MOUNT/key/$key_name" >/dev/null 2>&1; then
  bao write -format=json "$MOUNT/intermediate/generate/internal" \
    key_name="$key_name" key_type=ec key_bits=256 \
    common_name="$ISSUING_CN" organization="$ORG" \
    | jq -r .data.csr >"$csr_file.tmp"
  mv "$csr_file.tmp" "$csr_file"
  echo "    generated; the CSR is at $csr_file"
elif [[ ! -s "$csr_file" ]]; then
  bao write -format=json "$MOUNT/intermediate/generate/existing" \
    key_ref="$key_name" common_name="$ISSUING_CN" organization="$ORG" \
    | jq -r .data.csr >"$csr_file.tmp"
  mv "$csr_file.tmp" "$csr_file"
  echo "    the CSR is at $csr_file again"
fi

pem_body() {
  sed -n '/^-----BEGIN CERTIFICATE-----$/,/^-----END CERTIFICATE-----$/p' | tr -d '[:space:]'
}

if [[ -n "${ISSUING_CERT:-}" ]]; then
  echo "==> issuing CA certificate"
  want="$(pem_body <"$ISSUING_CERT")"
  have="$(bao read -field=certificate "$MOUNT/cert/ca" 2>/dev/null | pem_body || true)"
  if [[ "$want" != "$have" ]]; then
    # The chain is imported with it so that ca_chain reaches the root.
    cat "$ISSUING_CERT" "$ROOT_CERT" >"$STATE_DIR/chain.pem"
    bao write -format=json "$MOUNT/intermediate/set-signed" certificate=@"$STATE_DIR/chain.pem" >"$STATE_DIR/set-signed.json"
    rm -f "$STATE_DIR/chain.pem"
    issuer=""
    for id in $(jq -r '.data.imported_issuers[]?' "$STATE_DIR/set-signed.json"); do
      if [[ "$(bao read -field=certificate "$MOUNT/issuer/$id" | pem_body)" == "$want" ]]; then
        issuer="$id"
      fi
    done
    rm -f "$STATE_DIR/set-signed.json"
    if [[ -z "$issuer" ]]; then
      # Imported on an earlier run that failed before this point.
      for id in $(bao list -format=json "$MOUNT/issuers" | jq -r '.[]'); do
        if [[ "$(bao read -field=certificate "$MOUNT/issuer/$id" | pem_body)" == "$want" ]]; then
          issuer="$id"
        fi
      done
    fi
    [[ -n "$issuer" ]] || {
      echo "the server did not import $ISSUING_CERT" >&2
      exit 1
    }
    bao write "$MOUNT/config/issuers" default="$issuer" default_follows_latest_issuer=false >/dev/null
    bao write "$MOUNT/issuer/$issuer" issuer_name="$key_name" leaf_not_after_behavior=truncate \
      usage="read-only,issuing-certificates,crl-signing" >/dev/null
    echo "    set $issuer as the default issuer"
  fi
  # A leaf that would outlive the CA is truncated to the CA's notAfter, not refused.
  bao write "$MOUNT/issuer/default" leaf_not_after_behavior=truncate \
    usage="read-only,issuing-certificates,crl-signing" >/dev/null
else
  echo "==> no signed issuing CA certificate in git yet; roles wait for it"
fi

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
