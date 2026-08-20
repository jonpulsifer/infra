#!/usr/bin/env python3
"""Assert that the committed FML PKI certificates form a chain that validates.

Every cert under terraform/pki/certs/ is public, so this needs no secrets and
runs in CI. It checks the properties a Go client never exercises — Go treats
each cert in a trust store as an anchor and stops there, so a hierarchy can be
internally contradictory and still serve kubectl, Flux and Prometheus for
years. OpenSSL clients build the full path and reject it.

Checked per chain (cluster CA -> intermediate -> root):

  linkage    each cert's issuer is the next cert's subject, root is self-signed
  basic      every CA carries basicConstraints CA:TRUE
  pathLen    each CA's pathLenConstraint admits the number of CAs beneath it
  validity   no CA expires before something it signed

Exit status is 0 when every chain holds, 1 otherwise.
"""

from __future__ import annotations

import base64
import datetime as dt
import pathlib
import ssl
import sys

CERTS = pathlib.Path(__file__).resolve().parents[2] / "terraform" / "pki" / "certs"

OID_BASIC_CONSTRAINTS = bytes([0x06, 0x03, 0x55, 0x1D, 0x13])


class Cert:
    def __init__(self, path: pathlib.Path):
        self.path = path
        self.name = path.name
        pem = path.read_text()
        blocks = pem.split("-----BEGIN CERTIFICATE-----")[1:]
        if not blocks:
            raise ValueError(f"{self.name}: no PEM certificate")
        if len(blocks) > 1:
            raise ValueError(f"{self.name}: expected one certificate, found {len(blocks)}")
        self.der = base64.b64decode("".join(blocks[0].split("-----END")[0].split()))

        decoded = ssl._ssl._test_decode_cert(str(path))
        self.subject = _rdn(decoded.get("subject"))
        self.issuer = _rdn(decoded.get("issuer"))
        self.not_after = dt.datetime.strptime(
            decoded["notAfter"], "%b %d %H:%M:%S %Y %Z"
        ).replace(tzinfo=dt.timezone.utc)
        self.is_ca, self.path_len = _basic_constraints(self.der)

    @property
    def self_signed(self) -> bool:
        return self.subject == self.issuer

    def __str__(self) -> str:
        plen = "unset" if self.path_len is None else str(self.path_len)
        return f"{self.name} (CA={self.is_ca}, pathLen={plen})"


def _rdn(name) -> str:
    return "/".join(v for rdn in (name or ()) for (_, v) in rdn)


def _basic_constraints(der: bytes) -> tuple[bool, int | None]:
    """Pull (cA, pathLenConstraint) out of the basicConstraints extension."""
    i = der.find(OID_BASIC_CONSTRAINTS)
    if i < 0:
        return False, None
    j = i + len(OID_BASIC_CONSTRAINTS)
    if der[j] == 0x01:  # optional critical BOOLEAN
        j += 3
    if der[j] != 0x04:  # extnValue OCTET STRING
        return False, None
    inner = der[j + 2 : j + 2 + der[j + 1]]
    body = inner[2:]  # unwrap the SEQUENCE
    is_ca, path_len, k = False, None, 0
    while k < len(body):
        tag, length = body[k], body[k + 1]
        value = body[k + 2 : k + 2 + length]
        if tag == 0x01:
            is_ca = value[0] != 0
        elif tag == 0x02:
            path_len = int.from_bytes(value, "big")
        k += 2 + length
    return is_ca, path_len


def check_chain(label: str, chain: list[Cert]) -> list[str]:
    """chain is ordered leaf-most CA first, root last."""
    problems: list[str] = []

    for lower, upper in zip(chain, chain[1:]):
        if lower.issuer != upper.subject:
            problems.append(
                f"{label}: {lower.name} is issued by {lower.issuer!r}, "
                f"but {upper.name} is {upper.subject!r}"
            )
    if not chain[-1].self_signed:
        problems.append(
            f"{label}: {chain[-1].name} terminates the chain but is not self-signed "
            f"(issuer {chain[-1].issuer!r}) — OpenSSL cannot anchor here"
        )

    for cert in chain:
        if not cert.is_ca:
            problems.append(f"{label}: {cert.name} is in the CA chain without basicConstraints CA:TRUE")

    # pathLenConstraint caps the CAs that may follow a cert, excluding the leaf.
    # chain[0] is the issuing CA for end-entity certs, so nothing follows it.
    for depth, cert in enumerate(chain):
        if cert.path_len is None:
            continue
        if cert.path_len < depth:
            below = ", ".join(c.name for c in chain[:depth]) or "none"
            problems.append(
                f"{label}: {cert.name} carries pathLen={cert.path_len} but signs {depth} "
                f"CA(s) beneath it ({below}) — needs pathLen >= {depth}"
            )

    for lower, upper in zip(chain, chain[1:]):
        if upper.not_after < lower.not_after:
            problems.append(
                f"{label}: {upper.name} expires {upper.not_after:%Y-%m-%d}, before "
                f"{lower.name} which it signed ({lower.not_after:%Y-%m-%d})"
            )

    return problems


def main() -> int:
    if not CERTS.is_dir():
        print(f"no certs directory at {CERTS}", file=sys.stderr)
        return 1

    try:
        root = Cert(CERTS / "fml-root.pem")
        intermediate = Cert(CERTS / "fml-intermediate.pem")
    except (OSError, ValueError) as exc:
        print(f"cannot load trust anchors: {exc}", file=sys.stderr)
        return 1

    cluster_cas = sorted(
        p for p in CERTS.glob("*-ca.pem") if not p.name.startswith("fml-")
    )
    if not cluster_cas:
        print(f"no cluster CA certificates in {CERTS}", file=sys.stderr)
        return 1

    problems: list[str] = []
    for path in cluster_cas:
        cluster = path.name.removesuffix("-ca.pem")
        try:
            cluster_ca = Cert(path)
        except (OSError, ValueError) as exc:
            problems.append(f"{cluster}: {exc}")
            continue
        print(f"==> {cluster}")
        chain = [cluster_ca, intermediate, root]
        for cert in chain:
            print(f"      {cert}")
        problems += check_chain(cluster, chain)

    if problems:
        print("\nchain does not validate:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(
            "\nGo clients accept this because they anchor on the published cert and "
            "never walk up.\nOpenSSL clients build the full path and refuse it.",
            file=sys.stderr,
        )
        return 1

    print("\nok — every chain links, anchors on a self-signed root, and its "
          "pathLen and validity admit the CAs beneath it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
