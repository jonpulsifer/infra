#!/usr/bin/env bash
# Lists and approves first intakes on the anchors' talos-attest, through `tailscale serve` on each
# anchor's tailnet name, port 8445, which hands the server the caller's tailnet login. A first
# intake waits on the anchor that ran it, so approve reads each anchor's GET /machines for the
# serial's pending claim and approves the EK hashes it names there. A claim is unauthenticated, so
# approve shows it and asks before it approves. ATTEST_ADMIN_URL names one server.
set -euo pipefail

anchors=(spore capsule forge)

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
  bases=()
  for anchor in "${anchors[@]}"; do
    bases+=("https://$anchor.$suffix:8445")
  done
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
      claim="$(pending "$base" | jq -c --arg s "$serial" 'map(select(.serial == $s)) | first // empty')" || continue
      [[ -n "$claim" ]] || continue
      echo "# $base holds this first intake:" >&2
      jq . <<<"$claim" >&2
      read -r -p "Do these EK hashes match the machine's console? Approve them? [y/N] " answer </dev/tty
      [[ "$answer" == [yY] ]] || {
        echo "not approved" >&2
        exit 1
      }
      jq -c --arg s "$serial" '{serial: $s, ek_hashes: [.ek_hashes[]]}' <<<"$claim" \
        | curl -sS --fail-with-body --max-time 10 -X POST -H 'Content-Type: application/json' \
          --data-binary @- "$base/approve" | jq .
      exit 0
    done
    echo "no anchor holds a first intake for serial $serial" >&2
    exit 1
    ;;
  *) usage ;;
esac
