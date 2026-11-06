#!/usr/bin/env bash
# Builds and signs folly's netboot images: iPXE with the Talos UKI key, and the
# generic HookOS UKI and the two fleet-boot UKIs with the HookOS key. Nix
# builds iPXE, HookOS and the NixOS fleet-boot unsigned, from
# nix/images/ipxe-folly.nix, nix/images/hookos-folly.nix and
# nix/images/fleet-boot.nix. The Alpine fleet-boot's kernel and initramfs come
# from the image netboot.json pins by digest (images/fleet-boot-alpine), packed
# here into one UKI with the words every fleet-boot image shares; an all-zero
# digest is no image yet, and the build skips it.
#
# usage: talos-netboot-build.sh <uki key> <uki cert> <hookos key> <hookos cert> <out dir> <netboot.json>
# Run from the repository root. nix, crane and sbsigntool on PATH.

set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "usage: $0 <uki key> <uki cert> <hookos key> <hookos cert> <out dir> <netboot.json>" >&2
  exit 64
fi
uki_key=$1 uki_cert=$2 hookos_key=$3 hookos_cert=$4 out=$5 pins=$6

ipxe=$(nix build --no-link --print-out-paths .#ipxe-folly)
hookos=$(nix build --no-link --print-out-paths .#hookos-folly)
fleetboot=$(nix build --no-link --print-out-paths .#fleet-boot)

mkdir -p "$out"
sbsign --key "$uki_key" --cert "$uki_cert" \
  --output "$out/ipxe-amd64-secureboot.efi" "$ipxe/ipxe.efi"
sbsign --key "$hookos_key" --cert "$hookos_cert" \
  --output "$out/hookos-amd64-secureboot-uki.efi" "$hookos/hookos.efi"
sbsign --key "$hookos_key" --cert "$hookos_cert" \
  --output "$out/fleet-boot-amd64-secureboot-uki.efi" "$fleetboot/fleet-boot.efi"

# alpine_uki packs the pinned Alpine image's /boot into an unsigned UKI at $1.
alpine_uki() {
  local image tmp ukify cmdline
  image=$(jq -r '.fleet_boot_alpine_image // empty' "$pins")
  [[ "$image" =~ ^ghcr\.io/jonpulsifer/fleet-boot-alpine@sha256:[0-9a-f]{64}$ ]] || {
    echo "$pins: fleet_boot_alpine_image is not ghcr.io/jonpulsifer/fleet-boot-alpine by digest" >&2
    return 1
  }
  if [[ "$image" == *@sha256:0000000000000000000000000000000000000000000000000000000000000000 ]]; then
    echo "$pins pins no Alpine fleet-boot image yet, so no Alpine UKI is built"
    return 2
  fi
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  crane export "$image" - | tar -x -C "$tmp" boot/vmlinuz boot/initramfs.zst boot/uname
  for f in vmlinuz initramfs.zst uname; do
    [[ -s "$tmp/boot/$f" ]] || {
      echo "$image: carries no /boot/$f" >&2
      return 1
    }
  done
  # The flake's own nixpkgs, so the stub is the one fleet-boot.nix packs with.
  ukify=$(nix build --no-link --print-out-paths --inputs-from . 'nixpkgs#systemdUkify.out')
  cmdline=$(nix eval --raw .#fleet-boot.bootCmdline)
  "$ukify/bin/ukify" build \
    --linux="$tmp/boot/vmlinuz" \
    --initrd="$tmp/boot/initramfs.zst" \
    --stub="$ukify/lib/systemd/boot/efi/linuxx64.efi.stub" \
    --uname="$(tr -d '[:space:]' <"$tmp/boot/uname")" \
    --os-release='ID=fleet-boot-alpine' \
    --cmdline="$cmdline" \
    --output="$1"
  echo "Alpine fleet-boot: $image, kernel $(cat "$tmp/boot/uname")"
}

status=0
alpine_uki "$out/fleet-boot-alpine.unsigned.efi" || status=$?
case "$status" in
  0)
    sbsign --key "$hookos_key" --cert "$hookos_cert" \
      --output "$out/fleet-boot-alpine-amd64-secureboot-uki.efi" "$out/fleet-boot-alpine.unsigned.efi"
    rm -f "$out/fleet-boot-alpine.unsigned.efi"
    ;;
  2) ;;
  *) exit "$status" ;;
esac

for f in ipxe-amd64-secureboot.efi hookos-amd64-secureboot-uki.efi fleet-boot-amd64-secureboot-uki.efi; do
  [[ -s "$out/$f" ]] || {
    echo "missing output $out/$f" >&2
    exit 1
  }
done
if [[ "$status" -eq 0 && ! -s "$out/fleet-boot-alpine-amd64-secureboot-uki.efi" ]]; then
  echo "missing output $out/fleet-boot-alpine-amd64-secureboot-uki.efi" >&2
  exit 1
fi
