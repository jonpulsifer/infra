#!/usr/bin/env bash
# Makes the YubiKey on an anchor a hardware DevID CA, from the operator machine over ssh. init stores
# new PIV secrets and writes the CSR of a key generated on the card; install writes the issued
# certificate into the card; bundle writes certs/folly-devid-ca.pem. docs/runbooks/set-up-a-devid-ca-yubikey.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/yubikey.sh
source "$root/scripts/yubikey.sh"
readonly pki_dir="$root/terraform/pki"
readonly certs_dir="$pki_dir/certs"
readonly algorithm="RSA2048"
readonly slot="9c"

usage() {
  echo "usage: $0 {init <host> | install <host> | bundle}" >&2
  exit 2
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

install_cert() {
  local host="${1:-}"
  [[ -n "$host" ]] || usage
  check_host "$host"
  need go jq nix sops ssh tofu
  : "${SOPS_AGE_KEY_FILE:?set SOPS_AGE_KEY_FILE to the operator key}"

  local sops_file="$root/nix/secrets/$host.sops.yaml"
  local cert="$certs_dir/folly-devid-ca-$host.pem"

  echo "==> reading homelab.yubikey of $host" >&2
  local config id serial
  config="$(host_config "$host")"
  id="$(slot_id "$slot")"
  serial="$(jq -r '.serial // empty' <<<"$config")"
  [[ -n "$serial" ]] || die "set homelab.yubikey.serial in nix/hosts/$host.nix"

  echo "==> reading the issued certificate from terraform/pki state" >&2
  local pem
  pem="$(tofu -chdir="$pki_dir" output -json devid_ca_yubikey_certs | jq -er --arg h "$host" '.[$h]')" \
    || die "terraform/pki has issued no certificate for $host; apply the CSR's pull request with Atlantis"
  printf '%s\n' "$pem" | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' >"$cert"
  write_bundle "$certs_dir"

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
Commit ${cert#"$root/"} and terraform/pki/certs/folly-devid-ca.pem in a pull request.
EOF
}

main() {
  case "${1:-}" in
    init) init_key "${2:-}" ;;
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
