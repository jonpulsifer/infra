#!/bin/bash
# Runs Suricata on the USB NIC with the ET Open rules, logging EVE JSON to
# stdout. The image's entrypoint runs first and fills /etc/suricata.
set -eu
interface=$(/scripts/sensor-interface.sh)
ip link set dev "$interface" up promisc on
# A failed fetch keeps the rules on disk: the last run's, or none on a fresh pod.
suricata-update --no-test --no-reload \
  || echo "sensor: suricata-update failed, starting with the rules on disk" >&2
echo "sensor: suricata captures on $interface" >&2
exec suricata -c /etc/suricata/suricata.yaml --af-packet="$interface" \
  --set outputs.0.fast.enabled=no \
  --set outputs.1.eve-log.filename=/dev/stdout \
  --set outputs.1.eve-log.community-id=yes \
  --set stats.interval=60 \
  --set unix-command.enabled=yes
