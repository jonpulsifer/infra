#!/usr/bin/env bash
# Writes the committed signer certificate and OIDC documents for each named
# cluster from terraform/pki state, after Atlantis issues or rotates its SA token
# signer. Rotation steps: terraform/pki/README.md.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
pki_dir="$repo_root/terraform/pki"
certs_dir="$pki_dir/certs"

if (($# == 0)); then
  echo "usage: $0 offsite" >&2
  exit 2
fi

# Check every tool first: a failure halfway leaves certs/ half-updated.
missing=()
for tool in tofu jq go; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
  echo "missing required tool(s): ${missing[*]}" >&2
  echo "the dev shell carries them — run this under 'nix develop -c \\" >&2
  echo "  bash scripts/pki/post-rotate.sh $*'" >&2
  exit 1
fi

# Both clusters run Talos: each cluster CA is its secrets bundle's own, and the
# bundle carries the signer key, so this script writes neither.
clusters=(offsite)

echo "==> reading terraform/pki outputs" >&2
outputs="$(tofu -chdir="$pki_dir" output -json)"

mkdir -p "$certs_dir"
jq -er '.fml_root_cert.value' <<<"$outputs" >"$certs_dir/fml-root.pem"
jq -er '.fml_intermediate_cert.value' <<<"$outputs" >"$certs_dir/fml-intermediate.pem"

fml_pki() {
  go -C "$repo_root/apps/fml-pki" run . "$@"
}

# Overlap is keyed on the public key: a same-key reissue needs no *-prev.pem,
# and a duplicate signer would publish the same JWKS kid twice.
cert_key_id() {
  fml_pki spki -
}

for cluster in "$@"; do
  if [[ " ${clusters[*]} " != *" $cluster "* ]]; then
    echo "error: unknown cluster: $cluster" >&2
    exit 2
  fi
  issuer="$(jq -er ".issuers.value.\"$cluster\"" <<<"$outputs")"
  signer_pem="$certs_dir/$cluster-sa-signer.pem"
  prev_pem="$certs_dir/$cluster-sa-signer-prev.pem"

  # The replaced signer stays in the JWKS so the tokens it signed still verify.
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

  if [[ -s $prev_pem ]] && fml_pki expired "$prev_pem"; then
    echo "==> $cluster: previous signer expired; removing $prev_pem" >&2
    rm "$prev_pem"
  fi

  echo "==> $cluster: regenerating OIDC documents" >&2
  jwks_args=("$signer_pem")
  [[ -s $prev_pem ]] && jwks_args+=("$prev_pem")
  fml_pki jwks \
    --issuer "$issuer" \
    --out "$pki_dir/oidc/$cluster" \
    "${jwks_args[@]}"

  echo "==> $cluster: certificate inventory" >&2
  for cert in "$signer_pem" "$prev_pem"; do
    [[ -s $cert ]] || continue
    fml_pki inspect "$cert" | sed "s|^|    |" >&2
  done
done

cat >&2 <<'EOF'

Done. Next steps:
  1. git add terraform/pki/certs terraform/pki/oidc && commit + PR
     (the next atlantis apply uploads the refreshed OIDC documents)
  2. a *-prev.pem appears only when a key actually changed. After old tokens age
     out, remove *-sa-signer-prev.pem and rerun this script
EOF
