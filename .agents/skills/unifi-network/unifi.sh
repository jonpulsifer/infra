#!/usr/bin/env bash
# unifi.sh — read-only discovery driver for the homelab UniFi controller.
#
# Authenticates as the `terraform` Super Admin user (creds pulled from the
# homelab 1Password vault via `op`), opens a UniFi-OS cookie session against
# the UDM Pro, and exposes read-only subcommands over the legacy Network API
# (/proxy/network/api/...). Cookie + CSRF token are cached under a temp file
# so repeated calls in a session reuse one login.
#
# Usage:  ./unifi.sh <command> [args]
# Run     ./unifi.sh help   for the command list.
#
# Env overrides:
#   UNIFI_HOST       controller base URL (default https://unifi.fml.pulsifer.ca)
#   OP_VAULT         1Password vault id  (default homelab)
#   OP_UNIFI_ITEM    1Password item id   (default unifi-terraform login)
#   UNIFI_API_KEY    if set, also enables the Integration API (`integ` cmd)
#   OP_SSH_ITEM      1Password item id for the UDM root SSH login
#   UNIFI_SSH_HOST   SSH target host (default unifi.fml.pulsifer.ca)
set -euo pipefail

HOST="${UNIFI_HOST:-https://unifi.fml.pulsifer.ca}"
OP_VAULT="${OP_VAULT:-ib23znjeikv74p37f6mbfk7uya}"
OP_UNIFI_ITEM="${OP_UNIFI_ITEM:-lb532zq5efzs3y3xlfbdk2kace}"
OP_SSH_ITEM="${OP_SSH_ITEM:-kdtm4q6suztovorkisukvctfme}"
SSH_HOST="${UNIFI_SSH_HOST:-unifi.fml.pulsifer.ca}"
SITE="${UNIFI_SITE:-default}"
JAR="${TMPDIR:-/tmp}/.unifi-cookies-$(id -u)"
CSRF_FILE="${TMPDIR:-/tmp}/.unifi-csrf-$(id -u)"

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
need curl; need jq

login() {
  # Reuse a cached session if the cookie jar is < 50 min old (token TTL is ~2h).
  if [[ -f "$JAR" && -f "$CSRF_FILE" ]]; then
    local age; age=$(( $(date +%s) - $(stat -c %Y "$JAR" 2>/dev/null || echo 0) ))
    [[ $age -lt 3000 ]] && return 0
  fi
  command -v op >/dev/null 2>&1 || die "op (1Password CLI) not found; needed to fetch UniFi creds"
  local user pass
  user=$(op item get "$OP_UNIFI_ITEM" --vault "$OP_VAULT" --fields username 2>/dev/null) \
    || die "could not read UniFi username from op (is OP_SERVICE_ACCOUNT_TOKEN set?)"
  pass=$(op item get "$OP_UNIFI_ITEM" --vault "$OP_VAULT" --fields password --reveal 2>/dev/null) \
    || die "could not read UniFi password from op"
  local csrf
  csrf=$(curl -sk -c "$JAR" -D - -o /dev/null -X POST "$HOST/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$pass\"}" \
    | awk 'tolower($1)=="x-csrf-token:"{print $2}' | tr -d '\r')
  [[ -n "$csrf" ]] || die "login failed (no CSRF token returned) — check host/creds"
  printf '%s' "$csrf" > "$CSRF_FILE"
  chmod 600 "$JAR" "$CSRF_FILE"
}

# GET an arbitrary legacy Network API path (path is appended to /proxy/network/api).
get() {
  login
  curl -sk -b "$JAR" -H "x-csrf-token: $(cat "$CSRF_FILE")" -H 'Accept: application/json' \
    "$HOST/proxy/network/api$1"
}
# GET a site-scoped path: $1 is appended after /s/<site>
sget() { get "/s/$SITE$1"; }

