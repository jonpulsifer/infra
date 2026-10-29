#!/usr/bin/env bash
# Checks the UKI inside a Talos installer image, the one an installed disk
# boots: it carries one signature that verifies against the given certificate,
# its command line fetches the config from exactly the given talos.config URL,
# and it carries no OAuth or halt_if_installed argument. The UKI holds one
# .cmdline per boot profile, and objcopy dumps the first, the default boot's.
#
# usage: talos-installer-verify.sh <signing-cert.pem> <installer.tar> <talos.config URL>
# The tarball is what imager writes or `crane pull` saves. Needs crane,
# objcopy, openssl and sbsigntool.

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

bash "$here/talos-uki-verify.sh" "$cert" "$tmp/$uki"

objcopy --dump-section .cmdline="$tmp/cmdline" "$tmp/$uki" "$tmp/discard"
cmdline=$(tr -d '\0' <"$tmp/cmdline")

configs=$(tr ' ' '\n' <<<"$cmdline" | grep -c '^talos\.config=' || true)
if [[ "$configs" != 1 || " $cmdline " != *" talos.config=$url "* ]]; then
  echo "$installer: the command line does not fetch its config from $url alone" >&2
  echo "  $cmdline" >&2
  exit 1
fi
for arg in talos.config.oauth. talos.halt_if_installed=; do
  if [[ " $cmdline " == *" $arg"* ]]; then
    echo "$installer: the command line carries $arg" >&2
    exit 1
  fi
done
echo "$installer: command line: $cmdline"
