#!/usr/bin/env bash
# Approves, denies or lists Talos enrollments on the anchors' talos-enroll, through
# `tailscale serve` on each anchor's tailnet name, port 8443, which hands the server the caller's
# tailnet login. Only the anchor that holds the boot VIP knows a device code, so approve and deny
# try each anchor and move on while one answers 404; pending lists every anchor. ENROLL_ADMIN_URL
# names one server and skips the search.
set -euo pipefail

anchors=(spore capsule forge)

usage() {
  echo "usage: enroll.sh approve <code on the console> <node> | deny <uuid> | pending" >&2
  exit 64
}

if [[ -n "${ENROLL_ADMIN_URL:-}" ]]; then
  bases=("$ENROLL_ADMIN_URL")
else
  suffix="$(tailscale status --json | jq -r '.MagicDNSSuffix // empty')"
  [[ -n "$suffix" ]] || {
    echo "tailscale reports no MagicDNS suffix; set ENROLL_ADMIN_URL" >&2
    exit 1
  }
  bases=()
  for anchor in "${anchors[@]}"; do
    bases+=("https://$anchor.$suffix:8443")
  done
fi

# post <path> <curl args...>: tries each server in turn. A 2xx prints and succeeds. A 404 or a
# connection failure tries the next server. Any other status is the holder's answer, so it prints
# and fails.
post() {
  local path="$1" base body status last=""
  shift
  for base in "${bases[@]}"; do
    body="$(mktemp)"
    status="$(curl -sS --max-time 10 -o "$body" -w '%{http_code}' -X POST -H 'Accept: application/json' \
      "$@" "$base$path" 2>/dev/null || true)"
    if [[ "$status" == 2* ]]; then
      jq . <"$body"
      rm -f "$body"
      return 0
    fi
    if [[ -n "$status" && "$status" != 404 && "$status" != 000 ]]; then
      cat "$body" >&2
      rm -f "$body"
      return 1
    fi
    last="$status"
    rm -f "$body"
  done
  echo "no anchor knows that code or uuid (last status ${last:-none}); the boot VIP holder may have changed, so wait for the machine's next code" >&2
  return 1
}

case "${1:-}" in
  approve)
    [[ $# -eq 3 ]] || usage
    post /approve --data-urlencode "code=$2" --data-urlencode "node=$3"
    ;;
  deny)
    [[ $# -eq 2 ]] || usage
    post /deny --data-urlencode "uuid=$2"
    ;;
  pending)
    [[ $# -eq 1 ]] || usage
    for base in "${bases[@]}"; do
      echo "# $base" >&2
      curl -sS --fail-with-body --max-time 10 "$base/pending" | jq . || true
    done
    ;;
  *) usage ;;
esac