# Run a command on the UDM over SSH (root). Needs sshpass; auto-fetched via
# nix-shell if not on PATH. The controller requires keyboard-interactive auth.
udm_ssh() {
  command -v op >/dev/null 2>&1 || die "op not found; needed for SSH password"
  local pass; pass=$(op item get "$OP_SSH_ITEM" --vault "$OP_VAULT" --fields password --reveal 2>/dev/null) \
    || die "could not read UDM SSH password from op"
  local ssh_cmd="sshpass -e ssh -o PasswordAuthentication=yes -o ChallengeResponseAuthentication=yes \
    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 root@$SSH_HOST"
  if command -v sshpass >/dev/null 2>&1; then
    SSHPASS="$pass" bash -c "$ssh_cmd \"\$@\"" _ "$@"
  elif command -v nix-shell >/dev/null 2>&1; then
    SSHPASS="$pass" nix-shell -p sshpass --run "$ssh_cmd $(printf '%q ' "$@")" 2>/dev/null
  else
    die "need sshpass (or nix-shell to fetch it) for SSH"
  fi
}
cmd_ssh() { udm_ssh "${@:?usage: ssh <remote command>}"; }
cmd_bgp() { udm_ssh "vtysh -c 'show ip bgp summary'"; }

cmd_raw()      { get "${1:?usage: raw <api-path, e.g. /s/default/stat/health>}" | jq .; }
cmd_integ()    {
  [[ -n "${UNIFI_API_KEY:-}" ]] || die "UNIFI_API_KEY not set (see SKILL.md: Integration API)"
  curl -sk -H "X-API-KEY: $UNIFI_API_KEY" -H 'Accept: application/json' \
    "$HOST/proxy/network/integration/v1${1:-/sites}" | jq .
}

