#!/usr/bin/env bash
# Checks the UKI inside a Talos installer image, the one an installed disk
# boots, with talos-uki-config-verify.sh: one signature that verifies against
# the given certificate, and a command line that fetches the config from
# exactly the given talos.config URL in both of imager's profiles.
#
# usage: talos-installer-verify.sh <signing-cert.pem> <installer.tar> <talos.config URL>
# The tarball is what imager writes or `crane pull` saves. Needs crane,
# objdump, openssl and sbsigntool.

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <signing-cert.pem> <installer.tar> <talos.config URL>" >&2
  exit 64
fi
cert=$1 installer=$2 url=$3
here=$(cd "$(dirname "$0")" && pwd)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
uki=usr/install/amd64/vmlinuz.efi
crane export - - <"$installer" | tar -xf - -C "$tmp" "$uki"
# imager writes the file with mode 0000.
chmod 0600 "$tmp/$uki"

bash "$here/talos-uki-config-verify.sh" "$cert" "$tmp/$uki" "$url" "$installer"
