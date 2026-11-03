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

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=signer" \
  -addext extendedKeyUsage=codeSigning \
  -keyout "$work/signer.key" -out "$work/signer.pem" 2>/dev/null

# Writes a PE32+ image with a .text section and the given (name, contents)
# sections in order, as ukify lays out a UKI with one extra profile.
pe() {
  python3 -I - "$@" <<'PY'
import struct, sys

out, pairs = sys.argv[1], sys.argv[2:]
sections = [(b".text", b"\xc3")] + [
    (pairs[i].encode(), pairs[i + 1].encode()) for i in range(0, len(pairs), 2)
]
file_align, sect_align = 0x200, 0x1000
align = lambda n, a: (n + a - 1) // a * a
headers = align(0x40 + 4 + 20 + 240 + 40 * len(sections), file_align)
table, body, raw, va = b"", b"", headers, sect_align
for name, data in sections:
    size = align(len(data), file_align)
    flags = 0x60000020 if name == b".text" else 0x40000040
    table += struct.pack("<8sIIIIIIHHI", name, len(data), va, size, raw, 0, 0, 0, 0, flags)
    body += data.ljust(size, b"\0")
    raw += size
    va += align(len(data), sect_align)
optional = struct.pack(
    "<HBBIIIIIQIIHHHHHHIIIIHHQQQQII",
    0x20B, 0, 0, 0x200, 0, 0, sect_align, sect_align, 0x140000000, sect_align, file_align,
    0, 0, 0, 0, 0, 0, 0, va, headers, 0, 10, 0, 0x100000, 0x1000, 0x100000, 0x1000, 0, 16,
) + b"\0" * 128
coff = struct.pack("<HHIIIHH", 0x8664, len(sections), 0, 0, 0, len(optional), 0x22)
dos = b"MZ".ljust(0x3C, b"\0") + struct.pack("<I", 0x40)
head = (dos + b"PE\0\0" + coff + optional + table).ljust(headers, b"\0")
open(out, "wb").write(head + body)
PY
}

signed() {
  local out=$1
  shift
  pe "$out.unsigned" "$@"
  sbsign --key "$work/signer.key" --cert "$work/signer.pem" --output "$out" "$out.unsigned" >/dev/null 2>&1
}

signed "$work/uki.efi" .cmdline "$good" .profile 'ID=reset-maintenance' .cmdline "$good $wipe"
signed "$work/sd-boot.efi" .sdmagic 'sd-boot'

# image <name> [ukis] [meta magic]: a 48 MiB disk with a 32 MiB EFI system
# partition holding sd-boot and that many UKIs, and a 1 MiB META, compressed
# to <name>.raw.zst.
image() {
  local name=$1 ukis=${2:-1} magic=${3:-} disk="$work/$1.raw"
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
    printf '\x5a\x4b\x3c\x2d' | dd of="$disk" bs=512 seek=67584 conv=notrunc status=none
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
image baked-meta 1 yes
expect_fail baked-meta

echo "talos-metal-verify: all cases pass"
