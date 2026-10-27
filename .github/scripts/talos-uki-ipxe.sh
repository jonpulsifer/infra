#!/usr/bin/env bash
# Prints the iPXE menu that boots the signed Talos UKI beside it with the
# UKI's own command line, after a timeout. Under Secure Boot systemd-stub keeps
# the signed command line; without it the stub takes iPXE's arguments, so the
# script passes the same one. iPXE fills in ${uuid}, ${mac} and ${serial}. The
# enroll item sanboots the signed ISO, whose systemd-boot enrolls the lab's
# Secure Boot keys on firmware in Setup Mode; ${boot-url} comes from the
# embedded script, because sanboot takes no relative URL.
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
cat <<EOF
#!ipxe
menu folly netboot
item install Install Talos and enroll this machine
item enroll Enroll the lab's Secure Boot keys (firmware in Setup Mode)
item exit Back to the firmware
choose --timeout 10000 --default install target || goto install
goto \${target}
:enroll
sanboot --no-describe \${boot-url}/metal-amd64-secureboot.iso || goto failed
:exit
exit 1
:failed
echo folly netboot menu failed (\${errno}), back to the firmware
exit 1
:install
imgfree
chain --autofree metal-amd64-secureboot-uki.efi $cmdline
EOF
