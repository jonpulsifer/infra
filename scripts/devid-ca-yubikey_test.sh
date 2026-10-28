#!/usr/bin/env bash
# Tests the parts of devid-ca-yubikey.sh that need no YubiKey: the firmware policy, the ykman
# parsing, the generated secrets and the bundle.
set -euo pipefail

# shellcheck source=scripts/devid-ca-yubikey.sh
source "$(dirname "${BASH_SOURCE[0]}")/devid-ca-yubikey.sh"

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

allows() { firmware_allows "$1" "$2" || fail "$1 on $2 should be allowed"; }
refuses() { ! firmware_allows "$1" "$2" || fail "$1 on $2 should be refused"; }

allows RSA2048 4.3.7
allows RSA2048 4.3.5
refuses RSA2048 4.3.4
refuses RSA2048 4.2.6
allows RSA2048 5.1.2
refuses ECCP256 5.1.2
refuses ECCP256 5.6.9
allows ECCP256 5.7.0
refuses ECCP256 4.3.7
refuses RSA2048 unknown
refuses ED25519 5.7.4

info='Device type: YubiKey 5 NFC
Serial number: 12345678
Firmware version: 5.1.2
Enabled USB interfaces: OTP, FIDO, CCID'
[[ "$(info_field "Firmware version" <<<"$info")" == 5.1.2 ]] || fail "firmware version not parsed"
[[ "$(info_field "Device type" <<<"$info")" == "YubiKey 5 NFC" ]] || fail "device type not parsed"
[[ -z "$(info_field "Form factor" <<<"$info")" ]] || fail "an absent field should be empty"

[[ "$(slot_id 9c)" == 02 ]] || fail "slot 9c is CKA_ID 02"
[[ "$(slot_id 9a)" == 01 ]] || fail "slot 9a is CKA_ID 01"
! slot_id 82 >/dev/null || fail "slot 82 has no mapping here"

for _ in 1 2 3; do
  [[ "$(random_digits 8)" =~ ^[0-9]{8}$ ]] || fail "a PIN is eight digits"
  [[ "$(random_hex 24)" =~ ^[0-9a-f]{48}$ ]] || fail "a TDES management key is 48 hex digits"
done
[[ "$(random_digits 8)" != "$(random_digits 8)" ]] || fail "two PINs should differ"

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
pem() { printf -- '-----BEGIN CERTIFICATE-----\n%s\n-----END CERTIFICATE-----\n' "$1"; }
write_bundle "$dir" 2>/dev/null
[[ ! -e "$dir/folly-devid-ca.pem" ]] || fail "no DevID CA should write no bundle"
pem spore >"$dir/folly-devid-ca-spore.pem"
{
  echo "subject=CN=folly-devid-ca-capsule"
  pem capsule
} >"$dir/folly-devid-ca-capsule.pem"
pem Software >"$dir/folly-devid-ca-Software.pem"
pem root >"$dir/fml-root.pem"
pem spore-chain >"$dir/folly-devid-ca-spore-chain.pem"
write_bundle "$dir" 2>/dev/null
[[ "$(cat "$dir/folly-devid-ca.pem")" == "$(pem Software)"$'\n'"$(pem capsule)"$'\n'"$(pem spore)" ]] \
  || fail "the bundle should hold each DevID CA in byte order of file name, without chains or text around the PEM"
write_bundle "$dir" 2>/dev/null
(($(grep -c BEGIN "$dir/folly-devid-ca.pem") == 3)) || fail "the bundle must not include itself"
rm "$dir"/folly-devid-ca-*.pem
write_bundle "$dir" 2>/dev/null
[[ ! -e "$dir/folly-devid-ca.pem" ]] || fail "a bundle with no DevID CA left should be removed"

if ((failures > 0)); then
  echo "$failures failure(s)" >&2
  exit 1
fi
echo "ok"
