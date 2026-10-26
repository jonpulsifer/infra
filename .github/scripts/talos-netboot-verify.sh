#!/usr/bin/env bash
# Checks folly's signed netboot images against the committed certificates:
# iPXE carries one signature by the Talos UKI key, HookOS one by the HookOS
# key, and neither verifies against the other's certificate, because PCR 7
# records which db certificate verified each boot. HookOS's command line must
# pin the agent image that netboot.json names and must name no worker.
#
# usage: talos-netboot-verify.sh <secureboot dir> <netboot.json> <dir with the images>
# Needs openssl, sbsigntool, objcopy and jq.

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <secureboot dir> <netboot.json> <dir with the images>" >&2
  exit 64
fi
certs=$1 pins=$2 dir=$3
here=$(cd "$(dirname "$0")" && pwd)
uki_cert=$certs/uki-signing-cert.pem
hookos_cert=$certs/hookos-signing-cert.pem
ipxe=$dir/ipxe-amd64-secureboot.efi
hookos=$dir/hookos-amd64-secureboot-uki.efi

bash "$here/talos-uki-verify.sh" "$uki_cert" "$ipxe"
bash "$here/talos-uki-verify.sh" "$hookos_cert" "$hookos"

if sbverify --cert "$hookos_cert" "$ipxe" >/dev/null 2>&1; then
  echo "$ipxe: verifies against the HookOS certificate; iPXE must be signed with the Talos UKI key" >&2
  exit 1
fi
if sbverify --cert "$uki_cert" "$hookos" >/dev/null 2>&1; then
  echo "$hookos: verifies against the Talos UKI certificate; HookOS must be signed with the HookOS key" >&2
  exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
objcopy -O binary --only-section=.cmdline "$hookos" "$tmp"
cmdline=$(tr -d '\0' <"$tmp")
agent=$(jq -r .tink_agent_image "$pins")
if [[ " $cmdline " != *" tink_worker_image=$agent "* ]]; then
  echo "$hookos: the command line does not pin $agent" >&2
  exit 1
fi
if [[ " $cmdline " == *" worker_id="* ]]; then
  echo "$hookos: the command line names a worker, so the UKI is not generic" >&2
  exit 1
fi
echo "$hookos: command line: $cmdline"
