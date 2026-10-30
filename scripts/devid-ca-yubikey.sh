#!/usr/bin/env bash
# Makes the YubiKey on an anchor a hardware DevID CA, from the operator machine over ssh. init stores
# new PIV secrets and writes the CSR of a key generated on the card; install writes the issued
# certificate into the card; bundle writes certs/folly-devid-ca.pem. docs/runbooks/set-up-a-devid-ca-yubikey.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
readonly pki_dir="$root/terraform/pki"
readonly certs_dir="$pki_dir/certs"
readonly vault="homelab"
readonly org="Folly Mountain Laboratories"
readonly algorithm="RSA2048"
# The PIV applet's factory PIN, PUK and management key.
readonly default_pin="123456"
readonly default_puk="12345678"
readonly default_mgmt_key="010203040506070801020304050607080102030405060708"
# nix/services/devid-ca-yubikey.nix links the module here.
readonly ykcs11="/etc/devid-ca/libykcs11.so"

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 {init <host> | install <host> | bundle}" >&2
  exit 2
}

need() {
  local missing=() tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || missing+=("$tool")
  done
  ((${#missing[@]} == 0)) || die "missing required tool(s): ${missing[*]}"
}

# firmware_allows <algorithm> <version> succeeds when the firmware generates that key type safely.
firmware_allows() {
  local alg="$1" fw="$2" major minor patch
  IFS=. read -r major minor patch <<<"$fw"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || return 1
  local version=$((major * 10000 + minor * 100 + patch))
  case "$alg" in
    # ROCA (YSA-2017-01): RSA keys generated on 4.2.6 to 4.3.4 are factorable.
    RSA*) ((major != 4 || version >= 40305)) ;;
    # EUCLEAK (YSA-2024-03): ECDSA on firmware before 5.7 leaks its key through a side channel.
    ECC*) ((version >= 50700)) ;;
    *) return 1 ;;
  esac
}

# info_field <label> reads "<label>: <value>" from ykman output on stdin.
info_field() {
  sed -n "s/^$1:[[:space:]]*//p" | head -n 1
}

# slot_id <slot> is ykcs11's CKA_ID for a PIV slot.
slot_id() {
  case "$1" in
    9a) echo 01 ;;
    9c) echo 02 ;;
    9d) echo 03 ;;
    9e) echo 04 ;;
    *) return 1 ;;
  esac
}

