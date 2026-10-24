#!/usr/bin/env bash
# Checks that a UKI carries exactly one Authenticode signature, made by the key
# of the given certificate, over the UKI's own contents.
#
# usage: talos-uki-verify.sh <uki-signing-cert.pem> <uki.efi>
# Needs openssl, sbsigntool and osslsigncode. sbverify and osslsigncode alone
# reject the talosctl certificate, whose extended key usage lacks codeSigning;
# UEFI firmware ignores that usage, so the chain check here allows any purpose.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <uki-signing-cert.pem> <uki.efi>" >&2
  exit 64
fi
cert=$1 uki=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

signatures=$(sbverify --list "$uki" | grep -c '^signature ' || true)
if [[ "$signatures" != 1 ]]; then
  echo "$uki: want one signature, found $signatures" >&2
  exit 1
fi

# The signature over the signed content, by a key the certificate holds.
sbattach --detach "$work/sig.p7" "$uki" >/dev/null
openssl smime -verify -inform DER -in "$work/sig.p7" -binary -purpose any \
  -CAfile "$cert" -out "$work/content" 2>"$work/smime.log" || {
  cat "$work/smime.log" >&2
  echo "$uki: the signature does not verify against $cert" >&2
  exit 1
}

# The signed content names the image hash; it must be the hash of this file.
# osslsigncode exits non-zero on the certificate's key usage, so only its
# calculated digest is read.
calculated=$({ osslsigncode verify -in "$uki" -CAfile "$cert" 2>&1 || true; } \
  | sed -nE 's/^Calculated message digest *: *([0-9A-Fa-f]+).*/\1/p' | head -n1 | tr a-f A-F)
signed=$(od -An -tx1 -v "$work/content" | tr -d ' \n' | tr a-f A-F)
if [[ -z "$calculated" || "$signed" != *"$calculated"* ]]; then
  echo "$uki: the image hash ${calculated:-unknown} is not the signed one" >&2
  exit 1
fi

echo "$uki: signed by $(openssl x509 -in "$cert" -noout -subject), image hash $calculated"
