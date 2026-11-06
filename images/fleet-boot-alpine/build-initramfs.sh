#!/bin/sh
# Turns the apk root the Dockerfile made into the Alpine fleet-boot image's
# kernel and initramfs: prunes the kernel modules to the lab's NICs, disks,
# file systems and TPMs (the list nix/images/fleet-boot.nix carries), moves the
# kernel out of the tree, and packs the tree as a zstd cpio.
#
# usage: build-initramfs.sh <tree> <out dir>
# Runs as root in the image build, with kmod, cpio and zstd on PATH.

set -eu

if [ $# -ne 2 ]; then
  echo "usage: $0 <tree> <out dir>" >&2
  exit 64
fi
tree=$1 out=$2

kver=$(ls "$tree/lib/modules")
case "$kver" in
  '' | *' '*)
    echo "$tree/lib/modules must hold one kernel, holds: '$kver'" >&2
    exit 1
    ;;
esac

# udev-less: init loads each present device's driver by its modalias, so the
# tree only decides what a boot can load. af_packet is the packet socket
# udhcpc sends from, a module in Alpine's kernel where NixOS's builds it in.
modules='e1000e igb igc r8169 tg3 r8152 ax88179_178a cdc_ether
  nvme ahci sd_mod usb_storage uas xhci_pci
  vfat nls_cp437 nls_iso8859_1 ext4
  tpm_tis tpm_crb efivarfs af_packet'

keep=$(mktemp)
depends=$(mktemp)
trap 'rm -f "$keep" "$depends"' EXIT
for m in $modules; do
  if ! modprobe -d "$tree" -S "$kver" --show-depends "$m" >"$depends" 2>&1; then
    echo "$m: $(cat "$depends")" >&2
    exit 1
  fi
  # A builtin prints "builtin <name>" and needs no file; an insmod line is the
  # path, then the options modprobe.d sets, or a trailing space.
  sed -n 's/^insmod \([^ ]*\).*$/\1/p' "$depends" >>"$keep"
done
sort -u "$keep" -o "$keep"
while read -r file; do
  [ -f "$file" ] || {
    echo "modprobe named $file, which the tree lacks" >&2
    exit 1
  }
done <"$keep"

find "$tree/lib/modules/$kver" -type f -name '*.ko*' | grep -vxF -f "$keep" | xargs -r rm -f
# Alpine's package links the kernel from the modules directory, which depmod
# would read; the kernel leaves the tree below.
rm -f "$tree/lib/modules/$kver/vmlinuz"
depmod -b "$tree" "$kver"

mkdir -p "$out"
mv "$tree/boot/vmlinuz-lts" "$out/vmlinuz"
printf '%s\n' "$kver" >"$out/uname"
rm -rf "${tree:?}/boot" "$tree/var/cache/apk" "$tree/etc/apk/cache"
# No package in the tree lays out the root, so the mount points init needs
# are made here; without them each mount fails and fleet-boot reads no
# command line, finds no device and sees no NIC.
mkdir -p "$tree/proc" "$tree/sys" "$tree/dev" "$tree/run" "$tree/tmp"

(cd "$tree" && find . -print0 | cpio --null --quiet -o -H newc --reproducible | zstd -19 -T0 -q -o "$out/initramfs.zst")
echo "kernel $kver: $(stat -c %s "$out/vmlinuz") bytes; initramfs: $(stat -c %s "$out/initramfs.zst") bytes, $(wc -l <"$keep") modules"
