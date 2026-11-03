#!/usr/bin/env bash
# Shared by the Talos UKI checks' tests, which source it: a failure helper, a
# throwaway code-signing certificate, and a PE32+ writer with ukify's layout
# of sections. Needs openssl and python3.

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# certificate <dir> <name> writes <dir>/<name>.key and <dir>/<name>.pem, a
# self-signed certificate with the codeSigning usage sbverify requires.
certificate() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$2" \
    -addext extendedKeyUsage=codeSigning \
    -keyout "$1/$2.key" -out "$1/$2.pem" 2>/dev/null
}

# pe <out> [<name> <contents>]... writes a PE32+ image with a .text section
# and the given sections in order, as ukify lays out a UKI with one extra
# profile.
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
