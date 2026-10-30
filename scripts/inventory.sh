#!/usr/bin/env bash
# Compares each folly node's NetBox device with what the node reports over the Talos API, or
# prints one node's observed entry.
#
#   inventory.sh check [--record] [--metrics <file>]
#                       every staged, active or failed node in NetBox; exits 1 on drift.
#                       --record writes a NetBox journal entry when a node's findings change and keeps the `drift` tag on
#                       the drifting devices; --metrics writes netbox_drift for node-exporter.
#   inventory.sh observe [--insecure] <address>
#                       one node's entry; --insecure for a node in maintenance mode
#
# NetBox access is scripts/lib/netbox.sh's environment.
set -euo pipefail
shopt -s inherit_errexit

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
# shellcheck source=scripts/lib/netbox.sh
source "$root/scripts/lib/netbox.sh"

usage() {
  echo "usage: $0 check [--record] [--metrics <file>] | observe [--insecure] <address>" >&2
  exit 64
}

# One node's reported facts as JSON in the inventory's field names. secure_boot is null in
# maintenance mode, which has no SecurityState.
observe() {
  local address="$1"
  shift
  local -a talos=(talosctl --context folly -n "$address" -e "$address" "$@")
  local system security link
  system="$("${talos[@]}" get systeminformation -o json | jq -s '.[0].spec')"
  security="$("${talos[@]}" get securitystate -o json 2>/dev/null | jq -s '.[0].spec // {}')" || security='{}'
  link="$("${talos[@]}" get links -o json \
    | jq -s '[.[].spec | select(.type == "ether" and .kind == "" and .busPath != null)] | first // {}')"
  jq -n --argjson s "$system" --argjson sec "$security" --argjson l "$link" '{
    model: $s.productName,
    sku: $s.skuNumber,
    serial: $s.serialnumber,
    bios: $s.biosVersion,
    mac: ($l.permanentAddr // $l.hardwareAddr),
    secure_boot: $sec.secureBoot
  }'
}

# record <node> <findings>: journal a change in the node's findings on its device and keep the
# `drift` tag on it while it has any. An empty finding clears the tag.
record() {
  local node="$1" findings="$2" device id tagged last comments tags kind drifting
  device="$(nb GET "dcim/devices/?site=folly&name=$(jq -rn --arg v "$node" '$v | @uri')" | jq -c '.results[0] // empty')"
  [[ -n "$device" ]] || return 0
  id="$(jq '.id' <<<"$device")"
  tagged="$(jq 'any(.tags[]; .slug == "drift")' <<<"$device")"
  last="$(nb GET "extras/journal-entries/?assigned_object_type=dcim.device&assigned_object_id=$id&ordering=-created&limit=1" \
    | jq -r '.results[0].comments // ""')"
  if [[ -n "$findings" ]]; then
    comments="$(printf 'Drift: the node reports facts that differ from NetBox.\n\n%s' "$(awk '{print "- " $0}' <<<"$findings")")"
    tags="$(jq -c '[.tags[] | {slug}] + [{slug: "drift"}] | unique_by(.slug)' <<<"$device")"
    kind=warning
    drifting=true
  else
    comments="Drift cleared: the node reports what NetBox records."
    tags="$(jq -c '[.tags[] | select(.slug != "drift") | {slug}]' <<<"$device")"
    kind=success
    drifting=false
    [[ "$tagged" == true ]] || return 0
  fi
  if [[ "$comments" != "$last" ]]; then
    nb POST extras/journal-entries/ "$(jq -cn --argjson id "$id" --arg kind "$kind" --arg c "$comments" \
      '{assigned_object_type: "dcim.device", assigned_object_id: $id, kind: $kind, comments: $c}')" >/dev/null
  fi
  if [[ "$tagged" != "$drifting" ]]; then
    nb PATCH "dcim/devices/$id/" "$(jq -cn --argjson t "$tags" '{tags: $t}')" >/dev/null
  fi
}

check() {
  local record=false metrics=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --record) record=true ;;
      --metrics)
        [[ $# -ge 2 ]] || usage
        metrics="$2"
        shift
        ;;
      *) usage ;;
    esac
    shift
  done

  local addresses machines drift=0 node address seen diffs
  local -a series=()
  nb_init
  machines="$(bash "$root/scripts/netbox-export.sh" --json)"
  addresses="$(jq -c 'with_entries(select(.value.status != "planned" and .value.address != null) | .value |= .address)' <<<"$machines")"
  for node in $(jq -r 'keys[]' <<<"$addresses"); do
    address="$(jq -r --arg n "$node" '.[$n]' <<<"$addresses")"
    if ! jq -e --arg n "$node" 'has($n)' <<<"$machines" >/dev/null; then
      echo "$node: no active or staged kubernetes-node device in NetBox"
      series+=("netbox_drift{device=\"$node\"} 1")
      drift=1
      continue
    fi
    if ! seen="$(observe "$address")"; then
      echo "$node: no answer from $address"
      series+=("netbox_drift_reachable{device=\"$node\"} 0")
      drift=1
      continue
    fi
    series+=("netbox_drift_reachable{device=\"$node\"} 1")
    diffs="$(jq -r --arg n "$node" --arg address "$address" --argjson seen "$seen" '
      .[$n] as $want
      | $seen + {address: $address} | to_entries[]
      | select(.value != $want[.key])
      | "\($n): \(.key) is \(.value | tojson), NetBox says \($want[.key] | tojson)"
    ' <<<"$machines")"
    if [[ -n "$diffs" ]]; then
      echo "$diffs"
      series+=("netbox_drift{device=\"$node\"} 1")
      drift=1
    else
      echo "$node: ok"
      series+=("netbox_drift{device=\"$node\"} 0")
    fi
    if [[ "$record" == true ]]; then
      record "$node" "$diffs"
    fi
  done

  if [[ -n "$metrics" ]]; then
    {
      echo "# HELP netbox_drift Whether the node reports hardware facts that differ from its NetBox device, or has none."
      echo "# TYPE netbox_drift gauge"
      printf '%s\n' "${series[@]}" | grep '^netbox_drift{' || true
      echo "# HELP netbox_drift_reachable Whether the drift check reached the node over the Talos API."
      echo "# TYPE netbox_drift_reachable gauge"
      printf '%s\n' "${series[@]}" | grep '^netbox_drift_reachable{' || true
    } >"$metrics"
  fi
  return "$drift"
}

case "${1:-}" in
  observe)
    shift
    insecure=()
    if [[ "${1:-}" == --insecure ]]; then
      insecure=(--insecure)
      shift
    fi
    [[ $# -eq 1 ]] || usage
    observe "$1" "${insecure[@]}" | yq -P 'with_entries(select(.value != null))'
    ;;
  check)
    shift
    check "$@"
    ;;
  *) usage ;;
esac
