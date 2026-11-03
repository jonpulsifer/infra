#!/usr/bin/env bash
# Checks folly's signed netboot images against the committed certificates:
# iPXE carries one signature by the Talos UKI key, HookOS and fleet-boot one
# each by the HookOS key, and none verifies against the other's certificate,
# because PCR 7 records which db certificate verified each boot. HookOS's
# command line must pin the agent image that netboot.json names, fleet-boot's
# must boot its own target, and neither may name a worker.
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
fleetboot=$dir/fleet-boot-amd64-secureboot-uki.efi

bash "$here/talos-uki-verify.sh" "$uki_cert" "$ipxe"
bash "$here/talos-uki-verify.sh" "$hookos_cert" "$hookos"
bash "$here/talos-uki-verify.sh" "$hookos_cert" "$fleetboot"

if sbverify --cert "$hookos_cert" "$ipxe" >/dev/null 2>&1; then
  echo "$ipxe: verifies against the HookOS certificate; iPXE must be signed with the Talos UKI key" >&2
  exit 1
fi
for image in "$hookos" "$fleetboot"; do
  if sbverify --cert "$uki_cert" "$image" >/dev/null 2>&1; then
    echo "$image: verifies against the Talos UKI certificate; it must be signed with the HookOS key" >&2
    exit 1
  fi
done

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
# cmdline_of prints the command line a UKI signs.
cmdline_of() {
  objcopy -O binary --only-section=.cmdline "$1" "$tmp"
  tr -d '\0' <"$tmp"
}

cmdline=$(cmdline_of "$hookos")
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

boot=$(cmdline_of "$fleetboot")
if [[ " $boot " != *" rd.systemd.unit=fleet-boot.target "* ]]; then
  echo "$fleetboot: the command line does not boot fleet-boot.target" >&2
  exit 1
fi
for key in fleet_attest_url fleet_ntp_server syslog_host; do
  want=$(tr ' ' '\n' <<<"$cmdline" | grep "^$key=" || true)
  if [[ -z "$want" || " $boot " != *" $want "* ]]; then
    echo "$fleetboot: the command line's $key differs from HookOS's" >&2
    exit 1
  fi
done
if [[ " $boot " == *" worker_id="* ]]; then
  echo "$fleetboot: the command line names a worker, so the UKI is not generic" >&2
  exit 1
fi
echo "$fleetboot: command line: $boot"
echo "$fleetboot: $(stat -c %s "$fleetboot") bytes"
