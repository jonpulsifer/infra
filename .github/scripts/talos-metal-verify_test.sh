#!/usr/bin/env bash
# Tests talos-metal-verify.sh against stand-in metal images: a GPT disk with
# an EFI system partition holding signed stand-ins for sd-boot and the UKI,
# laid out as imager writes them, and a META partition. Needs zstd, sfdisk,
# jq, mtools, objdump, openssl, python3 and sbsigntool.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/talos-metal-verify.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Talos fills in the placeholders, so they stay literal.
# shellcheck disable=SC2016
url='https://enroll.lolwtf.ca/talos/config?uuid=${uuid}&code=${code}'
wipe=talos.experimental.wipe=system:EPHEMERAL,STATE
good="talos.platform=metal console=tty0 talos.config=$url"

# shellcheck source=.github/scripts/talos-uki-testlib.sh
. "$here/talos-uki-testlib.sh"

certificate "$work" signer

signed() {
  local out=$1
  shift
  pe "$out.unsigned" "$@"
  sbsign --key "$work/signer.key" --cert "$work/signer.pem" --output "$out" "$out.unsigned" >/dev/null 2>&1
}

signed "$work/uki.efi" .cmdline "$good" .profile 'ID=reset-maintenance' .cmdline "$good $wipe"
signed "$work/sd-boot.efi" .sdmagic 'sd-boot'

# image <name> [ukis] [sector] [magic]: a 48 MiB disk with a 32 MiB EFI
# system partition holding sd-boot and that many UKIs, and a 1 MiB META from
# sector 67584, with the magic's bytes, printf escapes, written at the
# sector, and compressed to <name>.raw.zst.
image() {
  local name=$1 ukis=${2:-1} magic=${3:-} bytes=${4:-} disk="$work/$1.raw"
  truncate -s 48M "$disk"
  sfdisk -q "$disk" >/dev/null <<'EOF'
label: gpt
start=2048, size=65536, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name="EFI"
start=67584, size=2048, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="META"
EOF
  local esp="$disk@@1048576"
  mformat -i "$esp" -T 65536 -h 64 -s 32 ::
  mmd -i "$esp" ::/EFI ::/EFI/BOOT ::/EFI/Linux
  mcopy -i "$esp" "$work/sd-boot.efi" ::/EFI/BOOT/BOOTX64.EFI
  for i in $(seq 1 "$ukis"); do
    mcopy -i "$esp" "$work/uki.efi" "::/EFI/Linux/Talos-v1.14.5~$i.efi"
  done
  if [[ -n "$magic" ]]; then
    # shellcheck disable=SC2059
    printf "$bytes" | dd of="$disk" bs=512 seek="$magic" conv=notrunc status=none
  fi
  zstd -qf "$disk" -o "$work/$name.raw.zst"
}

expect_pass() {
  bash "$script" "$work/signer.pem" "$work/$1.raw.zst" "$url" >/dev/null 2>&1 || fail "$1: want a pass"
}

expect_fail() {
  if bash "$script" "$work/signer.pem" "$work/$1.raw.zst" "$url" >/dev/null 2>&1; then
    fail "$1: want a failure"
  fi
}

image good
expect_pass good
image two-ukis 2
expect_fail two-ukis
image no-uki 0
expect_fail no-uki
# The first copy, the second 256 KiB in, and the syslinux ADV in the last KiB.
talos='\x5a\x4b\x3c\x2d' syslinux='\xa5\x2f\x2d\x5a'
image baked-first 1 67584 "$talos"
expect_fail baked-first
image baked-second 1 68096 "$talos"
expect_fail baked-second
image baked-syslinux 1 69630 "$syslinux"
expect_fail baked-syslinux

echo "talos-metal-verify: all cases pass"
