#!/usr/bin/env bash
# Compares clusters/folly/inventory/machines.yaml with what each node reports
# over the Talos API, or prints one node's observed entry.
#
#   inventory.sh check              every node in NODE_ADDRESSES; exits 1 on drift
#   inventory.sh observe <address>  one node's entry, to paste into the inventory
#   inventory.sh observe --insecure <address>   a node in maintenance mode
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly root
readonly inventory="$root/clusters/folly/inventory/machines.yaml"

usage() {
  echo "usage: $0 check | observe [--insecure] <address>" >&2
  exit 64
}

# One node's reported facts as JSON in the inventory's field names. secure_boot
# is null in maintenance mode, which has no SecurityState.
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
    addresses="$(jq -er '.data.NODE_ADDRESSES | fromjson' "$root/clusters/folly/config/cluster-topology.json")"
    machines="$(yq -o json '.machines' "$inventory")"
    drift=0
    for node in $(jq -r 'keys[]' <<<"$addresses"); do
      address="$(jq -r --arg n "$node" '.[$n]' <<<"$addresses")"
      if ! jq -e --arg n "$node" 'has($n)' <<<"$machines" >/dev/null; then
        echo "$node: not in ${inventory#"$root"/}"
        drift=1
        continue
      fi
      if ! seen="$(observe "$address")"; then
        echo "$node: no answer from $address"
        drift=1
        continue
      fi
      diffs="$(jq -r --arg n "$node" --argjson seen "$seen" '
        .[$n] as $want
        | $seen | to_entries[]
        | select(.value != $want[.key])
        | "\($n): \(.key) is \(.value | tojson), the inventory says \($want[.key] | tojson)"
      ' <<<"$machines")"
      if [[ -n "$diffs" ]]; then
        echo "$diffs"
        drift=1
      else
        echo "$node: ok"
      fi
    done
    exit "$drift"
    ;;
  *) usage ;;
esac
