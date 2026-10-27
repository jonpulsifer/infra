#!/usr/bin/env bash
# Prints the iPXE script that boots the signed Talos UKI beside it with the
# UKI's own command line. Under Secure Boot systemd-stub keeps the signed
# command line; without it the stub takes iPXE's arguments, so the script
# passes the same one. iPXE fills in ${uuid}, ${mac} and ${serial}.
#
# usage: talos-uki-ipxe.sh <file with the UKI's .cmdline>

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <file with the UKI's .cmdline>" >&2
  exit 64
fi

cmdline=$(tr -d '\0\n' <"$1")
[[ -n "$cmdline" ]] || {
  echo "$1: empty command line" >&2
  exit 1
}

# imgfree drops this script: iPXE serves the initrd of any other loaded image
# to systemd-stub, which then refuses its own.
printf '#!ipxe\nimgfree\nchain --autofree metal-amd64-secureboot-uki.efi %s\n' "$cmdline"
