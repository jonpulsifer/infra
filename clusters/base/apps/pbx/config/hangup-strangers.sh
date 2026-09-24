#!/usr/bin/env bash
# The asterisk container's preStop: hang up every channel in the spam and troll
# groups, which hold strangers for up to ten minutes, so the drain that follows
# waits only on real calls. The pbx check runs it against a booted Asterisk.
set -uo pipefail

asterisk=${ASTERISK:-/bin/asterisk}
conf=${ASTERISK_CONF:-/etc/asterisk/asterisk.conf}

ast() { "$asterisk" -C "$conf" -rx "$1"; }

while read -r channel group _; do
  case $group in
    spam | troll) ast "channel request hangup $channel" ;;
  esac
done < <(ast 'group show channels')
exit 0
