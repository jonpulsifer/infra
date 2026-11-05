#!/usr/bin/env bash
# Shared by the scripts that program a YubiKey on an anchor from the operator machine over ssh:
# devid-ca-yubikey.sh (a DevID CA key in slot 9c) and openbao-yubikey.sh (the OpenBao unseal key in
# slot 9d). Secrets travel on stdin, never in argv, and are shredded on exit. A script sets root to
# the repository before it sources this file.

: "${root:?the sourcing script sets root to the repository}"
# shellcheck disable=SC2034 # the sourcing scripts read these
readonly op_vault="homelab"
# shellcheck disable=SC2034
readonly org="Folly Mountain Laboratories"
# The PIV applet's factory PIN, PUK and management key.
readonly default_pin="123456"
readonly default_puk="12345678"
readonly default_mgmt_key="010203040506070801020304050607080102030405060708"
# nix/services/yubikey-piv.nix links the module here.
# shellcheck disable=SC2034
readonly ykcs11="/etc/yubikey/libykcs11.so"

die() {
  echo "error: $*" >&2
  exit 1
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

work=""
shred_work() {
  [[ -n "$work" ]] || return 0
  find "$work" -type f -exec shred -u {} +
  rm -rf "$work"
}

# make_work creates the shredded-on-exit working directory.
make_work() {
  umask 077
  work="$(mktemp -d)"
  trap shred_work EXIT
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

# host_config <host> prints the host's homelab.yubikey as JSON.
host_config() {
  nix eval --json "$root#nixosConfigurations.$1.config.homelab.yubikey" \
    --apply 'c: { inherit (c) enable serial; }'
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

# card_info <host> <target> prints `ykman info` after checking homelab.yubikey is on and the card is
# factory: no key in the PIV applet. Sets serial and fw.
card_info() {
  local host="$1" tgt="$2" config info
  echo "==> reading homelab.yubikey of $host" >&2
  config="$(host_config "$host")"
  [[ "$(jq -r .enable <<<"$config")" == true ]] || die "set homelab.yubikey.enable on $host and deploy it first"
  [[ "$(jq -r '.serial // empty' <<<"$config")" == "" ]] || die "homelab.yubikey.serial is set on $host; its card is initialized"
  serial="$(the_yubikey "$tgt")"
  info="$(remote "$tgt" <<<"ykman --device $serial info")"
  fw="$(info_field "Firmware version" <<<"$info")"
  echo "==> $(info_field "Device type" <<<"$info"), serial $serial, firmware $fw" >&2
  local interfaces
  interfaces="$(info_field "Enabled USB interfaces" <<<"$info")"
  [[ -z "$interfaces" || "$interfaces" == *CCID* ]] || die "the PIV (CCID) interface is off; run ykman config usb --enable CCID"
  local piv
  piv="$(remote "$tgt" <<<"ykman --device $serial piv info")"
  if grep -q '^Slot ' <<<"$piv"; then
    die "the PIV applet holds a key or certificate; if nothing on it is needed, run 'ykman piv reset' on $host"
  fi
}

# new_piv_secrets <host> <item> <slot> <notes> generates a PIN, PUK and management key into $work,
# and stores them in 1Password '<item>' and the host's SOPS file under yubikey/. Both copies exist
# before the card changes, so a failure after this loses no secret.
new_piv_secrets() {
  local host="$1" item="$2" slot="$3" notes="$4"
  local sops_file="$root/nix/secrets/$host.sops.yaml"
  ! grep -q '^yubikey:' "$sops_file" || die "$sops_file already holds yubikey secrets"
  ! op item get "$item" --vault "$op_vault" >/dev/null 2>&1 || die "1Password item '$item' exists"

  printf '%s' "$(random_digits 8)" >"$work/piv-pin"
  printf '%s' "$(random_digits 8)" >"$work/piv-puk"
  printf '%s' "$(random_hex 24)" >"$work/piv-mgmt-key"

  echo "==> storing the new PIV secrets in 1Password '$item' and ${sops_file#"$root/"}" >&2
  jq -n \
    --arg title "$item" --arg host "$host" --arg slot "$slot" --arg serial "$serial" --arg notes "$notes" \
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
  op item create --vault "$op_vault" --template "$work/item.json" >/dev/null
  op item get "$item" --vault "$op_vault" --reveal --format json >"$work/stored.json"
  local f stored
  for f in piv-pin piv-puk piv-mgmt-key; do
    stored="$(jq -j --arg label "$f" '.fields[] | select(.label == $label) | .value' "$work/stored.json" | sha256sum)"
    [[ "$stored" == "$(sha256sum <"$work/$f")" ]] || die "1Password item '$item' does not hold $f as generated; the card is unchanged"
  done
  for f in piv-pin piv-puk piv-mgmt-key; do
    jq -Rs . <"$work/$f" | sops set --value-stdin "$sops_file" "[\"yubikey\"][\"$f\"]"
  done
  (($(grep -A3 '^yubikey:' "$sops_file" | grep -c 'ENC\[') == 3)) || die "$sops_file does not hold three encrypted yubikey values"
}

# piv_secrets_script prints the ykman lines that move the card off its factory secrets, for a
# remote script that defines ykman() and reads $work/piv-*.
piv_secrets_script() {
  cat <<EOF
ykman piv access change-management-key --algorithm tdes -m $default_mgmt_key -n $(cat "$work/piv-mgmt-key") --force >&2
ykman piv access change-puk -p $default_puk -n $(cat "$work/piv-puk") >&2
ykman piv access change-pin -P $default_pin -n $(cat "$work/piv-pin") >&2
EOF
}
