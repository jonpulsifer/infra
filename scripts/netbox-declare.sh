#!/usr/bin/env bash
# Declares a new Kubernetes node in NetBox as `planned`: the device with its role, platform and
# custom fields, the first interface of its device type with the MAC, the cable to the switch
# port, and the address as its primary IPv4. Then it renders the inventory export and prints its
# diff, which goes in a pull request. A second run with the same facts changes nothing; a serial
# or a MAC that differs from the stored device is refused. A device that has moved past `planned`
# keeps its status and its desired_action.
#
#   netbox-declare.sh <name> <serial> <mac> <switch port> <address>
#       [--class controlplane|worker-g5|worker-g2]  default worker-g5
#       [--bmc none|amt|redfish]                     default amt
#       [--disk /dev/...]                            default /dev/nvme0n1
#       [--type <device type slug>]                  default hp-elitedesk-800-g5-desktop-mini
#       [--ek-hash <64 hex>]
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
  sed -n '/^#   netbox-declare.sh/,/^#       \[--ek-hash/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}" >&2
  exit 64
}

die() {
  echo "$*" >&2
  exit 1
}

[[ $# -ge 5 ]] || usage
name="$1" serial="$2" mac="${3^^}" port="$4" addr="$5"
shift 5
class=worker-g5 bmc=amt disk=/dev/nvme0n1 type=hp-elitedesk-800-g5-desktop-mini ek_hash=""
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

validate_args() {
  local cidr
  cidr="$(jq -er '.data.K8S_NODE_CIDR' "$cluster")"
  [[ "$name" =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "name '$name' is not a valid hostname"
  [[ -n "${serial// /}" ]] || die "serial is empty"
  [[ "$mac" =~ ^([0-9A-F]{2}:){5}[0-9A-F]{2}$ ]] || die "MAC '$mac' is not aa:bb:cc:dd:ee:ff"
  [[ "$port" =~ ^[0-9]+$ ]] || die "switch port '$port' is not an integer"
  [[ "$addr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "address '$addr' is not an IPv4 address"
  [[ "$class" =~ ^(controlplane|worker-g5|worker-g2)$ ]] || die "class '$class' is not controlplane, worker-g5 or worker-g2"
  [[ "$bmc" =~ ^(none|amt|redfish)$ ]] || die "bmc '$bmc' is not none, amt or redfish"
  [[ "$disk" == /dev/* ]] || die "disk '$disk' is not under /dev/"
  [[ -z "$ek_hash" || "$ek_hash" =~ ^[0-9a-f]{64}$ ]] || die "ek hash is not 64 lowercase hex characters"
  jq -en --arg a "$addr" --arg c "$cidr" '
    def ip: split(".") | map(tonumber) | select(all(. <= 255)) | reduce .[] as $o (0; . * 256 + $o);
    ($c | split("/")) as [$net, $len]
    | pow(2; 32 - ($len | tonumber)) as $size
    | ((($a | ip) / $size) | floor) == ((($net | ip) / $size) | floor)' >/dev/null \
    || die "address $addr is outside K8S_NODE_CIDR $cidr"
  jq -e --arg a "$addr" '.data.NODE_ADDRESSES | fromjson | any(.[]; . == $a) | not' "$cluster" >/dev/null \
    || die "address $addr is already in NODE_ADDRESSES"
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
    [[ -z "$found" || " $found " == *" $mac "* ]] \
      || die "$name exists with MAC $found, not $mac; refusing to change it"
  fi
  found="$(nb GET "dcim/devices/?serial=$(uri "$serial")" | jq -r --arg n "$name" '[.results[] | select(.name != $n) | .name] | join(" ")')"
  [[ -z "$found" ]] || die "serial $serial belongs to $found"
  found="$(nb GET "dcim/mac-addresses/?mac_address=$(uri "$mac")" \
    | jq -r --arg n "$name" '[.results[] | select(.assigned_object.device.name != $n) | .assigned_object.device.name // "no device"] | join(" ")')"
  [[ -z "$found" ]] || die "MAC $mac belongs to $found"
  found="$(nb GET "ipam/ip-addresses/?address=$(uri "$addr")" \
    | jq -r --arg n "$name" '[.results[] | select(.assigned_object != null and .assigned_object.device.name != $n) | .assigned_object.device.name] | join(" ")')"
  [[ -z "$found" ]] || die "address $addr is on $found"
  switch_id="$(nb GET "dcim/devices/?site=folly&role=switch" | jq -er '.results[0].id')" || die "no switch in site folly"
  switch_port "$port" >/dev/null || die "the switch has no Port $port"
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

validate_args
NETBOX_CHANGES="$(mktemp)"
trap 'rm -f "$NETBOX_CHANGES"' EXIT
nb_init
check_free
declare_node
echo "$(wc -l <"$NETBOX_CHANGES") changes"

bash "$root/scripts/netbox-export.sh"
echo
git -C "$root" diff --stat -- "${inventory#"$root"/}"
echo "Commit clusters/folly/inventory/machines.yaml on a branch and open the export pull request."
