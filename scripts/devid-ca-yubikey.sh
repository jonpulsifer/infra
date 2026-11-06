#!/usr/bin/env bash
# Makes the YubiKey on an anchor a hardware DevID CA, from the operator machine over ssh. init stores
# new PIV secrets and writes the CSR of a key generated on the card; sign has OpenBao's issuing CA on
# forge sign that CSR and writes the certificate, its chain and the bundle under certs/; install
# writes the certificate into the card; bundle writes certs/folly-devid-ca.pem.
# docs/runbooks/set-up-a-devid-ca-yubikey.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/yubikey.sh
source "$root/scripts/yubikey.sh"
readonly pki_dir="$root/terraform/pki"
readonly certs_dir="$pki_dir/certs"
readonly algorithm="RSA2048"
readonly slot="9c"
readonly openbao_host="forge"
readonly openbao_item="openbao-forge"
readonly openbao_mount="pki/folly"
# Five years, or what is left of the issuing CA's term less an hour, since a CA must not outlive
# its issuer.
readonly devid_ttl_seconds=$((43830 * 3600))

usage() {
  echo "usage: $0 {init <host> | sign <host> | install <host> | bundle}" >&2
  exit 2
}

pem_certs() {
  sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p'
}

# write_bundle <certs dir> concatenates every issuing DevID CA, in byte order of file name. A
# folly-devid-ca-<name>-chain.pem is that CA's chain to the root, and stays out.
write_bundle() {
  local dir="$1" LC_ALL=C
  local bundle="$dir/folly-devid-ca.pem" files=() f
  shopt -s nullglob
  for f in "$dir"/folly-devid-ca-*.pem; do
    [[ "$f" == *-chain.pem ]] || files+=("$f")
  done
  shopt -u nullglob
  if ((${#files[@]} == 0)); then
    rm -f "$bundle"
    return
  fi
  for f in "${files[@]}"; do
    sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' "$f"
  done >"$bundle.tmp"
  mv "$bundle.tmp" "$bundle"
  echo "==> wrote ${bundle#"$root/"} from ${#files[@]} DevID CA(s)" >&2
}

init_key() {
  local host="${1:-}"
  [[ -n "$host" ]] || usage
  check_host "$host"
  need jq nix op sops ssh od
  : "${SOPS_AGE_KEY_FILE:?set SOPS_AGE_KEY_FILE to the operator key}"

  local sops_file="$root/nix/secrets/$host.sops.yaml"
  local csr="$pki_dir/csr/folly-devid-ca-$host.csr"
  local item="devid-ca-$host"
  local cn="folly-devid-ca-$host"
  [[ ! -e "$csr" ]] || die "${csr#"$root/"} exists; this host's CA is initialized"

  local tgt serial fw
  tgt="$(target "$host")"
  card_info "$host" "$tgt"
  firmware_allows "$algorithm" "$fw" || die "firmware $fw must not generate $algorithm keys"

  make_work
  new_piv_secrets "$host" "$item" "$slot" \
    "The PIV secrets of the YubiKey that holds the DevID CA $cn on $host, set by scripts/devid-ca-yubikey.sh."

  echo "==> setting the PIV secrets and generating an $algorithm key in slot $slot on the card" >&2
  local subject="CN=$cn,O=$org"
  mkdir -p "$pki_dir/csr"
  if ! remote "$tgt" >"$work/csr.pem" <<EOF
ykman() { command ykman --device $serial "\$@"; }
work="\$(mktemp -d /run/yubikey.XXXXXX)"
trap 'rm -rf "\$work"' EXIT
$(piv_secrets_script)
ykman piv keys generate -m $(cat "$work/piv-mgmt-key") -a $algorithm --pin-policy ONCE --touch-policy NEVER $slot "\$work/pub.pem" >&2
ykman piv certificates request -P $(cat "$work/piv-pin") -s $(printf '%q' "$subject") $slot "\$work/pub.pem" "\$work/csr.pem" >&2
openssl req -in "\$work/csr.pem" -noout -verify >&2
cmp -s <(openssl req -in "\$work/csr.pem" -noout -pubkey) "\$work/pub.pem" || { echo "the CSR does not carry the slot's key" >&2; exit 1; }
cat "\$work/csr.pem"
EOF
  then
    die "the card refused a step; 1Password '$item' and ${sops_file#"$root/"} hold its new secrets (runbook: If something goes wrong)"
  fi
  grep -q 'BEGIN CERTIFICATE REQUEST' "$work/csr.pem" || die "the anchor returned no CSR"
  cp "$work/csr.pem" "$csr"
  chmod 0644 "$csr"

  cat >&2 <<EOF

Done: ${csr#"$root/"} holds the CSR of $cn.
Next:
  1. In nix/hosts/$host.nix, set homelab.yubikey.serial = $serial;
  2. Commit the CSR, ${sops_file#"$root/"} and nix/hosts/$host.nix, and open a pull request.
  3. Comment 'atlantis plan -d terraform/pki', then 'atlantis apply'.
  4. Run: mise run devid:yubikey:install $host
EOF
}

# sign_cert <host> has the issuing CA in OpenBao on forge sign the committed CSR, with the root token
# from 1Password, and writes the CA certificate, its chain to the FML root, and the bundle. The CSR's
# subject is kept, so every LDevID the key signed before still names its issuer.
sign_cert() {
  local host="${1:-}"
  [[ -n "$host" ]] || usage
  check_host "$host"
  need jq op ssh

  local csr="$pki_dir/csr/folly-devid-ca-$host.csr"
  local cert="$certs_dir/folly-devid-ca-$host.pem"
  local chain="$certs_dir/folly-devid-ca-$host-chain.pem"
  [[ -s "$csr" ]] || die "${csr#"$root/"} does not exist; run init first"

  local tgt dns_zone
  tgt="$(target "$openbao_host")"
  dns_zone="$(jq -er .locals.fleet.dns_zone "$root/terraform/network/tailscale/fleet.tf.json")"
  make_work

  echo "==> reading the root token from 1Password '$openbao_item'" >&2
  op item get "$openbao_item" --vault "$op_vault" --fields label=root-token --reveal >"$work/root-token"
  [[ -s "$work/root-token" ]] || die "1Password '$openbao_item' holds no root-token"

  echo "==> signing ${csr#"$root/"} with $openbao_mount on $tgt: pathLen 0, five years at most" >&2
  remote "$tgt" >"$work/signed.json" <<EOF
export BAO_ADDR="https://$openbao_host.$dns_zone:8200"
export BAO_TOKEN="$(cat "$work/root-token")"
ends="\$(bao read -field=certificate $openbao_mount/cert/ca | openssl x509 -noout -enddate | cut -d= -f2)"
left=\$((\$(date -d "\$ends" +%s) - \$(date +%s) - 3600))
ttl=$devid_ttl_seconds
((left < ttl)) && ttl=\$left
bao write -format=json $openbao_mount/root/sign-intermediate csr=- ttl=\${ttl}s max_path_length=0 use_csr_values=true <<'CSR'
$(cat "$csr")
CSR
EOF
  jq -er '.data.certificate' "$work/signed.json" | pem_certs >"$cert"
  [[ -s "$cert" ]] || die "the server returned no certificate"
  # ca_chain may repeat the signed certificate first; the chain file holds it once, then the issuing
  # CA and the root.
  {
    cat "$cert"
    jq -er '(.data.certificate | gsub("\\s"; "")) as $c | .data.ca_chain[] | select((gsub("\\s"; "")) != $c)' "$work/signed.json"
  } | pem_certs >"$chain"
  write_bundle "$certs_dir"

  echo "==> checking the committed chain" >&2
  go -C "$root/apps/fml-pki" run . verify

  cat >&2 <<EOF

Done: ${cert#"$root/"} and ${chain#"$root/"} hold the CA certificate of folly-devid-ca-$host under the FML root.
Commit them and terraform/pki/certs/folly-devid-ca.pem in a pull request, then run: mise run devid:yubikey:install $host
EOF
}

install_cert() {
  local host="${1:-}"
  [[ -n "$host" ]] || usage
  check_host "$host"
  need go jq nix sops ssh
  : "${SOPS_AGE_KEY_FILE:?set SOPS_AGE_KEY_FILE to the operator key}"

  local sops_file="$root/nix/secrets/$host.sops.yaml"
  local cert="$certs_dir/folly-devid-ca-$host.pem"
  [[ -s "$cert" ]] || die "${cert#"$root/"} does not exist; run sign first"

  echo "==> reading homelab.yubikey of $host" >&2
  local config id serial
  config="$(host_config "$host")"
  id="$(slot_id "$slot")"
  serial="$(jq -r '.serial // empty' <<<"$config")"
  [[ -n "$serial" ]] || die "set homelab.yubikey.serial in nix/hosts/$host.nix"

  local tgt pin mgmt_key
  tgt="$(target "$host")"
  [[ "$(the_yubikey "$tgt")" == "$serial" ]] || die "the YubiKey on $host is not serial $serial"
  pin="$(sops decrypt --extract '["yubikey"]["piv-pin"]' "$sops_file")"
  mgmt_key="$(sops decrypt --extract '["yubikey"]["piv-mgmt-key"]' "$sops_file")"

  echo "==> writing the certificate into slot $slot and signing through PKCS#11" >&2
  remote "$tgt" <<EOF
ykman() { command ykman --device $serial "\$@"; }
work="\$(mktemp -d /run/yubikey.XXXXXX)"
trap 'rm -rf "\$work"' EXIT
cat >"\$work/cert.pem" <<'PEM'
$(cat "$cert")
PEM
ykman piv certificates import -m $mgmt_key -P $pin --verify $slot "\$work/cert.pem" >&2
ykman piv info >&2
ykman piv certificates export $slot "\$work/stored.pem"
cmp -s <(openssl x509 -in "\$work/stored.pem" -outform der) <(openssl x509 -in "\$work/cert.pem" -outform der) ||
  { echo "slot $slot does not hold the issued certificate" >&2; exit 1; }
label="YubiKey PIV #$serial"
pkcs11-tool --module $ykcs11 --list-token-slots >&2
printf 'devid-ca self-test %s\n' "\$(date -u +%FT%TZ)" >"\$work/data"
pkcs11-tool --module $ykcs11 --token-label "\$label" --login --pin $pin --sign --id $id -m SHA256-RSA-PKCS -i "\$work/data" -o "\$work/sig" >&2
openssl x509 -in "\$work/cert.pem" -noout -pubkey >"\$work/pub.pem"
openssl dgst -sha256 -verify "\$work/pub.pem" -signature "\$work/sig" "\$work/data" >&2
echo "token label: \$label" >&2
EOF

  echo "==> checking the committed chain" >&2
  go -C "$root/apps/fml-pki" run . verify

  cat >&2 <<EOF

Done: slot $slot of YubiKey $serial on $host holds ${cert#"$root/"}, and ykcs11 signs with it.
EOF
}

main() {
  case "${1:-}" in
    init) init_key "${2:-}" ;;
    sign) sign_cert "${2:-}" ;;
    install) install_cert "${2:-}" ;;
    bundle)
      write_bundle "$certs_dir"
      ;;
    *) usage ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
