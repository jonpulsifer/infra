"""Write each X.509 certificate of an EFI signature database variable as a PEM file.

db-certs.py DUMP OUTDIR reads DUMP, the raw efivarfs file of a node's db
(/sys/firmware/efi/efivars/db-d719b2cb-3d3a-4596-a3bc-dad00e67656f): four bytes
of attributes, then EFI_SIGNATURE_LISTs. It writes OUTDIR/NN.pem for each
certificate and prints each one's index and DER SHA-256.
"""

import base64
import hashlib
import struct
import sys
import uuid
from pathlib import Path

X509 = uuid.UUID("a5c059a1-94e4-4aa7-87b5-ab155c2bf072")


def certs(data: bytes):
    off = 4
    while off < len(data):
        kind = uuid.UUID(bytes_le=data[off : off + 16])
        size, header, sig = struct.unpack_from("<III", data, off + 16)
        body = off + 28 + header
        end = off + size
        if kind == X509:
            while body < end:
                yield data[body + 16 : body + sig]
                body += sig
        off = end


def pem(der: bytes) -> str:
    b64 = base64.encodebytes(der).decode()
    return f"-----BEGIN CERTIFICATE-----\n{b64}-----END CERTIFICATE-----\n"


def main() -> int:
    dump, out = sys.argv[1:]
    Path(out).mkdir(parents=True, exist_ok=True)
    for i, der in enumerate(certs(Path(dump).read_bytes())):
        Path(out, f"{i:02d}.pem").write_text(pem(der))
        print(i, hashlib.sha256(der).hexdigest())
    return 0


if __name__ == "__main__":
    sys.exit(main())
