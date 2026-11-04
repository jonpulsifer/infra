#!/bin/bash
# Runs Suricata on the USB NIC with the ET Open rules, logging EVE JSON to
# stdout. The image's entrypoint runs first and fills /etc/suricata.
set -eu
# The local rules name the Funnel fetchers as an address group, filled from the env.
# Suricata drops a rule whose group does not parse, so a bad value stops here.
ipv4='[0-9]{1,3}(\.[0-9]{1,3}){3}'
if ! [[ ${FUNNEL_FETCHERS:-} =~ ^$ipv4(,$ipv4)*$ ]]; then
  echo "sensor: FUNNEL_FETCHERS is '${FUNNEL_FETCHERS:-}', not a comma-separated list of IPv4 addresses" >&2
  exit 1
fi
interface=$(/scripts/sensor-interface.sh)
ip link set dev "$interface" up promisc on
# A failed fetch keeps the rules on disk: the last run's, or none on a fresh pod.
# suricata-disable.conf drops the signatures that match this network's normal.
suricata-update --no-test --no-reload --disable-conf /scripts/suricata-disable.conf \
  || echo "sensor: suricata-update failed, starting with the rules on disk" >&2
echo "sensor: suricata captures on $interface" >&2
exec suricata -c /etc/suricata/suricata.yaml --af-packet="$interface" \
  --set outputs.0.fast.enabled=no \
  --set outputs.1.eve-log.filename=/dev/stdout \
  --set outputs.1.eve-log.community-id=yes \
  --set stats.interval=60 \
  --set unix-command.enabled=yes \
  --set "vars.address-groups.FUNNEL_FETCHERS=[${FUNNEL_FETCHERS}]" \
  -s /scripts/funnel-tripwires.rules
