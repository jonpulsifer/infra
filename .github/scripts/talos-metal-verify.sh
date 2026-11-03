#!/usr/bin/env bash
# Checks folly's signed Talos metal disk image, which fleet-boot writes for a
# Talos class: its EFI system partition holds sd-boot at the removable path
# and one UKI under EFI/Linux, each with one signature by the given
# certificate, the UKI fetches its config by code as the installer's does
# (talos-uki-config-verify.sh), and its META partition holds no Talos ADV,
# so the image carries no install code of its own.
#
# usage: talos-metal-verify.sh <signing-cert.pem> <metal.raw.zst> <talos.config URL>
# Needs zstd, sfdisk, jq, mtools, objdump, openssl and sbsigntool.

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <signing-cert.pem> <metal.raw.zst> <talos.config URL>" >&2
  exit 64
fi
cert=$1 image=$2 url=$3
here=$(cd "$(dirname "$0")" && pwd)

fail() {
  echo "$image: $*" >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
disk=$tmp/disk.raw
zstd -dcq "$image" >"$disk"

table=$(sfdisk --json "$disk")
sector=$(jq -r '.partitiontable.sectorsize // 512' <<<"$table")
# start_of <field> <value> prints the start sector of the one partition whose
# field has the value, or nothing.
start_of() {
  jq -r --arg k "$1" --arg v "$2" \
    '[.partitiontable.partitions[] | select((.[$k] // "" | ascii_upcase) == ($v | ascii_upcase))]
     | if length == 1 then .[0].start | tostring else "" end' <<<"$table"
}
esp_start=$(start_of type C12A7328-F81F-11D2-BA4B-00A0C93EC93B)
meta_start=$(start_of name META)
[[ -n "$esp_start" ]] || fail "want one EFI system partition"
[[ -n "$meta_start" ]] || fail "want one META partition"

esp="$disk@@$((esp_start * sector))"
mapfile -t ukis < <(mdir -b -i "$esp" ::/EFI/Linux 2>/dev/null | grep -i '\.efi$' || true)
[[ ${#ukis[@]} -eq 1 ]] || fail "want one UKI under EFI/Linux, found ${#ukis[@]}"
mcopy -n -i "$esp" "${ukis[0]}" "$tmp/uki.efi"
mcopy -n -i "$esp" ::/EFI/BOOT/BOOTX64.EFI "$tmp/sd-boot.efi" || fail "no sd-boot at EFI/BOOT/BOOTX64.EFI"

bash "$here/talos-uki-verify.sh" "$cert" "$tmp/sd-boot.efi"
bash "$here/talos-uki-config-verify.sh" "$cert" "$tmp/uki.efi" "$url" "$image"

magic=$(dd if="$disk" bs=512 skip="$((meta_start * sector / 512))" count=1 status=none | head -c 4 | od -An -tx1 | tr -d ' \n')
[[ "$magic" != 5a4b3c2d ]] || fail "META holds a Talos ADV, so the image carries META values of its own"
echo "$image: $(stat -c %s "$image") bytes compressed, $(stat -c %s "$disk") raw"
