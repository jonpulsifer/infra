#!/usr/bin/env bash
# Checks that a UKI carries exactly one Authenticode signature, and that
# sbverify accepts it against the given certificate: the signature, the image
# hash it signs and the certificate itself. sbverify accepts only a certificate
# with the codeSigning extended key usage, so the check says so when the
# certificate lacks it.
#
# usage: talos-uki-verify.sh <uki-signing-cert.pem> <uki.efi>
# Needs openssl and sbsigntool.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <uki-signing-cert.pem> <uki.efi>" >&2
  exit 64
fi
cert=$1 uki=$2

openssl x509 -in "$cert" -noout -ext extendedKeyUsage 2>/dev/null | grep -q 'Code Signing' || {
  echo "$cert: the extended key usage lacks codeSigning, which sbverify needs" >&2
  exit 1
}

# A file may carry several signatures, and sbverify passes if any one of them
# verifies. The pipeline signs once.
signatures=$(sbverify --list "$uki" 2>/dev/null | grep -c '^signature ' || true)
if [[ "$signatures" != 1 ]]; then
  echo "$uki: want one signature, found $signatures" >&2
  exit 1
fi

sbverify --cert "$cert" "$uki" >/dev/null 2>&1 || {
  sbverify --cert "$cert" "$uki" 2>&1 | sed 's/^/  /' >&2 || true
  echo "$uki: the signature does not verify against $cert" >&2
  exit 1
}

echo "$uki: one signature, verified against $(openssl x509 -in "$cert" -noout -subject)"
