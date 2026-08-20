#!/usr/bin/env bash
# Post-apply glue for terraform/pki cluster CA and signer (re)issuance.
#
# After `atlantis apply` creates/rotates the per-cluster CAs or SA token
# signers, this script:
#   1. writes the public cert material to terraform/pki/certs/ (committed);
#      replaced CA and signer certs are kept as *-prev.pem for trust overlap,
#      each cluster CA gets a current-plus-previous *-ca-bundle.pem, and a
#      *-ca-chain.pem carrying the cluster CA up to the self-signed root,
#   2. sops-encrypts each cluster CA and signer private key into the matching
#      control-plane host's nix/secrets/<host>.sops.yaml — plaintext never
#      touches disk,
#   3. regenerates terraform/pki/oidc/<cluster>/{jwks.json,openid-configuration.json}
#      via apps/fml-pki, and rewrites the one committed certificate copy that
#      lives outside certs/, clusters/offsite/apps/spindrift/ca-bundle.yaml.
#
# Commit the result and let Atlantis upload the refreshed documents, then deploy
# the control planes per the Kubernetes GitOps runbook. Requires: tofu, sops
# (>= 3.9 for --filename-override), jq and go. All certificate handling goes
# through apps/fml-pki, so there is no openssl or python dependency. Run from
# anywhere in the repo; needs op auth only indirectly (tofu reads state, not 1P).

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
pki_dir="$repo_root/terraform/pki"
certs_dir="$pki_dir/certs"

if (($# == 0)); then
  echo "usage: $0 <folly|offsite> [<folly|offsite> ...]" >&2
  exit 2
fi

# Preflight, because this script writes certificates and rewrites SOPS files as
# it goes: discovering a missing tool halfway leaves certs/ half-updated.
missing=()
for tool in tofu sops jq go; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
  echo "missing required tool(s): ${missing[*]}" >&2
  echo "the dev shell carries them — run this under 'nix develop -c \\" >&2
  echo "  bash scripts/pki/post-rotate.sh $*'" >&2
  exit 1
fi

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

  jq -ce ".${output_name}.value.\"$cluster\"" <<<"$outputs" \
    | sops set --value-stdin "$secret_file" "[\"$secret_name\"]"
}

# All certificate maths lives in the Go tool; "-" reads the PEM on stdin so a
# Terraform output never needs a temp file.
fml_pki() {
  go -C "$repo_root/apps/fml-pki" run . "$@"
}

# Overlap is keyed on the public key, not the certificate. A certificate can be
# reissued for the same key — a corrected constraint, a longer validity — and
# nothing that trusted the old one needs to keep trusting it, because the new
# one verifies every signature the old one did. Keying on the whole
# certificate turns those reissues into fake rotations: a *-prev.pem nobody
# needs, and a duplicate signer that publishes the same JWKS kid twice.
cert_key_id() {
  fml_pki spki -
}

verify_key_pair() {
  cert_output=$1
  key_output=$2
  cluster=$3

  cert_spki="$(jq -er ".${cert_output}.value.\"$cluster\"" <<<"$outputs" | fml_pki spki -)"
  key_spki="$(jq -er ".${key_output}.value.\"$cluster\"" <<<"$outputs" | fml_pki spki -)"
  if [[ $cert_spki != "$key_spki" ]]; then
    echo "error: $cluster $cert_output does not match $key_output" >&2
    return 1
  fi
}

