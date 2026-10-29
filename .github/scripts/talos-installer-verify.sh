#!/usr/bin/env bash
# Checks the UKI inside a Talos installer image, the one an installed disk
# boots: it carries one signature that verifies against the given certificate,
# and its default profile's command line fetches the config from exactly the
# given talos.config URL, with no OAuth, early, inline or halt_if_installed
# argument. imager gives the installer's UKI one more profile, sd-boot's
# "Reset to maintenance mode", whose command line must be the default's plus
# the wipe, so it carries the same URL and nothing else.
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
wipe=talos.experimental.wipe=system:EPHEMERAL,STATE

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
uki=usr/install/amd64/vmlinuz.efi
crane export - - <"$installer" | tar -xf - -C "$tmp" "$uki"
# imager writes the file with mode 0000.
chmod 0600 "$tmp/$uki"

bash "$here/talos-uki-verify.sh" "$cert" "$tmp/$uki"

# Each profile has its own .cmdline section, megabytes apart, so each is read
# at its own file offset.
mapfile -t sections < <(objdump -h "$tmp/$uki" | awk '$2 == ".cmdline" { print $3, $6 }')
if [[ ${#sections[@]} -ne 2 ]]; then
  echo "$installer: want two .cmdline sections, the default and reset-maintenance profiles, found ${#sections[@]}" >&2
  exit 1
fi
section() {
  local size offset
  read -r size offset <<<"${sections[$1]}"
  dd if="$tmp/$uki" bs=1 skip=$((16#$offset)) count=$((16#$size)) status=none | tr -d '\0'
}
cmdline=$(section 0)
reset=$(section 1)

configs=$(tr ' ' '\n' <<<"$cmdline" | grep -c '^talos\.config=' || true)
if [[ "$configs" != 1 || " $cmdline " != *" talos.config=$url "* ]]; then
  echo "$installer: the command line does not fetch its config from $url alone" >&2
  echo "  $cmdline" >&2
  exit 1
fi
for arg in talos.config.oauth. talos.config.early= talos.config.inline= talos.halt_if_installed=; do
  if [[ " $cmdline " == *" $arg"* ]]; then
    echo "$installer: the command line carries $arg" >&2
    exit 1
  fi
done
if [[ "$reset" != "$cmdline $wipe" ]]; then
  echo "$installer: the reset-maintenance command line is not the default's plus $wipe" >&2
  echo "  $reset" >&2
  exit 1
fi
echo "$installer: command line: $cmdline"
echo "$installer: reset-maintenance command line: $reset"
