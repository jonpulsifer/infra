#!/usr/bin/env bash
# Checks folly's signed Talos metal disk image, which fleet-boot writes for a
# Talos class: its EFI system partition holds sd-boot at the removable path
# and one UKI under EFI/Linux, each with one signature by the given
# certificate, the UKI fetches its config by code as the installer's does
# (talos-uki-config-verify.sh), and its META partition holds no Talos ADV in
# either copy and no syslinux ADV at its end, so the image carries no META
# value of its own.
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
# place_of <field> <value> prints the start and size, in sectors, of the one
# partition whose field has the value, or nothing.
place_of() {
  jq -r --arg k "$1" --arg v "$2" \
    '[.partitiontable.partitions[] | select((.[$k] // "" | ascii_upcase) == ($v | ascii_upcase))]
     | if length == 1 then "\(.[0].start) \(.[0].size)" else "" end' <<<"$table"
}
read -r esp_start _ <<<"$(place_of type C12A7328-F81F-11D2-BA4B-00A0C93EC93B)"
read -r meta_start meta_size <<<"$(place_of name META)"
[[ -n "$esp_start" ]] || fail "want one EFI system partition"
[[ -n "$meta_start" ]] || fail "want one META partition"

esp="$disk@@$((esp_start * sector))"
mapfile -t ukis < <(mdir -b -i "$esp" ::/EFI/Linux 2>/dev/null | grep -i '\.efi$' || true)
[[ ${#ukis[@]} -eq 1 ]] || fail "want one UKI under EFI/Linux, found ${#ukis[@]}"
mcopy -n -i "$esp" "${ukis[0]}" "$tmp/uki.efi"
mcopy -n -i "$esp" ::/EFI/BOOT/BOOTX64.EFI "$tmp/sd-boot.efi" || fail "no sd-boot at EFI/BOOT/BOOTX64.EFI"

bash "$here/talos-uki-verify.sh" "$cert" "$tmp/sd-boot.efi"
bash "$here/talos-uki-config-verify.sh" "$cert" "$tmp/uki.efi" "$url" "$image"

# word_at <byte offset> prints the 4 bytes there as hex.
word_at() {
  dd if="$disk" bs=1 skip="$1" count=4 status=none | od -An -tx1 | tr -d ' \n'
}
meta=$((meta_start * sector))
meta_end=$((meta + meta_size * sector))
# The Talos ADV's magic1, big-endian, in each 256 KiB copy, and the syslinux
# ADV's head, little-endian, in each 512-byte copy at the end.
for at in "$meta" "$((meta + 262144))"; do
  [[ "$(word_at "$at")" != 5a4b3c2d ]] || fail "META holds a Talos ADV at byte $at, so the image carries META values of its own"
done
for at in "$((meta_end - 1024))" "$((meta_end - 512))"; do
  [[ "$(word_at "$at")" != a52f2d5a ]] || fail "META holds a syslinux ADV at byte $at, so the image carries META values of its own"
done
echo "$image: $(stat -c %s "$image") bytes compressed, $(stat -c %s "$disk") raw"
