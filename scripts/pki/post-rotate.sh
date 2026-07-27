#!/usr/bin/env bash
# Post-apply glue for terraform/pki cluster CA and signer (re)issuance.
#
# After `atlantis apply` creates/rotates the per-cluster CAs or SA token
# signers, this script:
#   1. writes the public cert material to terraform/pki/certs/ (committed);
#      replaced CA and signer certs are kept as *-prev.pem for trust overlap,
#      and each cluster CA gets a current-plus-previous *-ca-bundle.pem,
#   2. sops-encrypts each cluster CA and signer private key into the matching
#      control-plane host's nix/secrets/<host>.sops.yaml — plaintext never
#      touches disk,
#   3. regenerates terraform/pki/oidc/<cluster>/{jwks.json,openid-configuration.json}
#      via scripts/pki/jwks_from_certs.py.
#
# Commit the result and let Atlantis upload the refreshed documents, then deploy
# the control planes per the Kubernetes GitOps runbook. Requires: tofu, sops
# (>= 3.9 for --filename-override), jq, openssl, python3. Run from anywhere in
# the repo; needs op auth only indirectly (tofu output reads state, not 1P).

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
pki_dir="$repo_root/terraform/pki"
certs_dir="$pki_dir/certs"

# cluster -> control-plane host (sops secret target)
declare -A control_plane=(
  [folly]="optiplex"
  [offsite]="retrofit"
)

echo "==> reading terraform/pki outputs" >&2
outputs="$(tofu -chdir="$pki_dir" output -json)"

mkdir -p "$certs_dir"
jq -er '.fml_root_cert.value' <<<"$outputs" >"$certs_dir/fml-root.pem"
jq -er '.fml_intermediate_cert.value' <<<"$outputs" >"$certs_dir/fml-intermediate.pem"

sops_set_key() {
  secret_file=$1
  secret_name=$2
  output_name=$3
  cluster=$4

  jq -cer ".${output_name}.value.\"$cluster\"" <<<"$outputs" \
    | sops set --value-stdin "$secret_file" "[\"$secret_name\"]"
}

verify_key_pair() {
  cert_output=$1
  key_output=$2
  cluster=$3

  cert_spki="$(
    jq -er ".${cert_output}.value.\"$cluster\"" <<<"$outputs" \
      | openssl x509 -pubkey -noout \
      | openssl pkey -pubin -outform DER \
      | openssl sha256
  )"
  key_spki="$(
    jq -er ".${key_output}.value.\"$cluster\"" <<<"$outputs" \
      | openssl pkey -pubout -outform DER \
      | openssl sha256
  )"
  if [[ $cert_spki != "$key_spki" ]]; then
    echo "error: $cluster $cert_output does not match $key_output" >&2
    return 1
  fi
}

for cluster in folly offsite; do
  host="${control_plane[$cluster]}"
  issuer="$(jq -er ".issuers.value.\"$cluster\"" <<<"$outputs")"
  ca_pem="$certs_dir/$cluster-ca.pem"
  ca_prev_pem="$certs_dir/$cluster-ca-prev.pem"
  ca_bundle_pem="$certs_dir/$cluster-ca-bundle.pem"
  signer_pem="$certs_dir/$cluster-sa-signer.pem"
  prev_pem="$certs_dir/$cluster-sa-signer-prev.pem"

  verify_key_pair cluster_ca_certs cluster_ca_private_keys "$cluster"
  verify_key_pair sa_signer_certs sa_signer_private_keys "$cluster"

  # Preserve the old CA before replacement. Consumers stage ca-bundle.pem,
  # rotate every leaf, and only then retire ca-prev.pem in a later commit.
  new_ca="$(jq -er ".cluster_ca_certs.value.\"$cluster\"" <<<"$outputs")"
  if [[ -s $ca_pem ]] && ! diff -q <(printf '%s' "$new_ca") "$ca_pem" >/dev/null 2>&1; then
    echo "==> $cluster: previous CA kept for overlap ($ca_prev_pem)" >&2
    cp "$ca_pem" "$ca_prev_pem"
  fi
  printf '%s' "$new_ca" >"$ca_pem"
  cp "$ca_pem" "$ca_bundle_pem"
  if [[ -s $ca_prev_pem ]]; then
    printf '\n' >>"$ca_bundle_pem"
    cat "$ca_prev_pem" >>"$ca_bundle_pem"
  fi

  # Preserve a replaced signer cert for JWKS overlap during rotation.
  new_signer="$(jq -er ".sa_signer_certs.value.\"$cluster\"" <<<"$outputs")"
  if [[ -s $signer_pem ]] && ! diff -q <(printf '%s' "$new_signer") "$signer_pem" >/dev/null 2>&1; then
    echo "==> $cluster: previous signer kept for overlap ($prev_pem)" >&2
    cp "$signer_pem" "$prev_pem"
  fi
  printf '%s' "$new_signer" >"$signer_pem"

  # Drop the overlap cert once it has expired.
  if [[ -s $prev_pem ]] && ! openssl x509 -checkend 0 -noout -in "$prev_pem" >/dev/null; then
    echo "==> $cluster: previous signer expired; removing $prev_pem" >&2
    rm "$prev_pem"
  fi

  echo "==> $cluster: sops-encrypting cluster CA and signer keys for $host" >&2
  secret_file="$repo_root/nix/secrets/$host.sops.yaml"
  if [[ -s $secret_file ]]; then
    sops_set_key "$secret_file" "k8s-cluster-ca-key" cluster_ca_private_keys "$cluster"
    sops_set_key "$secret_file" "k8s-sa-signing-key" sa_signer_private_keys "$cluster"
  else
    encrypted="$(
      jq -n \
        --argjson cluster_ca_key "$(jq -c ".cluster_ca_private_keys.value.\"$cluster\"" <<<"$outputs")" \
        --argjson signer_key "$(jq -c ".sa_signer_private_keys.value.\"$cluster\"" <<<"$outputs")" \
        '{
          "k8s-cluster-ca-key": $cluster_ca_key,
          "k8s-sa-signing-key": $signer_key
        }' \
        | sops encrypt --filename-override "$secret_file" --input-type json --output-type yaml /dev/stdin
    )"
    printf '%s\n' "$encrypted" >"$secret_file"
  fi

  echo "==> $cluster: regenerating OIDC documents" >&2
  jwks_args=("$signer_pem")
  [[ -s $prev_pem ]] && jwks_args+=("$prev_pem")
  python3 "$repo_root/scripts/pki/jwks_from_certs.py" \
    --issuer "$issuer" \
    --out "$pki_dir/oidc/$cluster" \
    "${jwks_args[@]}"

  echo "==> $cluster: certificate inventory" >&2
  for cert in "$ca_pem" "$ca_prev_pem" "$signer_pem" "$prev_pem"; do
    [[ -s $cert ]] || continue
    openssl x509 -noout -subject -serial -dates -in "$cert" \
      | sed "s|^|    $(basename "$cert"): |" >&2
  done
done

cat >&2 <<'EOF'

Done. Next steps:
  1. git add terraform/pki/certs terraform/pki/oidc nix/secrets && commit + PR
     (the next atlantis apply uploads the refreshed OIDC documents)
  2. deploy the control planes only after the matching NixOS configuration
     consumes the refreshed keys
  3. after every TLS leaf uses the new CA, remove *-ca-prev.pem and rerun this
     script; after old tokens age out, do the same for *-sa-signer-prev.pem
EOF
