#!/usr/bin/env python3
"""Generate OIDC discovery documents from SA token signer certificates.

Produces <out>/jwks.json and <out>/openid-configuration.json for one cluster
issuer. The JWKS kid matches kube-apiserver's derivation exactly —
base64url(SHA256(DER SPKI)) without padding (see k8s.io/kubernetes
pkg/serviceaccount keyIDFromPublicKey) — so tokens minted by the apiserver
resolve against these documents.

Zero non-stdlib dependencies: certificate parsing is delegated to openssl(1).

Usage: jwks_from_certs.py --issuer URL --out DIR cert.pem [older-cert.pem ...]
"""

import argparse
import base64
import hashlib
import json
import pathlib
import re
import subprocess
import sys


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def openssl(*args: str, stdin: bytes = b"") -> bytes:
    return subprocess.run(
        ["openssl", *args], input=stdin, check=True, capture_output=True
    ).stdout


def jwk_from_cert(cert_path: str) -> dict:
    pubkey_pem = openssl("x509", "-pubkey", "-noout", "-in", cert_path)

    # kid: SHA256 over the DER-encoded SubjectPublicKeyInfo.
    spki_der = openssl("pkey", "-pubin", "-outform", "DER", stdin=pubkey_pem)
    kid = b64url(hashlib.sha256(spki_der).digest())

    modulus_out = openssl("rsa", "-pubin", "-noout", "-modulus", stdin=pubkey_pem)
    modulus_hex = modulus_out.decode().strip().removeprefix("Modulus=")
    n = b64url(bytes.fromhex(modulus_hex))

    text_out = openssl("rsa", "-pubin", "-noout", "-text", stdin=pubkey_pem).decode()
    match = re.search(r"Exponent:\s+(\d+)", text_out)
    if not match:
        raise SystemExit(f"could not parse RSA exponent from {cert_path}")
    exponent = int(match.group(1))
    e = b64url(exponent.to_bytes((exponent.bit_length() + 7) // 8, "big"))

    return {"use": "sig", "kty": "RSA", "kid": kid, "alg": "RS256", "n": n, "e": e}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--issuer", required=True, help="issuer URL (no trailing slash)")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("certs", nargs="+", help="signer cert PEMs, newest first")
    args = parser.parse_args()

    issuer = args.issuer.rstrip("/")
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    jwks = {"keys": [jwk_from_cert(c) for c in args.certs]}
    discovery = {
        "issuer": issuer,
        "jwks_uri": f"{issuer}/openid/v1/jwks",
        "response_types_supported": ["id_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
    }

    (out / "jwks.json").write_text(json.dumps(jwks, indent=2) + "\n")
    (out / "openid-configuration.json").write_text(json.dumps(discovery, indent=2) + "\n")
    kids = ", ".join(k["kid"] for k in jwks["keys"])
    print(f"{out}: {len(jwks['keys'])} key(s) [{kids}] for {issuer}", file=sys.stderr)


if __name__ == "__main__":
    main()
