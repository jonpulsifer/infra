#!/usr/bin/env bash
# Read-only forensics for a bad-internet day at folly: the Starlink dish's own
# event log, the gateway's WAN monitor, and one client's 5-minute Wi-Fi series.
# Prints compact tables in the lab's time zone. `data` and `site` write the
# series the net.kthx.dev page renders.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
UNIFI="${UNIFI_SH:-$HERE/../unifi-network/unifi.sh}"
HOST="${UNIFI_HOST:-https://unifi.fml.pulsifer.ca}"
SITE="${UNIFI_SITE:-default}"
DISH="${STARLINK_DISH:-192.168.100.1:9200}"
LAB_TZ="${LAB_TZ:-America/Halifax}"
JAR="${TMPDIR:-/tmp}/.unifi-cookies-$(id -u)"
CSRF_FILE="${TMPDIR:-/tmp}/.unifi-csrf-$(id -u)"
WORK="${TMPDIR:-/tmp}/.net-health-$(id -u)"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need curl; need jq; need column
[[ -x "$UNIFI" ]] || die "unifi.sh not found at $UNIFI"
mkdir -p "$WORK"; chmod 700 "$WORK"

# The day under study, in the lab's zone. NET_DAY=yesterday or NET_DAY=2026-10-12 move it.
DAY=$(TZ="$LAB_TZ" date -d "${NET_DAY:-today}" +%Y-%m-%d)
DAY_START=$(TZ="$LAB_TZ" date -d "$DAY 00:00" +%s)
DAY_END=$((DAY_START + 86400))
NOW=$(date +%s)
(( DAY_END > NOW )) && DAY_END=$NOW
TZ_OFF=$(TZ="$LAB_TZ" date -d "$DAY 12:00" +%z | awk '{s=substr($1,1,1)=="-"?-1:1; print s*(substr($1,2,2)*3600+substr($1,4,2)*60)}')

hhmm() { TZ="$LAB_TZ" date -d "@$1" +%H:%M; }

login() { "$UNIFI" sysinfo >/dev/null; }
get() { "$UNIFI" raw "$1"; }
post() {
  login
  curl -sk -b "$JAR" -H "x-csrf-token: $(cat "$CSRF_FILE")" -H 'Content-Type: application/json' \
    -H 'Accept: application/json' -X POST "$HOST/proxy/network/api$1" -d "$2"
}
# report <5minutes.user|5minutes.ap|5minutes.gw> <attrs json array> [macs json array]
report() {
  local body="{\"attrs\":$2,\"start\":$((DAY_START * 1000)),\"end\":$((DAY_END * 1000))"
  [[ -n "${3:-}" ]] && body+=",\"macs\":$3"
  post "/s/$SITE/stat/report/$1" "$body}"
}
# The controller's system log, the only place UniFi Network 10 keeps client events.
syslog() {
  login
  curl -sk -b "$JAR" -H "x-csrf-token: $(cat "$CSRF_FILE")" -H 'Content-Type: application/json' \
    -X POST "$HOST/proxy/network/v2/api/site/$SITE/system-log/all" \
    -d "{\"pageNumber\":0,\"pageSize\":3000,\"timestampFrom\":$((DAY_START * 1000)),\"timestampTo\":$((DAY_END * 1000))}"
}

