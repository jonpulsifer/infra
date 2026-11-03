#!/usr/bin/env bash
# Builds and signs folly's netboot images: iPXE with the Talos UKI key, and the
# generic HookOS UKI and the fleet-boot UKI with the HookOS key. Nix builds all
# three unsigned, from nix/images/ipxe-folly.nix, nix/images/hookos-folly.nix
# and nix/images/fleet-boot.nix.
#
# usage: talos-netboot-build.sh <uki key> <uki cert> <hookos key> <hookos cert> <out dir>
# Run from the repository root. nix and sbsigntool on PATH.

set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <uki key> <uki cert> <hookos key> <hookos cert> <out dir>" >&2
  exit 64
fi
uki_key=$1 uki_cert=$2 hookos_key=$3 hookos_cert=$4 out=$5

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

for f in ipxe-amd64-secureboot.efi hookos-amd64-secureboot-uki.efi fleet-boot-amd64-secureboot-uki.efi; do
  [[ -s "$out/$f" ]] || {
    echo "missing output $out/$f" >&2
    exit 1
  }
done