cmd_networks() {
  sget /rest/networkconf | jq -r '
    ["NAME","SUBNET","PURPOSE","VLAN","DHCP","DOMAIN"], (.data[] |
    [.name, (.ip_subnet // "-"), .purpose, (.vlan // "-"|tostring),
     (if .dhcpd_enabled then "on" else "off" end), (.domain_name // "-")]) | @tsv' | column -t -s$'\t'
}
cmd_devices() {
  sget /stat/device | jq -r '
    ["MODEL","NAME","IP","MAC","VERSION","UPTIME_h","CLIENTS"], (.data[] |
    [.model, (.name // "-"), (.ip // "-"), .mac, (.version // "-"),
     ((.uptime // 0)/3600|floor|tostring), ((.num_sta // 0)|tostring)]) | @tsv' | column -t -s$'\t'
}
cmd_clients() {
  { printf 'HOSTNAME\tIP\tMAC\tNETWORK\tWIFI/WIRED\tUPTIME_h\n'
    sget /stat/sta | jq -r '.data[] |
      [(.hostname // .name // "-"), (.ip // "-"), .mac, (.network // "-"),
       (if .is_wired then "wired" else (.essid // "wifi") end),
       ((.uptime // 0)/3600|floor|tostring)] | @tsv' | sort -t$'\t' -k4,4 -k2,2V
  } | column -t -s$'\t'
}
cmd_clients_known() {
  sget /rest/user | jq -r '
    ["NAME","MAC","FIXED_IP","NETWORK_ID","NOTE"], (.data[] |
    [(.name // .hostname // "-"), .mac, (.fixed_ip // "-"),
     (.network_id // "-"), (.note // "-")]) | @tsv' | column -t -s$'\t'
}
cmd_wlans() {
  sget /rest/wlanconf | jq -r '
    ["SSID","SECURITY","ENABLED","BANDS","NETWORK_ID"], (.data[] |
    [.name, .security, (.enabled|tostring), ((.wlan_bands // [])|join(",")),
     (.networkconf_id // "-")]) | @tsv' | column -t -s$'\t'
}
cmd_routes()      { sget /rest/routing | jq '.data'; }
cmd_firewall()    { sget /rest/firewallrule | jq '.data'; }
cmd_portforward() { sget /rest/portforward | jq '.data'; }
cmd_health() {
  sget /stat/health | jq -r '["SUBSYSTEM","STATUS","CLIENTS"], (.data[] |
    [.subsystem, .status, ((.num_user // .num_sta // 0)|tostring)]) | @tsv' | column -t -s$'\t'
}
cmd_sysinfo() {
  sget /stat/sysinfo | jq -r '.data[0] | "Controller : \(.version)\nDevice     : \(.ubnt_device_type // "-")\nHostname   : \(.hostname // "-")\nUptime(h)  : \((.uptime // 0)/3600|floor)"'
}

cmd_find() {
  local q="${1:?usage: find <name|mac|ip substring>}"
  echo "## active clients matching '$q'"
  sget /stat/sta | jq -r --arg q "$q" '.data[] |
    select((.hostname//"")+(.name//"")+(.ip//"")+(.mac//"")+(.essid//"") | ascii_downcase | contains($q|ascii_downcase)) |
    "\(.hostname // .name // "?")\t\(.ip // "-")\t\(.mac)\t\(if .is_wired then "wired" else (.essid // "wifi") end)"' \
    | column -t -s$'\t'
  echo "## known/configured clients matching '$q'"
  sget /rest/user | jq -r --arg q "$q" '.data[] |
    select((.name//"")+(.hostname//"")+(.mac//"")+(.fixed_ip//"")+(.note//"") | ascii_downcase | contains($q|ascii_downcase)) |
    "\(.name // .hostname // "?")\t\(.fixed_ip // "-")\t\(.mac)\t\(.note // "-")"' \
    | column -t -s$'\t'
}

cmd_summary() {
  echo "# UniFi homelab — $HOST (site: $SITE)"; echo
  echo "## controller";       cmd_sysinfo; echo
  echo "## health";           cmd_health;  echo
  echo "## networks (VLANs)"; cmd_networks; echo
  echo "## wlans";            cmd_wlans;    echo
  echo "## devices";          cmd_devices;  echo
  echo "## active clients: $(sget /stat/sta | jq '.data|length')"
}

cmd_help() {
  cat <<'EOF'
unifi.sh — read-only UniFi homelab discovery

  summary            one-shot overview: controller, health, networks, wlans, devices
  sysinfo            controller version / device / uptime
  health             per-subsystem status (wan/lan/wlan/www/vpn)
  networks           configured networks / VLANs / subnets / DHCP
  wlans              wireless SSIDs and security
  devices            adopted UniFi devices (APs, switches, gateways)
  clients            currently-connected clients (live association table)
  clients-known      clients configured in the controller (fixed IPs, aliases)
  routes             static routes (rest/routing)
  firewall           firewall rules (rest/firewallrule)
  portforward        port-forward rules (rest/portforward)
  find <term>        search clients (active + known) by name/ip/mac/ssid
  raw <api-path>     GET any legacy path, e.g.  raw /s/default/stat/health
  integ [path]       Integration API GET (needs UNIFI_API_KEY); default /sites
  bgp                FRR/BGP summary over SSH (Cilium k8s peers)
  ssh <cmd>          run a command on the UDM over SSH as root (e.g. mca-dump)
  help               this text

Auth is automatic: creds come from 1Password (op) and a cookie session is cached.
The bgp/ssh commands additionally SSH to the UDM (sshpass via nix-shell if needed).
EOF
}

main() {
  local c="${1:-help}"; shift || true
  case "$c" in
    summary)        cmd_summary "$@" ;;
    sysinfo)        cmd_sysinfo "$@" ;;
    health)         cmd_health "$@" ;;
    networks)       cmd_networks "$@" ;;
    wlans)          cmd_wlans "$@" ;;
    devices)        cmd_devices "$@" ;;
    clients)        cmd_clients "$@" ;;
    clients-known)  cmd_clients_known "$@" ;;
    routes)         cmd_routes "$@" ;;
    firewall)       cmd_firewall "$@" ;;
    portforward)    cmd_portforward "$@" ;;
    find)           cmd_find "$@" ;;
    raw)            cmd_raw "$@" ;;
    integ)          cmd_integ "$@" ;;
    bgp)            cmd_bgp "$@" ;;
    ssh)            cmd_ssh "$@" ;;
    help|-h|--help) cmd_help ;;
    *) echo "unknown command: $c" >&2; cmd_help; exit 1 ;;
  esac
}
main "$@"