grpc() {
  if command -v grpcurl >/dev/null 2>&1; then
    grpcurl -plaintext -max-time 60 -d "$1" "$DISH" SpaceX.API.Device.Device/Handle
  elif command -v nix-shell >/dev/null 2>&1; then
    nix-shell -p grpcurl --run "grpcurl -plaintext -max-time 60 -d '$1' $DISH SpaceX.API.Device.Device/Handle" 2>/dev/null
  else
    die "need grpcurl (mise install) or nix-shell"
  fi
}
dish_history() {
  [[ -s "$WORK/dish-history.json" && $(( NOW - $(stat -c %Y "$WORK/dish-history.json") )) -lt 120 ]] \
    || grpc '{"get_history":{}}' > "$WORK/dish-history.json"
  cat "$WORK/dish-history.json"
}
# Events as TSV: epoch, seconds, reason, severity. The eventLog timestamps are
# epoch nanoseconds; the dish's `outages` array is on another timebase.
dish_events_tsv() {
  dish_history | jq -r '.dishGetHistory.eventLog.events[]
    | [((.startTimestampNs|tonumber)/1e9|floor), (((.durationNs // "0")|tonumber)/1e9*10|round/10),
       (.reason|sub("EVENT_REASON_";"")), (.severity|sub("EVENT_SEVERITY_";""))] | @tsv'
}
# WAN monitor lines from the gateway journal, as TSV: epoch, message.
wan_monitor_tsv() {
  local since; since=$(date -u -d "@$DAY_START" '+%Y-%m-%d %H:%M')
  "$UNIFI" ssh "journalctl --since '$since' --no-pager 2>/dev/null | grep -E 'wan-failover-monitor|wan-failover-interfaces' | grep -v 'loss=0/'" \
    | sed -E 's/^([A-Z][a-z]{2} +[0-9]+ [0-9:]+) \S+ \S+: (.*)$/\1\t\2/' \
    | while IFS=$'\t' read -r stamp msg; do
        [[ -n "$stamp" ]] || continue
        printf '%s\t%s\n' "$(date -u -d "$stamp" +%s)" "${msg:0:160}"
      done
}
# Resolve a client by name, IP or MAC; prints its stat/sta record or alluser record.
find_client() {
  local q="$1" rec
  rec=$(get "/s/$SITE/stat/sta" | jq -c --arg q "$q" 'first(.data[] | select((.hostname//"")+(.name//"")+(.ip//"")+(.mac//"") | ascii_downcase | contains($q|ascii_downcase))) // empty')
  [[ -n "$rec" ]] || rec=$(get "/s/$SITE/stat/alluser?within=72" | jq -c --arg q "$q" '[.data[] | select((.hostname//"")+(.name//"")+(.last_ip//"")+(.mac//"") | ascii_downcase | contains($q|ascii_downcase))] | sort_by(.last_seen) | last // empty')
  [[ -n "$rec" ]] || die "no client matches '$q'"
  printf '%s' "$rec"
}

cmd_dish() {
  local days="${1:-7}"
  echo "## Starlink dish"
  grpc '{"get_status":{}}' | jq -r --arg tz "$LAB_TZ" '.dishGetStatus | "uptime \((.deviceState.uptimeS|tonumber)/3600|floor)h  latency \(.popPingLatencyMs|round)ms  obstructed \((.obstructionStats.timeObstructed // 0)*100|.*100|round/100)%  down \((.downlinkThroughputBps // 0)/1e6*10|round/10)Mbps up \((.uplinkThroughputBps // 0)/1e6*10|round/10)Mbps  firmware \(.deviceInfo.softwareVersion)"'
  echo "## outage events per day ($LAB_TZ)"
  dish_events_tsv | awk -F'\t' -v off="$TZ_OFF" '{ cmd="date -u -d @" ($1+off) " +%Y-%m-%d"; cmd | getline d; close(cmd); n[d]++; s[d]+=$2; if ($3 ~ /PACKET_LOSS/) p[d]++ }
    END { for (d in n) printf "%s\t%d\t%.1fs\t%d loss runs\n", d, n[d], s[d], p[d]+0 }' | sort | tail -n "$days" | column -t -s$'\t'
  local min=2; [[ "${2:-}" == all ]] && min=0
  echo "## events on $DAY lasting ${min}s or more (dish 7 all lists every one)"
  dish_events_tsv | awk -F'\t' -v a="$DAY_START" -v b="$DAY_END" -v m="$min" '$1>=a && $1<b && $2>=m' | while IFS=$'\t' read -r ts dur reason sev; do
    printf '%s\t%6ss\t%s\t%s\n' "$(hhmm "$ts")" "$dur" "$reason" "$sev"
  done | column -t -s$'\t'
  (( min > 0 )) && dish_events_tsv | awk -F'\t' -v a="$DAY_START" -v b="$DAY_END" -v m="$min" '$1>=a && $1<b && $2<m {n++; s+=$2; if (!f) f=$1; l=$1}
    END { if (n) printf "%d\t%.1f\t%d\t%d\n", n, s, f, l }' | while IFS=$'\t' read -r n s f l; do
      echo "plus $n drops under ${min}s ($s s in all) between $(hhmm "$f") and $(hhmm "$l")"
    done
  return 0
}

cmd_wan() {
  echo "## WAN health (24h, gateway monitors)"
  get "/s/$SITE/stat/health" | jq -r '.data[] | select(.subsystem=="wan") | "isp \(.isp_name // "-")  availability \(.uptime_stats.WAN.availability // 0 | .*100|round/100)%  latency \(.uptime_stats.WAN.latency_average // "-")ms  gateway uptime \((.["gw_system-stats"].uptime // 0 | tonumber)/3600|floor)h"'
  echo "## WAN monitor on $DAY ($LAB_TZ)"
  wan_monitor_tsv | while IFS=$'\t' read -r ts msg; do printf '%s  %s\n' "$(hhmm "$ts")" "$msg"; done
  echo "## WAN traffic per hour on $DAY (MB down / up)"
  report 5minutes.gw '["time","wan-rx_bytes","wan-tx_bytes"]' \
    | jq -r --argjson off "$TZ_OFF" '.data[] | [((.time/1000 + $off)|strftime("%H")), ((."wan-rx_bytes" // 0)/1e6), ((."wan-tx_bytes" // 0)/1e6)] | @tsv' \
    | awk -F'\t' '{d[$1]+=$2; u[$1]+=$3} END {for (h in d) printf "%s:00\t%.0f\t%.0f\n", h, d[h], u[h]}' | sort | column -t -s$'\t'
}

cmd_client() {
  local rec mac name
  rec=$(find_client "${1:?usage: client <name|ip|mac>}")
  mac=$(jq -r .mac <<<"$rec"); name=$(jq -r '.hostname // .name // .mac' <<<"$rec")
  echo "## $name ($mac)"
  jq -r '"now: \(if .is_wired then "wired" else "wifi \(.essid // "-") on \(.last_uplink_name // .ap_name // "-") \(.radio // "-") ch\(.channel // "-") \(.signal // "-")dBm sat \(.satisfaction // "-")" end)  ip \(.ip // .last_ip // "-")  last seen \(.last_seen // 0 | todate)"' <<<"$rec"
  echo "## hourly on $DAY: signal dBm / min satisfaction / retry% / MB up / MB down"
  report 5minutes.user '["time","signal","satisfaction","tx_retries","wifi_tx_attempts","rx_bytes","tx_bytes"]' "[\"$mac\"]" \
    | jq -r --argjson off "$TZ_OFF" '.data[] | [((.time/1000 + $off)|strftime("%H")), (.signal // 0), (.satisfaction // 0), (.tx_retries // 0), (.wifi_tx_attempts // 0), ((.rx_bytes // 0)/1e6), ((.tx_bytes // 0)/1e6)] | @tsv' \
    | awk -F'\t' '{h=$1; n[h]++; s[h]+=$2; if (!(h in m) || $3<m[h]) m[h]=$3; r[h]+=$4; a[h]+=$5; up[h]+=$6; dn[h]+=$7}
      END {for (h in n) printf "%s:00\t%.0f\t%.0f\t%.0f%%\t%.0f\t%.0f\n", h, s[h]/n[h], m[h], (a[h]>0?r[h]*100/a[h]:0), up[h], dn[h]}' | sort | column -t -s$'\t'
  echo "## events on $DAY"
  syslog | jq -r --arg mac "$mac" --argjson off "$TZ_OFF" '.data[] | select(.parameters.CLIENT.id == $mac)
    | [((.timestamp/1000 + $off)|strftime("%H:%M")), (.key|sub("CLIENT_";"")|sub("_2$";"")),
       (.parameters.DEVICE.name // ((.parameters.DEVICE_FROM.name // "") + " > " + (.parameters.DEVICE_TO.name // ""))),
       ((.parameters.SIGNAL_STRENGTH.name // "") + "dBm"), (.parameters.DURATION.name // "")] | @tsv' | column -t -s$'\t'
}

# data <client> <dir>: write <dir>/data.js for the site.
cmd_data() {
  local rec mac name out="${2:?usage: data <client> <dir>}"
  rec=$(find_client "${1:?usage: data <client> <dir>}")
  mac=$(jq -r .mac <<<"$rec"); name=$(jq -r '.hostname // .name // .mac' <<<"$rec")
  mkdir -p "$out"
  local client wifi wan dish days monitor health events
  client=$(jq -c '{name: (.hostname // .name // .mac), mac, ip: (.ip // .last_ip), ap: (.last_uplink_name // .ap_name), radio, channel, signal, satisfaction}' <<<"$rec")
  wifi=$(report 5minutes.user '["time","signal","satisfaction","tx_retries","wifi_tx_attempts","rx_bytes","tx_bytes"]' "[\"$mac\"]" \
    | jq -c --argjson off "$TZ_OFF" '[.data[] | {t: ((.time/1000 + $off)|strftime("%H:%M")), sig: ((.signal // 0)*10|round/10), sat: ((.satisfaction // 0)|round),
        retry: (if (.wifi_tx_attempts // 0) > 0 then ((.tx_retries // 0)*100/(.wifi_tx_attempts)*10|round/10) else 0 end),
        up: (((.rx_bytes // 0)*8/300/1e6)*100|round/100), down: (((.tx_bytes // 0)*8/300/1e6)*100|round/100)}]')
  wan=$(report 5minutes.gw '["time","wan-rx_bytes","wan-tx_bytes"]' \
    | jq -c --argjson off "$TZ_OFF" '[.data[] | {t: ((.time/1000 + $off)|strftime("%H:%M")), up: (((."wan-tx_bytes" // 0)*8/300/1e6)*100|round/100), down: (((."wan-rx_bytes" // 0)*8/300/1e6)*100|round/100)}]')
  dish=$(dish_events_tsv | awk -F'\t' -v a="$DAY_START" -v b="$DAY_END" '$1>=a && $1<b' | jq -R -s -c --argjson off "$TZ_OFF" 'split("\n") | map(select(length>0) | split("\t") | {t: ((.[0]|tonumber) + $off | strftime("%H:%M")), dur: (.[1]|tonumber), reason: .[2], sev: .[3]})')
  days=$(dish_events_tsv | jq -R -s -c --argjson off "$TZ_OFF" 'split("\n") | map(select(length>0) | split("\t") | {d: ((.[0]|tonumber) + $off | strftime("%Y-%m-%d")), dur: (.[1]|tonumber), loss: (.[2]|test("PACKET_LOSS"))})
    | group_by(.d) | map({d: .[0].d, n: length, s: (map(.dur)|add*10|round/10), loss: (map(select(.loss))|length)}) | .[-7:]')
  monitor=$(wan_monitor_tsv | jq -R -s -c --argjson off "$TZ_OFF" 'split("\n") | map(select(length>0) | split("\t") | {t: ((.[0]|tonumber) + $off | strftime("%H:%M")), msg: .[1]})')
  health=$(get "/s/$SITE/stat/health" | jq -c '.data[] | select(.subsystem=="wan") | {isp: (.isp_name // null), availability: (.uptime_stats.WAN.availability // null), latency: (.uptime_stats.WAN.latency_average // null)}')
  events=$(syslog | jq -c --arg mac "$mac" --argjson off "$TZ_OFF" '[.data[] | select(.parameters.CLIENT.id == $mac)
    | {t: ((.timestamp/1000 + $off)|strftime("%H:%M")), key: (.key|sub("CLIENT_";"")|sub("_2$";"")),
       ap: (.parameters.DEVICE.name // ((.parameters.DEVICE_FROM.name // "") + " > " + (.parameters.DEVICE_TO.name // ""))),
       signal: (.parameters.SIGNAL_STRENGTH.name // null), duration: (.parameters.DURATION.name // null)}] | reverse')
  {
    echo "window.NETDATA = {"
    echo "  generated: \"$(TZ="$LAB_TZ" date -d "@$NOW" '+%Y-%m-%d %H:%M %Z')\","
    echo "  day: \"$DAY\", tz: \"$LAB_TZ\","
    echo "  client: $client,"
    echo "  wifi: $wifi,"
    echo "  wan: $wan,"
    echo "  dishEvents: $dish,"
    echo "  dishDays: $days,"
    echo "  wanMonitor: $monitor,"
    echo "  health: $health,"
    echo "  clientEvents: $events"
    echo "};"
  } > "$out/data.js"
  echo "wrote $out/data.js: $(jq -r 'length' <<<"$wifi") wifi bins, $(jq -r 'length' <<<"$dish") dish events, $(jq -r 'length' <<<"$monitor") monitor lines"
}

# site <client> <dir>: the page plus its data, ready for `kthx deploy <dir>`.
cmd_site() {
  local out="${2:?usage: site <client> <dir>}"
  mkdir -p "$out"
  cp "$HERE/site/index.html" "$out/index.html"
  cmd_data "$1" "$out"
  echo "deploy with: kthx deploy $out"
}

cmd_summary() { cmd_dish 7; echo; cmd_wan; }

cmd_help() {
  cat <<'EOF'
net-health.sh — was the internet bad at folly today? (read-only)

  summary            dish events per day, today's events, WAN monitor lines, WAN traffic
  dish [days]        the Starlink dish's status and event log
  wan                gateway WAN health, monitor lines and hourly traffic
  client <term>      a client's hourly signal, satisfaction, retries, traffic and events
  data <term> <dir>  write <dir>/data.js for the net.kthx.dev page
  site <term> <dir>  copy the page and write its data; then `kthx deploy <dir>`
  help               this text

Times are in LAB_TZ (America/Halifax). NET_DAY=yesterday or NET_DAY=2026-10-12
selects another day. Set UNIFI_HOST and UNIFI_SSH_HOST as unifi.sh needs them.
EOF
}

main() {
  local c="${1:-help}"; shift || true
  case "$c" in
    summary) cmd_summary ;;
    dish)    cmd_dish "$@" ;;
    wan)     cmd_wan ;;
    client)  cmd_client "$@" ;;
    data)    cmd_data "$@" ;;
    site)    cmd_site "$@" ;;
    help|-h|--help) cmd_help ;;
    *) echo "unknown command: $c" >&2; cmd_help; exit 1 ;;
  esac
}
main "$@"