random_digits() {
  local n="$1" out="" byte
  while ((${#out} < n)); do
    for byte in $(od -An -tu1 -N16 /dev/urandom); do
      # Bytes 250-255 would bias the digits 0-5.
      ((byte < 250)) && out+=$((byte % 10))
    done
  done
  printf '%s' "${out:0:n}"
}

random_hex() {
  od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'
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

work=""
shred_work() {
  [[ -n "$work" ]] || return 0
  find "$work" -type f -exec shred -u {} +
  rm -rf "$work"
}

check_host() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "a host is a lowercase name, such as spore"
  [[ -f "$root/nix/secrets/$1.sops.yaml" ]] || die "nix/secrets/$1.sops.yaml does not exist"
}

target() {
  local tailnet
  tailnet="$(jq -er .locals.fleet.tailnet "$root/terraform/network/tailscale/fleet.tf.json")"
  printf '%s.%s' "$1" "$tailnet"
}

# host_config <host> prints the host's homelab.devidCa.yubikey as JSON.
host_config() {
  nix eval --json "$root#nixosConfigurations.$1.config.homelab.devidCa.yubikey" \
    --apply 'c: { inherit (c) enable slot serial; }'
}

# remote <target> runs the script on stdin as root on the anchor; secrets never reach local argv.
remote() {
  ssh -o BatchMode=yes "$1" sudo bash -euo pipefail -s
}

# the_yubikey <target> prints the serial of the one YubiKey on the anchor.
the_yubikey() {
  local serials
  serials="$(remote "$1" <<<'ykman list --serials')"
  [[ -n "$serials" ]] || die "no YubiKey on $1"
  (($(wc -l <<<"$serials") == 1)) || die "more than one YubiKey on $1: $(tr '\n' ' ' <<<"$serials")"
  printf '%s' "$serials"
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
  ! grep -q '^devid-ca:' "$sops_file" || die "$sops_file already holds devid-ca secrets"
  ! op item get "$item" --vault "$vault" >/dev/null 2>&1 || die "1Password item '$item' exists"

  echo "==> reading homelab.devidCa.yubikey of $host" >&2
  local config slot
  config="$(host_config "$host")"
  [[ "$(jq -r .enable <<<"$config")" == true ]] || die "set homelab.devidCa.yubikey.enable on $host and deploy it first"
  slot="$(jq -er .slot <<<"$config")"

  local tgt serial info fw
  tgt="$(target "$host")"
  serial="$(the_yubikey "$tgt")"
  info="$(remote "$tgt" <<<"ykman --device $serial info")"
  fw="$(info_field "Firmware version" <<<"$info")"
  echo "==> $(info_field "Device type" <<<"$info"), serial $serial, firmware $fw" >&2
  firmware_allows "$algorithm" "$fw" || die "firmware $fw must not generate $algorithm keys"
  local interfaces
  interfaces="$(info_field "Enabled USB interfaces" <<<"$info")"
  [[ -z "$interfaces" || "$interfaces" == *CCID* ]] || die "the PIV (CCID) interface is off; run ykman config usb --enable CCID"

  local piv
  piv="$(remote "$tgt" <<<"ykman --device $serial piv info")"
  if grep -q '^Slot ' <<<"$piv"; then
    die "the PIV applet holds a key or certificate; if nothing on it is needed, run 'ykman piv reset' on $host"
  fi

  umask 077
  work="$(mktemp -d)"
  trap shred_work EXIT

  local pin puk mgmt_key
  pin="$(random_digits 8)"
  puk="$(random_digits 8)"
  mgmt_key="$(random_hex 24)"
  printf '%s' "$pin" >"$work/piv-pin"
  printf '%s' "$puk" >"$work/piv-puk"
  printf '%s' "$mgmt_key" >"$work/piv-mgmt-key"

  # Both copies exist before the card changes, so a failure below loses no secret.
  echo "==> storing the new PIV secrets in 1Password '$item' and ${sops_file#"$root/"}" >&2
  jq -n \
    --arg title "$item" --arg host "$host" --arg slot "$slot" --arg serial "$serial" \
    --arg notes "The PIV secrets of the YubiKey that holds the DevID CA $cn on $host, set by scripts/devid-ca-yubikey.sh." \
    --rawfile pin "$work/piv-pin" --rawfile puk "$work/piv-puk" --rawfile mgmt "$work/piv-mgmt-key" '{
      title: $title,
      category: "SECURE_NOTE",
      fields: [
        {id: "notesPlain", type: "STRING", purpose: "NOTES", value: $notes},
        {label: "piv-pin", type: "CONCEALED", value: $pin},
        {label: "piv-puk", type: "CONCEALED", value: $puk},
        {label: "piv-mgmt-key", type: "CONCEALED", value: $mgmt},
        {label: "serial", type: "STRING", value: $serial},
        {label: "slot", type: "STRING", value: $slot},
        {label: "host", type: "STRING", value: $host}
      ]
    }' >"$work/item.json"
  op item create --vault "$vault" --template "$work/item.json" >/dev/null
  op item get "$item" --vault "$vault" --reveal --format json >"$work/stored.json"
  local f stored
  for f in piv-pin piv-puk piv-mgmt-key; do
    stored="$(jq -j --arg label "$f" '.fields[] | select(.label == $label) | .value' "$work/stored.json" | sha256sum)"
    [[ "$stored" == "$(sha256sum <"$work/$f")" ]] || die "1Password item '$item' does not hold $f as generated; the card is unchanged"
  done
  for f in piv-pin piv-puk piv-mgmt-key; do
    jq -Rs . <"$work/$f" | sops set --value-stdin "$sops_file" "[\"devid-ca\"][\"$f\"]"
  done
  (($(grep -A3 '^devid-ca:' "$sops_file" | grep -c 'ENC\[') == 3)) || die "$sops_file does not hold three encrypted devid-ca values"

  echo "==> setting the PIV secrets and generating an $algorithm key in slot $slot on the card" >&2
  local subject="CN=$cn,O=$org"
  mkdir -p "$pki_dir/csr"
  if ! remote "$tgt" >"$work/csr.pem" <<EOF
ykman() { command ykman --device $serial "\$@"; }
work="\$(mktemp -d /run/devid-ca.XXXXXX)"
trap 'rm -rf "\$work"' EXIT
ykman piv access change-management-key --algorithm tdes -m $default_mgmt_key -n $mgmt_key --force >&2
ykman piv access change-puk -p $default_puk -n $puk >&2
ykman piv access change-pin -P $default_pin -n $pin >&2
ykman piv keys generate -m $mgmt_key -a $algorithm --pin-policy ONCE --touch-policy NEVER $slot "\$work/pub.pem" >&2
ykman piv certificates request -P $pin -s $(printf '%q' "$subject") $slot "\$work/pub.pem" "\$work/csr.pem" >&2
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
  1. In nix/hosts/$host.nix, set homelab.devidCa.yubikey.serial = $serial;
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

  echo "==> reading homelab.devidCa.yubikey of $host" >&2
  local config slot id serial
  config="$(host_config "$host")"
  slot="$(jq -er .slot <<<"$config")"
  id="$(slot_id "$slot")"
  serial="$(jq -r '.serial // empty' <<<"$config")"
  [[ -n "$serial" ]] || die "set homelab.devidCa.yubikey.serial in nix/hosts/$host.nix"

  echo "==> reading the issued certificate from terraform/pki state" >&2
  local pem
  pem="$(tofu -chdir="$pki_dir" output -json devid_ca_yubikey_certs | jq -er --arg h "$host" '.[$h]')" \
    || die "terraform/pki has issued no certificate for $host; apply the CSR's pull request with Atlantis"
  printf '%s\n' "$pem" | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' >"$cert"
  write_bundle "$certs_dir"

  local tgt pin mgmt_key
  tgt="$(target "$host")"
  [[ "$(the_yubikey "$tgt")" == "$serial" ]] || die "the YubiKey on $host is not serial $serial"
  pin="$(sops decrypt --extract '["devid-ca"]["piv-pin"]' "$sops_file")"
  mgmt_key="$(sops decrypt --extract '["devid-ca"]["piv-mgmt-key"]' "$sops_file")"

  echo "==> writing the certificate into slot $slot and signing through PKCS#11" >&2
  remote "$tgt" <<EOF
ykman() { command ykman --device $serial "\$@"; }
work="\$(mktemp -d /run/devid-ca.XXXXXX)"
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
