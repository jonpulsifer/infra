#!/usr/bin/env bash
# Tests talos-installer-verify.sh against stand-in installers: each holds a
# small PE32+ with imager's UKI layout of .cmdline sections, signed with a
# throwaway code-signing certificate. Needs crane, objdump, openssl, python3
# and sbsigntool.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/talos-installer-verify.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Talos fills in the placeholders, so they stay literal.
# shellcheck disable=SC2016
url='https://enroll.lolwtf.ca/talos/config?uuid=${uuid}&code=${code}'
base='talos.platform=metal console=tty0 slab_nomerge pti=on consoleblank=0 printk.devkmsg=on selinux=1 module.sig_enforce=1 proc_mem.force_override=never'
wipe=talos.experimental.wipe=system:EPHEMERAL,STATE

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

for name in signer other; do
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$name" \
    -addext extendedKeyUsage=codeSigning \
    -keyout "$work/$name.key" -out "$work/$name.pem" 2>/dev/null
done

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

# Builds the installer tarball <name>.tar from a UKI with the given sections,
# signed by the signer.
installer() {
  local name=$1 dir="$work/$1"
  shift
  mkdir -p "$dir/usr/install/amd64"
  pe "$dir/unsigned.efi" "$@"
  sbsign --key "$work/signer.key" --cert "$work/signer.pem" \
    --output "$dir/usr/install/amd64/vmlinuz.efi" "$dir/unsigned.efi" >/dev/null 2>&1
  tar -C "$dir" -cf "$dir/layer.tar" usr
  crane append -f "$dir/layer.tar" -t "example.invalid/installer:$name" -o "$work/$name.tar" 2>/dev/null
}

expect_pass() {
  local name=$1 cert=${2:-signer}
  bash "$script" "$work/$cert.pem" "$work/$name.tar" "$url" >/dev/null 2>&1 || fail "$name: want a pass"
}

expect_fail() {
  local name=$1 cert=${2:-signer}
  if bash "$script" "$work/$cert.pem" "$work/$name.tar" "$url" >/dev/null 2>&1; then
    fail "$name: want a failure"
  fi
}

# profiles <name> <default command line> [reset command line]
profiles() {
  local name=$1 default=$2 reset=${3-"$2 $wipe"}
  installer "$name" .cmdline "$default" .profile 'ID=reset-maintenance' .cmdline "$reset"
}

good="$base talos.config=$url"
profiles good "$good"
expect_pass good
expect_fail good other

profiles oauth "$good talos.config.oauth.client_id=talos-enroll"
expect_fail oauth
profiles halt "$good talos.halt_if_installed=1"
expect_fail halt
profiles early "$good talos.config.early=https://example.invalid/early"
expect_fail early
profiles inline "$good talos.config.inline=Zm9v"
expect_fail inline
profiles twice "$good talos.config=https://example.invalid/other"
expect_fail twice
profiles old "$base talos.config=https://enroll.lolwtf.ca/config?uuid=\${uuid}&mac=\${mac}&serial=\${serial}"
expect_fail old
profiles none "$base"
expect_fail none

profiles reset-oauth "$good" "$good talos.config.oauth.client_id=talos-enroll $wipe"
expect_fail reset-oauth
profiles reset-nowipe "$good" "$good"
expect_fail reset-nowipe
installer one-profile .cmdline "$good"
expect_fail one-profile

echo "talos-installer-verify: all cases pass"
