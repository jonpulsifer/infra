#!/usr/bin/env bash
# Declares a new Kubernetes node in NetBox as `planned`: the device with its role, platform and
# custom fields, the first interface of its device type with the MAC, the cable to the switch
# port, and the address as its primary IPv4. Then it renders the inventory export and prints its
# diff, which goes in a pull request. A second run with the same facts changes nothing; a serial
# or a MAC that differs from the stored device is refused. A device that has moved past `planned`
# keeps its status and its desired_action.
#
# With --stub it declares only what the owner expects of a machine that has not phoned home yet:
# a `planned` device with the name and the class, and maybe the serial and the switch port
# (expected_port), with no MAC. Its address is an IP address with the status reserved, the stub's
# name as its DNS name and no interface, since a stub has no MAC to put it on; fleet-controller
# assigns it and makes it the primary IPv4 when it binds the machine. The export skips stubs, so
# a stub needs no pull request.
#
#   netbox-declare.sh <name> <serial> <mac> <switch port> <address>
#       [--class controlplane|worker-g5|worker-g2]  default worker-g5
#       [--bmc none|amt|redfish]                     default amt
#       [--disk /dev/...]                            default /dev/nvme0n1
#       [--type <device type slug>]                  default hp-elitedesk-800-g5-desktop-mini
#       [--ek-hash <64 hex>]
#   netbox-declare.sh --stub <name> --class controlplane|worker-g5|worker-g2
#       [--serial <serial>] [--port <switch port>] [--address <address>]
#       [--type <device type slug>]                  default hp-elitedesk-800-g5-desktop-mini
#
# NetBox access is scripts/lib/netbox.sh's environment.
set -euo pipefail
shopt -s inherit_errexit

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/lib/netbox.sh
source "$root/scripts/lib/netbox.sh"

readonly cluster="${INVENTORY_TOPOLOGY:-$root/clusters/folly/config/cluster-topology.json}"
readonly inventory="$root/clusters/folly/inventory/machines.yaml"

usage() {
  sed -n '/^#   netbox-declare.sh/,/^#$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}" >&2
  exit 64
}

die() {
  echo "$*" >&2
  exit 1
}

stub=false
name="" serial="" mac="" port="" addr=""
class=worker-g5 bmc=amt disk=/dev/nvme0n1 type=hp-elitedesk-800-g5-desktop-mini ek_hash=""
if [[ "${1:-}" == --stub ]]; then
  [[ $# -ge 2 ]] || usage
  stub=true name="$2" class=""
  shift 2
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || usage
    case "$1" in
      --class) class="$2" ;;
      --serial) serial="$2" ;;
      --port) port="$2" ;;
      --address) addr="$2" ;;
      --type) type="$2" ;;
      *) usage ;;
    esac
    shift 2
  done
  [[ -n "$class" ]] || usage
else
  [[ $# -ge 5 ]] || usage
  name="$1" serial="$2" mac="${3^^}" port="$4" addr="$5"
  shift 5
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 ]] || usage
    case "$1" in
      --class) class="$2" ;;
      --bmc) bmc="$2" ;;
      --disk) disk="$2" ;;
      --type) type="$2" ;;
      --ek-hash) ek_hash="$2" ;;
      *) usage ;;
    esac
    shift 2
  done
fi

