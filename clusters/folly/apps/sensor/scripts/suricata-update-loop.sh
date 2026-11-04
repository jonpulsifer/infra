#!/bin/bash
# Refreshes the ET Open rules each day and tells the running Suricata, over its
# command socket, to reload them. suricata-run.sh fetched the first set.
while :; do
  sleep 86400
  if suricata-update --no-test --no-reload --disable-conf /scripts/suricata-disable.conf; then
    suricatasc -c reload-rules /var/run/suricata/suricata-command.socket \
      || echo "sensor: rule reload failed" >&2
  else
    echo "sensor: rule update failed, Suricata keeps the loaded rules" >&2
  fi
done
