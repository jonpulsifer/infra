#!/usr/bin/env bash
# Approves, denies or lists Talos enrollments through talos-enroll's tailnet
# Ingress, which hands the server the caller's tailnet login. ENROLL_ADMIN_URL
# overrides the address read from `tailscale status`.
set -euo pipefail

usage() {
  echo "usage: enroll.sh approve <code on the console> <node> | deny <uuid> | pending" >&2
  exit 64
}

base="${ENROLL_ADMIN_URL:-}"
if [[ -z "$base" ]]; then
  suffix="$(tailscale status --json | jq -r '.MagicDNSSuffix // empty')"
  [[ -n "$suffix" ]] || {
    echo "tailscale reports no MagicDNS suffix; set ENROLL_ADMIN_URL" >&2
    exit 1
  }
  base="https://talos-enroll.$suffix"
fi

case "${1:-}" in
  approve)
    [[ $# -eq 3 ]] || usage
    curl -sS --fail-with-body -X POST -H 'Accept: application/json' \
      --data-urlencode "code=$2" --data-urlencode "node=$3" "$base/approve" | jq .
    ;;
  deny)
    [[ $# -eq 2 ]] || usage
    curl -sS --fail-with-body -X POST -H 'Accept: application/json' \
      --data-urlencode "uuid=$2" "$base/deny" | jq .
    ;;
  pending)
    [[ $# -eq 1 ]] || usage
    curl -sS --fail-with-body "$base/pending" | jq .
    ;;
  *) usage ;;
esac