validate_address() {
  local cidr
  cidr="$(jq -er '.data.K8S_NODE_CIDR' "$cluster")"
  [[ "$addr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "address '$addr' is not an IPv4 address"
  jq -en --arg a "$addr" --arg c "$cidr" '
    def ip: split(".") | map(tonumber) | select(all(. <= 255)) | reduce .[] as $o (0; . * 256 + $o);
    ($c | split("/")) as [$net, $len]
    | pow(2; 32 - ($len | tonumber)) as $size
    | ((($a | ip) / $size) | floor) == ((($net | ip) / $size) | floor)' >/dev/null \
    || die "address $addr is outside K8S_NODE_CIDR $cidr"
  jq -e --arg a "$addr" '.data.NODE_ADDRESSES | fromjson | any(.[]; . == $a) | not' "$cluster" >/dev/null \
    || die "address $addr is already in NODE_ADDRESSES"
}

validate_args() {
  [[ "$name" =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "name '$name' is not a valid hostname"
  [[ "$name" != intake-* ]] || die "name '$name' starts with intake-, which marks a machine no stub named"
  [[ "$class" =~ ^(controlplane|worker-g5|worker-g2)$ ]] || die "class '$class' is not controlplane, worker-g5 or worker-g2"
  if [[ "$stub" == true ]]; then
    [[ -z "$serial" || -n "${serial// /}" ]] || die "serial is blank"
    [[ -z "$port" || "$port" =~ ^[0-9]+$ ]] || die "switch port '$port' is not an integer"
    [[ -z "$addr" ]] || validate_address
    return
  fi
  [[ -n "${serial// /}" ]] || die "serial is empty"
  [[ "$mac" =~ ^([0-9A-F]{2}:){5}[0-9A-F]{2}$ ]] || die "MAC '$mac' is not aa:bb:cc:dd:ee:ff"
  [[ "$port" =~ ^[0-9]+$ ]] || die "switch port '$port' is not an integer"
  [[ "$bmc" =~ ^(none|amt|redfish)$ ]] || die "bmc '$bmc' is not none, amt or redfish"
  [[ "$disk" == /dev/* ]] || die "disk '$disk' is not under /dev/"
  [[ -z "$ek_hash" || "$ek_hash" =~ ^[0-9a-f]{64}$ ]] || die "ek hash is not 64 lowercase hex characters"
  validate_address
}

# check_free: refuse the facts that belong to another device or differ from this device's.
check_free() {
  local current found
  current="$(nb GET "dcim/devices/?site=folly&name=$(uri "$name")" | jq -c '.results[0] // null')"
  if [[ "$current" != null ]]; then
    jq -e --arg s "$serial" '.serial == $s' <<<"$current" >/dev/null \
      || die "$name exists with serial '$(jq -r '.serial' <<<"$current")', not '$serial'; refusing to change it"
    found="$(nb GET "dcim/interfaces/?device_id=$(jq '.id' <<<"$current")&limit=100" \
      | jq -r '[.results[].primary_mac_address.mac_address // empty | ascii_upcase] | join(" ")')"
    if [[ "$stub" == true ]]; then
      [[ -z "$found" ]] || die "$name exists with MAC $found, which no stub has; refusing to change it"
      jq -e '.status.value == "planned"' <<<"$current" >/dev/null \
        || die "$name exists as $(jq -r '.status.value' <<<"$current"); a stub is planned; refusing to change it"
    else
      [[ -z "$found" || " $found " == *" $mac "* ]] \
        || die "$name exists with MAC $found, not $mac; refusing to change it"
    fi
  fi
  if [[ -n "$serial" ]]; then
    found="$(nb GET "dcim/devices/?serial=$(uri "$serial")" | jq -r --arg n "$name" '[.results[] | select(.name != $n) | .name] | join(" ")')"
    [[ -z "$found" ]] || die "serial $serial belongs to $found"
  fi
  if [[ -n "$mac" ]]; then
    found="$(nb GET "dcim/mac-addresses/?mac_address=$(uri "$mac")" \
      | jq -r --arg n "$name" '[.results[] | select(.assigned_object.device.name != $n) | .assigned_object.device.name // "no device"] | join(" ")')"
    [[ -z "$found" ]] || die "MAC $mac belongs to $found"
  fi
  if [[ -n "$addr" ]]; then
    found="$(nb GET "ipam/ip-addresses/?address=$(uri "$addr")" | jq -r --arg n "$name" '[.results[]
      | if .assigned_object != null then select(.assigned_object.device.name != $n) | .assigned_object.device.name
        else select((.dns_name // "") != "" and .dns_name != $n) | "the stub \(.dns_name)" end] | join(" ")')"
    [[ -z "$found" ]] || die "address $addr is on $found"
  fi
  if [[ -n "$port" ]]; then
    switch_id="$(nb GET "dcim/devices/?site=folly&role=switch" | jq -er '.results[0].id')" || die "no switch in site folly"
    switch_port "$port" >/dev/null || die "the switch has no Port $port"
  fi
}

declare_node() {
  local type_id template existing want id nic nic_name node_len
  type_id="$(nb GET "dcim/device-types/?slug=$(uri "$type")" | jq -er '.results[0].id')" || die "no device type '$type'"
  template="$(nb GET "dcim/interface-templates/?device_type_id=$type_id" | jq -ec '.results | sort_by(.id) | first // empty')" \
    || die "device type '$type' has no interface template"
  nic_name="$(jq -r '.name' <<<"$template")"
  node_len="$(jq -er '.data.K8S_NODE_CIDR | split("/")[1]' "$cluster")"

  existing="$(nb GET "dcim/devices/?site=folly&name=$(uri "$name")" | jq -c '.results[0] // null')"
  want="$(jq -cn --arg n "$name" --arg s "$serial" --arg t "$type" --arg c "$class" --arg b "$bmc" --arg d "$disk" --arg e "$ek_hash" --argjson cur "$existing" '{
      name: $n, role: {slug: "kubernetes-node"}, device_type: {slug: $t}, platform: {slug: "talos"}, serial: $s,
      custom_fields: ({talos_class: $c, bmc_type: $b, install_disk: $d, tpm_version: "2.0", amt: ($b == "amt"), secure_boot_expected: true}
        + (if $cur == null then {desired_action: "none"} else {} end)
        + (if $e == "" then {} else {ek_hash: $e} end))}
    + (if $cur == null then {status: "planned"} else {} end)')"
  id="$(device "$want")"
  nic="$(interface "$id" "$nic_name" "$mac" "$(jq -r '.type.value' <<<"$template")")"
  nb_cable "$nic" "$(switch_port "$port")" "$tags"
  address "$id" "$nic" "$addr/$node_len"
  echo "$name: device $id, $nic_name $mac, Port $port, $addr"
}

declare_stub() {
  local existing want id node_len
  nb GET "dcim/device-types/?slug=$(uri "$type")" | jq -e '.results[0].id' >/dev/null || die "no device type '$type'"
  existing="$(nb GET "dcim/devices/?site=folly&name=$(uri "$name")" | jq -c '.results[0] // null')"
  want="$(jq -cn --arg n "$name" --arg s "$serial" --arg t "$type" --arg c "$class" --arg p "$port" --argjson cur "$existing" '{
      name: $n, role: {slug: "kubernetes-node"}, device_type: {slug: $t}, platform: {slug: "talos"}, serial: $s,
      custom_fields: ({talos_class: $c, expected_port: (if $p == "" then null else ($p | tonumber) end)}
        + (if $cur == null then {desired_action: "none"} else {} end))}
    + (if $cur == null then {status: "planned"} else {} end)')"
  id="$(device "$want")"
  if [[ -n "$addr" ]]; then
    node_len="$(jq -er '.data.K8S_NODE_CIDR | split("/")[1]' "$cluster")"
    nb_ensure ipam/ip-addresses "address=$(uri "$addr/$node_len")" "$(with_tags "$(jq -cn --arg a "$addr/$node_len" --arg n "$name" '{
      address: $a, status: "reserved", dns_name: $n, description: "Reserved for the stub \($n); fleet-controller assigns it on binding"}')")" >/dev/null
  fi
  echo "$name: stub device $id, class $class, serial ${serial:-any}, port ${port:-any}, address ${addr:-next free}"
}

validate_args
NETBOX_CHANGES="$(mktemp)"
trap 'rm -f "$NETBOX_CHANGES"' EXIT
nb_init
check_free
if [[ "$stub" == true ]]; then
  declare_stub
  echo "$(wc -l <"$NETBOX_CHANGES") changes"
  echo "The export skips stubs; nothing to commit until fleet-controller binds a machine to $name."
  exit 0
fi
declare_node
echo "$(wc -l <"$NETBOX_CHANGES") changes"

bash "$root/scripts/netbox-export.sh"
echo
git -C "$root" diff --stat -- "${inventory#"$root"/}"
echo "Commit clusters/folly/inventory/machines.yaml on a branch and open the export pull request."