for cluster in "$@"; do
  if [[ ! -v control_plane[$cluster] ]]; then
    echo "error: unknown cluster: $cluster" >&2
    exit 2
  fi
  host="${control_plane[$cluster]}"
  issuer="$(jq -er ".issuers.value.\"$cluster\"" <<<"$outputs")"
  ca_pem="$certs_dir/$cluster-ca.pem"
  ca_prev_pem="$certs_dir/$cluster-ca-prev.pem"
  ca_bundle_pem="$certs_dir/$cluster-ca-bundle.pem"
  ca_chain_pem="$certs_dir/$cluster-ca-chain.pem"
  signer_pem="$certs_dir/$cluster-sa-signer.pem"
  prev_pem="$certs_dir/$cluster-sa-signer-prev.pem"

  verify_key_pair cluster_ca_certs cluster_ca_private_keys "$cluster"
  verify_key_pair sa_signer_certs sa_signer_private_keys "$cluster"

  # Preserve the old CA before replacement. Consumers stage ca-bundle.pem,
  # rotate every leaf, and only then retire ca-prev.pem in a later commit.
  new_ca="$(jq -er ".cluster_ca_certs.value.\"$cluster\"" <<<"$outputs")"
  new_ca_key_id="$(printf '%s\n' "$new_ca" | cert_key_id)"
  current_ca_key_id="$([[ -s $ca_pem ]] && cert_key_id <"$ca_pem" || true)"
  if [[ -n $current_ca_key_id ]] && [[ $new_ca_key_id != "$current_ca_key_id" ]]; then
    echo "==> $cluster: previous CA kept for overlap ($ca_prev_pem)" >&2
    cp "$ca_pem" "$ca_prev_pem"
  fi
  printf '%s\n' "$new_ca" >"$ca_pem"
  if [[ -s $ca_prev_pem ]] && [[ $(cert_key_id <"$ca_prev_pem") == "$new_ca_key_id" ]]; then
    echo "==> $cluster: removing duplicate previous CA artifact" >&2
    rm "$ca_prev_pem"
  fi
  cp "$ca_pem" "$ca_bundle_pem"
  if [[ -s $ca_prev_pem ]]; then
    printf '\n' >>"$ca_bundle_pem"
    cat "$ca_prev_pem" >>"$ca_bundle_pem"
  fi

  # The chain file is what kube-controller-manager publishes to every pod as
  # ca.crt via --root-ca-file. The cluster CA is not self-signed, so on its own
  # an OpenSSL client cannot build a path out of it and fails with "unable to
  # get issuer certificate" — which is how Vector lost the API server.
  #
  # Deliberately a separate file from ca-bundle.pem. That one is the rotation
  # overlap set and feeds services.kubernetes.caFile, which also backs
  # clientCaFile and kubeletClientCaFile: putting the FML anchors there would
  # let anything issued under the FML Root authenticate to the API server.
  cat "$ca_pem" "$certs_dir/fml-intermediate.pem" "$certs_dir/fml-root.pem" >"$ca_chain_pem"

  # Preserve a replaced signer cert for JWKS overlap during rotation.
  new_signer="$(jq -er ".sa_signer_certs.value.\"$cluster\"" <<<"$outputs")"
  new_signer_key_id="$(printf '%s\n' "$new_signer" | cert_key_id)"
  current_signer_key_id="$([[ -s $signer_pem ]] && cert_key_id <"$signer_pem" || true)"
  if [[ -n $current_signer_key_id ]] && [[ $new_signer_key_id != "$current_signer_key_id" ]]; then
    echo "==> $cluster: previous signer kept for overlap ($prev_pem)" >&2
    cp "$signer_pem" "$prev_pem"
  fi
  printf '%s\n' "$new_signer" >"$signer_pem"
  if [[ -s $prev_pem ]] && [[ $(cert_key_id <"$prev_pem") == "$new_signer_key_id" ]]; then
    echo "==> $cluster: removing duplicate previous signer artifact" >&2
    rm "$prev_pem"
  fi

  # Drop the overlap cert once it has expired.
  if [[ -s $prev_pem ]] && fml_pki expired "$prev_pem"; then
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
  fml_pki jwks \
    --issuer "$issuer" \
    --out "$pki_dir/oidc/$cluster" \
    "${jwks_args[@]}"

  echo "==> $cluster: certificate inventory" >&2
  for cert in "$ca_pem" "$ca_prev_pem" "$signer_pem" "$prev_pem"; do
    [[ -s $cert ]] || continue
    fml_pki inspect "$cert" | sed "s|^|    |" >&2
  done
done

# The only committed copy of certificate material outside certs/. Spindrift
# reaches a peer cluster's API server over plain fetch, so NODE_EXTRA_CA_CERTS
# is its whole trust input, and its runtime will not treat an issuing CA as an
# anchor -- the peer needs a path all the way to a self-signed root. That makes
# it this cluster's own CA followed by the peer's chain file. Regenerated here
# because a hand-copied certificate follows nothing: it survives every rotation
# unchanged and expires on a date nobody is watching.
spindrift_bundle="$repo_root/clusters/offsite/apps/spindrift/ca-bundle.yaml"
if [[ -s $spindrift_bundle ]] \
  && [[ -s $certs_dir/offsite-ca.pem ]] \
  && [[ -s $certs_dir/folly-ca-chain.pem ]]; then
  echo "==> regenerating ${spindrift_bundle#"$repo_root/"}" >&2
  {
    sed -n '1,/^  ca.crt: |$/p' "$spindrift_bundle"
    cat "$certs_dir/offsite-ca.pem" "$certs_dir/folly-ca-chain.pem" | awk 'NF {print "    " $0}'
  } >"$spindrift_bundle.tmp"
  mv "$spindrift_bundle.tmp" "$spindrift_bundle"
fi

cat >&2 <<'EOF'

Done. Next steps:
  1. git add terraform/pki/certs terraform/pki/oidc nix/secrets \
       clusters/offsite/apps/spindrift/ca-bundle.yaml && commit + PR
     (the next atlantis apply uploads the refreshed OIDC documents)
  2. deploy the control planes only after the matching NixOS configuration
     consumes the refreshed keys, then restart cfssl and kube-controller-manager
     on each of them: sops-nix compares decrypted plaintext to decide restarts,
     so neither bounces when a certificate changes but its key does not
  3. a *-prev.pem appears only when a key actually changed. Once every TLS leaf
     uses the new CA, remove *-ca-prev.pem and rerun this script; after old
     tokens age out, do the same for *-sa-signer-prev.pem
EOF
