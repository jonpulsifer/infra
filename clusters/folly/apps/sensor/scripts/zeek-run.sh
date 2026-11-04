#!/bin/bash
# Runs Zeek on the USB NIC. The image has net-tools, not iproute2.
set -eu
# funnel-tripwires.zeek skips an address that does not parse, so a bad value stops here.
ipv4='[0-9]{1,3}(\.[0-9]{1,3}){3}'
if ! [[ ${FUNNEL_FETCHERS:-} =~ ^$ipv4(,$ipv4)*$ && ${SPORE_IP:-} =~ ^$ipv4$ ]]; then
  echo "sensor: FUNNEL_FETCHERS '${FUNNEL_FETCHERS:-}' or SPORE_IP '${SPORE_IP:-}' is not IPv4" >&2
  exit 1
fi
interface=$(/scripts/sensor-interface.sh)
ifconfig "$interface" up promisc
echo "sensor: zeek captures on $interface" >&2
# -C ignores checksums: a mirror port carries frames the sender offloaded.
exec zeek -C -i "$interface" local /scripts/sensor.zeek /scripts/funnel-tripwires.zeek
