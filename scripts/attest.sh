#!/usr/bin/env bash
# Lists the intakes that wait on fleetd, and prints the nodes-file lines that would approve a
# waiting claim, through `tailscale serve` on spore's tailnet name, port 8445. A claim is
# unauthenticated: whoever knows a serial can make one, so approve authorizes nothing. It prints
# the claim's EK hashes as the lines of the node's entry in the nodes file, for the owner to
# compare with evidence of the chassis before a pull request adds them. ATTEST_ADMIN_URL names
# another server.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly nodes_file="$root/clusters/folly/inventory/nodes.yaml"

usage() {
  echo "usage: attest.sh approve <serial> | pending" >&2
  exit 64
}

if [[ -n "${ATTEST_ADMIN_URL:-}" ]]; then
  bases=("$ATTEST_ADMIN_URL")
else
  suffix="$(tailscale status --json | jq -r '.MagicDNSSuffix // empty')"
  [[ -n "$suffix" ]] || {
    echo "tailscale reports no MagicDNS suffix; set ATTEST_ADMIN_URL" >&2
    exit 1
  }
  bases=("https://spore.$suffix:8445")
fi

pending() {
  curl -sS --fail-with-body --max-time 10 -H 'Accept: application/json' "$1/machines" | jq -c '.pending // []'
}

case "${1:-}" in
  pending)
    [[ $# -eq 1 ]] || usage
    for base in "${bases[@]}"; do
      echo "# $base" >&2
      pending "$base" | jq . || true
    done
    ;;
  approve)
    [[ $# -eq 2 ]] || usage
    serial="$2"
    for base in "${bases[@]}"; do
      claims="$(pending "$base")" || {
        echo "# $base did not answer" >&2
        failed=1
        continue
      }
      claim="$(jq -c --arg s "$serial" 'map(select((.serial | ascii_upcase) == ($s | ascii_upcase))) | first // empty' <<<"$claims")"
      [[ -n "$claim" ]] || continue
      echo "# $base holds this unauthenticated claim:" >&2
      jq . <<<"$claim" >&2
      node="$(S="$serial" yq -r '.nodes | to_entries[] | select((.value.serial | upcase) == (strenv(S) | upcase)) | .key' "$nodes_file")"
      if [[ -n "$node" ]]; then
        echo "# Under nodes.$node in ${nodes_file#"$root"/}, once evidence of the chassis names these EKs:" >&2
      else
        echo "# No node in ${nodes_file#"$root"/} has serial $serial; its new entry takes, once evidence of the chassis names these EKs:" >&2
      fi
      jq -r '.ek_hashes | [(.rsa // empty | "    approved_ek_rsa2048: \(.)"), (.ecc // empty | "    approved_ek_eccp256: \(.)")] | .[]' <<<"$claim"
      exit 0
    done
    if [[ -n "${failed:-}" ]]; then
      echo "no fleetd answered, so no claim for serial $serial was read" >&2
    else
      echo "fleetd holds no waiting claim for serial $serial" >&2
    fi
    exit 1
    ;;
  *) usage ;;
esac
