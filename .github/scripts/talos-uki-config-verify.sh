#!/usr/bin/env bash
# Checks a Talos UKI that an installed disk boots: it carries one signature
# that verifies against the given certificate, and its default profile's
# command line fetches the config from exactly the given talos.config URL,
# with no OAuth, early, inline or halt_if_installed argument. imager gives the
# UKI one more profile, sd-boot's "Reset to maintenance mode", whose command
# line must be the default's plus the wipe, so it carries the same URL and
# nothing else. The installer's check and the metal image's check share it.
#
# usage: talos-uki-config-verify.sh <signing-cert.pem> <uki.efi> <talos.config URL> <name>
# name labels the messages. Needs objdump, openssl and sbsigntool.

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <signing-cert.pem> <uki.efi> <talos.config URL> <name>" >&2
  exit 64
fi
cert=$1 uki=$2 url=$3 name=$4
here=$(cd "$(dirname "$0")" && pwd)
wipe=talos.experimental.wipe=system:EPHEMERAL,STATE

bash "$here/talos-uki-verify.sh" "$cert" "$uki"

# Each profile has its own .cmdline section, megabytes apart, so each is read
# at its own file offset.
mapfile -t sections < <(objdump -h "$uki" | awk '$2 == ".cmdline" { print $3, $6 }')
if [[ ${#sections[@]} -ne 2 ]]; then
  echo "$name: want two .cmdline sections, the default and reset-maintenance profiles, found ${#sections[@]}" >&2
  exit 1
fi
section() {
  local size offset
  read -r size offset <<<"${sections[$1]}"
  dd if="$uki" bs=1 skip=$((16#$offset)) count=$((16#$size)) status=none | tr -d '\0'
}
cmdline=$(section 0)
reset=$(section 1)

configs=$(tr ' ' '\n' <<<"$cmdline" | grep -c '^talos\.config=' || true)
if [[ "$configs" != 1 || " $cmdline " != *" talos.config=$url "* ]]; then
  echo "$name: the command line does not fetch its config from $url alone" >&2
  echo "  $cmdline" >&2
  exit 1
fi
for arg in talos.config.oauth. talos.config.early= talos.config.inline= talos.halt_if_installed=; do
  if [[ " $cmdline " == *" $arg"* ]]; then
    echo "$name: the command line carries $arg" >&2
    exit 1
  fi
done
if [[ "$reset" != "$cmdline $wipe" ]]; then
  echo "$name: the reset-maintenance command line is not the default's plus $wipe" >&2
  echo "  $reset" >&2
  exit 1
fi
echo "$name: command line: $cmdline"
echo "$name: reset-maintenance command line: $reset"
