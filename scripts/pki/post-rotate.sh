#!/usr/bin/env bash
# Post-apply glue for terraform/pki signer (re)issuance.
#
# After `atlantis apply` (or a local tofu apply) creates/rotates the per-cluster
# SA token signers, this script:
#   1. writes the public cert material to terraform/pki/certs/ (committed);
#      a replaced signer's previous cert is kept as *-prev.pem so the JWKS
#      retains the old key while tokens signed by it are still live,
#   2. sops-encrypts each signer private key into the control-plane host's
#      nix/secrets/<host>.sops.yaml (key: k8s-sa-signing-key) — plaintext never
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

for cluster in folly offsite; do
  host="${control_plane[$cluster]}"
  issuer="$(jq -er ".issuers.value.\"$cluster\"" <<<"$outputs")"
  signer_pem="$certs_dir/$cluster-sa-signer.pem"
  prev_pem="$certs_dir/$cluster-sa-signer-prev.pem"

  jq -er ".cluster_ca_certs.value.\"$cluster\"" <<<"$outputs" >"$certs_dir/$cluster-ca.pem"

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

  echo "==> $cluster: sops-encrypting signer key for $host" >&2
  secret_file="$repo_root/nix/secrets/$host.sops.yaml"
  key_json="$(jq -c ".sa_signer_private_keys.value.\"$cluster\"" <<<"$outputs")"
  if [[ -s $secret_file ]]; then
    # NB: sops set takes the value on argv — briefly visible in process listings
    # on the operator machine; acceptable for a single-user laptop.
    sops set "$secret_file" '["k8s-sa-signing-key"]' "$key_json"
  else
    encrypted="$(jq -n --argjson key "$key_json" '{"k8s-sa-signing-key": $key}' \
      | sops encrypt --filename-override "$secret_file" --input-type json --output-type yaml /dev/stdin)"
    printf '%s\n' "$encrypted" >"$secret_file"
  fi

  echo "==> $cluster: regenerating OIDC documents" >&2
  jwks_args=("$signer_pem")
  [[ -s $prev_pem ]] && jwks_args+=("$prev_pem")
  python3 "$repo_root/scripts/pki/jwks_from_certs.py" \
    --issuer "$issuer" \
    --out "$pki_dir/oidc/$cluster" \
    "${jwks_args[@]}"
done

cat >&2 <<'EOF'

Done. Next steps:
  1. git add terraform/pki/certs terraform/pki/oidc nix/secrets && commit + PR
     (the next atlantis apply uploads the refreshed OIDC documents)
  2. deploy the control planes (optiplex, retrofit) per the runbook
  3. after old tokens age out, remove *-sa-signer-prev.pem and rerun this script
EOF
