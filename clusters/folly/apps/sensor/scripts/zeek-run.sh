#!/bin/bash
# Runs Zeek on the USB NIC. The image has net-tools, not iproute2.
set -eu
interface=$(/scripts/sensor-interface.sh)
ifconfig "$interface" up promisc
echo "sensor: zeek captures on $interface" >&2
# -C ignores checksums: a mirror port carries frames the sender offloaded.
exec zeek -C -i "$interface" local /scripts/sensor.zeek
